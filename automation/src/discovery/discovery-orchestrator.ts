import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { CapabilityActionType, DataShapeType } from '../domain/index.js';
import {
  DiscoveryProposal,
  DiscoveryResult,
  DiscoveryTraceEvent,
  DiscoveryObservation,
  type DiscoveryObservationType,
  type DiscoveryProposalType,
  type DiscoveryResultType,
  type DiscoveryTraceEventType,
} from '../domain/discovery.js';
import type { ExecutionContext } from '../execution/execution-context.js';
import {
  AutomationActionGuard,
  createInterventionId,
  type InterventionCoordinator,
  type LeaseBoundInterventionCoordinator,
  type ReplayInterventionDecision,
  type ValidationReportingCoordinator,
} from '../intervention/intervention-coordinator.js';
import { ControlLeaseManager } from '../intervention/control-lease.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import type { LoadedPolicy } from '../policy/policy-loader.js';
import { matchesShape } from '../replay/runtime-bindings.js';
import type { SurfaceAdapter } from '../surfaces/surface-types.js';
import { sanitizeObservation } from '../surfaces/web/observation-collector.js';
import type { LoadedDiscoveryGoal } from './goal-loader.js';
import { PlannerFailure, type PlannerClient, type PlannerResponse } from './planner-client.js';
import { contentHash } from '../compiler/canonical-json.js';

export interface DiscoveryOptions {
  readonly loadedGoal: LoadedDiscoveryGoal;
  readonly loadedPolicy: LoadedPolicy;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly adapter: SurfaceAdapter;
  readonly planner: PlannerClient;
  readonly evidenceDirectory: string;
  readonly headless: boolean;
  readonly logger?: Logger;
  readonly cancellationSignal?: AbortSignal;
  readonly interventionCoordinator?: InterventionCoordinator;
  readonly now?: () => number;
}

function targetFor(observation: DiscoveryObservationType, reference: string) {
  const element = observation.elements.find((candidate) => candidate.reference === reference);
  if (!element) throw new DiscoveryStop('STALE_OBSERVATION', 'Element is not in this observation');
  if (element.frameId !== 'main' && !element.frameLocatorCandidates)
    throw new DiscoveryStop('POLICY_DENIED', 'Frame action lacks an approved frame locator');
  return {
    description:
      [element.role, element.name, element.text].filter(Boolean).join(' ').slice(0, 256) ||
      'observed element',
    candidates: element.locatorCandidates,
    ...(element.frameLocatorCandidates ? { framePath: element.frameLocatorCandidates } : {}),
    match: 'exactlyOne' as const,
  };
}

function actionFor(
  proposal: DiscoveryProposalType,
  observation: DiscoveryObservationType,
): CapabilityActionType | undefined {
  switch (proposal.kind) {
    case 'click':
      return { kind: 'activate', target: targetFor(observation, proposal.elementReference) };
    case 'enterInput':
      return {
        kind: 'enterText',
        target: targetFor(observation, proposal.elementReference),
        value: { kind: 'input', name: proposal.inputName },
        clear: true,
      };
    case 'enterSecret':
      return {
        kind: 'enterText',
        target: targetFor(observation, proposal.elementReference),
        value: { kind: 'secret', name: proposal.secretName },
        clear: true,
      };
    case 'navigate':
      return { kind: 'navigate', destination: { kind: 'absoluteUrl', url: proposal.url } };
    case 'pressKey':
      return {
        kind: 'pressKey',
        ...(proposal.elementReference
          ? { target: targetFor(observation, proposal.elementReference) }
          : {}),
        key: proposal.key,
      };
    case 'scroll':
      return { kind: 'scroll', direction: proposal.direction, amount: proposal.amount };
    case 'extract':
      return {
        kind: 'extract',
        output: proposal.outputName,
        target: targetFor(observation, proposal.elementReference),
        transform:
          proposal.transform === 'amountUsd'
            ? { kind: 'amountWithCurrency', currency: 'USD' }
            : { kind: proposal.transform },
      };
    default:
      return undefined;
  }
}

class DiscoveryStop extends Error {
  constructor(
    readonly code: Extract<DiscoveryResultType, { status: 'stopped' }>['code'],
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryStop';
  }
}

export class DiscoveryOrchestrator {
  async run(options: DiscoveryOptions): Promise<DiscoveryResultType> {
    const now = options.now ?? Date.now;
    const started = now();
    const runId = `discovery-${randomUUID()}`;
    const interventionId = createInterventionId();
    const { goal } = options.loadedGoal;
    const trace: DiscoveryTraceEventType[] = [];
    const outputs: Record<string, unknown> = {};
    let modelCalls = 0;
    let actions = 0;
    let navigations = 0;
    let failures = 0;
    let sequence = 0;
    let step = 0;
    let surfaceStarted = false;
    let previousResult: Record<string, unknown> | undefined;
    let currentObservation: DiscoveryObservationType | undefined;
    const stateCounts = new Map<string, number>();
    const fingerprintHistory: string[] = [];
    const pairHistory: string[] = [];
    let humanApprovedActionSignature: string | undefined;
    const lease = new ControlLeaseManager(runId, interventionId, 'Bounded discovery');
    const guard = new AutomationActionGuard(lease, options.cancellationSignal);
    const policy = new PolicyEngine(options.loadedPolicy.policy, options.loadedPolicy.contentHash);
    const coordinator = options.interventionCoordinator;
    if (coordinator && 'bindLease' in coordinator)
      (coordinator as LeaseBoundInterventionCoordinator).bindLease(lease);

    const remaining = () => ({
      modelCalls: Math.max(0, goal.budgets.maxModelCalls - modelCalls),
      actions: Math.max(0, goal.budgets.maxActions - actions),
      timeMs: Math.max(0, goal.budgets.timeoutMs - (now() - started)),
    });
    const record = (
      eventType: DiscoveryTraceEventType['eventType'],
      data: Record<string, unknown>,
      proposal?: DiscoveryProposalType,
      observation = currentObservation,
    ) => {
      trace.push(
        DiscoveryTraceEvent.parse({
          schemaVersion: '1.0.0',
          eventId: `event-${++sequence}`,
          runId,
          goalId: goal.id,
          goalVersion: goal.version,
          policyId: options.loadedPolicy.policy.id,
          policyVersion: options.loadedPolicy.policy.version,
          policyHash: options.loadedPolicy.contentHash,
          sequence,
          timestamp: new Date(now()).toISOString(),
          step,
          eventType,
          ...(observation ? { stateFingerprint: observation.stateFingerprint } : {}),
          ...(proposal ? { proposalId: proposal.proposalId } : {}),
          budgetsRemaining: remaining(),
          data,
        }),
      );
    };

    try {
      this.validateBindings(options);
      this.assertScope(
        goal.startUrl,
        goal.applicationScope.allowedOrigins,
        goal.applicationScope.allowedRoutePatterns,
      );
      await options.adapter.start({
        baseUrl: new URL(goal.startUrl).origin,
        runId,
        evidenceDirectory: options.evidenceDirectory,
        headless: options.headless,
        timeoutMs: Math.min(15_000, goal.budgets.timeoutMs),
      });
      surfaceStarted = true;
      record('run_started', {
        goalHash: options.loadedGoal.contentHash,
        providerBoundary: 'one-action',
      });
      guard.assertCanAct();
      const navigation: CapabilityActionType = {
        kind: 'navigate',
        destination: { kind: 'absoluteUrl', url: goal.startUrl },
      };
      const initialPolicy = policy.decide(navigation, { id: 'discovery-start' }, runId, 1, 0, 0);
      record('policy_decision', {
        decision: initialPolicy.decision,
        ruleId: initialPolicy.ruleId ?? null,
        actionType: 'navigate',
        risk: initialPolicy.risk,
      });
      if (initialPolicy.decision !== 'allow')
        throw new DiscoveryStop('POLICY_DENIED', initialPolicy.reason);
      const context = this.context(options, runId, outputs, 'discovery-start');
      record('action_executed', {
        actionJson: JSON.stringify(navigation),
        system: 'goal-start',
      });
      const initial = await options.adapter.execute(navigation, context);
      actions += 1;
      navigations += 1;
      record('action_result', {
        ok: initial.ok,
        action: initial.action,
        errorCode: initial.error?.code ?? null,
        locatorStrategy: null,
        locatorCandidateIndex: null,
        resolvedFramePath: null,
        system: 'goal-start',
      });
      if (!initial.ok) throw new DiscoveryStop('CONSECUTIVE_FAILURES', 'Initial navigation failed');

      while (true) {
        this.assertLimits(options, started, now(), modelCalls, actions, failures);
        guard.assertCanAct();
        currentObservation = sanitizeObservation(
          await options.adapter.observe(),
          Object.values(options.secrets),
        );
        if (
          goal.screenshotPolicy === 'sanitized' &&
          options.loadedPolicy.policy.screenshotRules.enabled
        ) {
          const screenshot = await options.adapter
            .captureScreenshot({ name: `discovery-${step}-observation`, fullPage: false })
            .catch(() => undefined);
          if (screenshot)
            currentObservation = DiscoveryObservation.parse({
              ...currentObservation,
              screenshot,
              evidence: [...currentObservation.evidence, screenshot],
            });
        }
        this.assertScope(
          currentObservation.url,
          goal.applicationScope.allowedOrigins,
          goal.applicationScope.allowedRoutePatterns,
        );
        if (JSON.stringify(currentObservation).length > 131_072)
          throw new DiscoveryStop('PROVIDER_FAILURE', 'Sanitized observation exceeded size limit');
        record('observation', {
          observationJson: JSON.stringify(currentObservation),
        });
        const count = (stateCounts.get(currentObservation.stateFingerprint) ?? 0) + 1;
        stateCounts.set(currentObservation.stateFingerprint, count);
        fingerprintHistory.push(currentObservation.stateFingerprint);
        if (count > goal.budgets.maxRepeatedStates)
          throw new DiscoveryStop('REPEATED_STATE', 'Repeated state limit reached');
        if (
          fingerprintHistory.length >= 4 &&
          fingerprintHistory.at(-1) === fingerprintHistory.at(-3) &&
          fingerprintHistory.at(-2) === fingerprintHistory.at(-4) &&
          fingerprintHistory.at(-1) !== fingerprintHistory.at(-2)
        )
          throw new DiscoveryStop('REPEATED_STATE', 'Alternating state loop detected');
        if (modelCalls >= goal.budgets.maxModelCalls)
          throw new DiscoveryStop('MODEL_CALL_BUDGET_EXHAUSTED', 'Model-call budget exhausted');
        modelCalls += 1;
        record('planner_request', {
          call: modelCalls,
          observationId: currentObservation.observationId,
        });
        let plannerResponse: PlannerResponse;
        try {
          plannerResponse = await options.planner.propose(
            {
              goal,
              observation: currentObservation,
              ...(previousResult ? { previousResult } : {}),
              remaining: remaining(),
              traceSummary: trace
                .slice(-8)
                .map((event) => `${event.eventType}:${event.proposalId ?? '-'}`),
            },
            options.cancellationSignal,
          );
        } catch (error: unknown) {
          failures += 1;
          previousResult = {
            ok: false,
            code: error instanceof PlannerFailure ? error.code : 'PROVIDER_ERROR',
          };
          if (!(error instanceof PlannerFailure) || !error.retryable)
            throw new DiscoveryStop(
              'PROVIDER_FAILURE',
              `Planner failed safely: ${error instanceof PlannerFailure ? error.code : 'PROVIDER_ERROR'}`,
            );
          continue;
        }
        const parsed = DiscoveryProposal.safeParse(plannerResponse.proposal);
        if (!parsed.success)
          throw new DiscoveryStop('PROVIDER_FAILURE', 'Planner proposal failed local validation');
        const proposal = parsed.data;
        record(
          'planner_proposal',
          {
            proposalJson: JSON.stringify(proposal),
            provider: plannerResponse.provider,
            model: plannerResponse.model,
            requestId: plannerResponse.requestId ?? null,
            usage: plannerResponse.usage ?? null,
          },
          proposal,
        );
        if (
          proposal.observationId !== currentObservation.observationId ||
          proposal.stateFingerprint !== currentObservation.stateFingerprint
        ) {
          record('proposal_validated', { valid: false, code: 'STALE_OBSERVATION' }, proposal);
          throw new DiscoveryStop('STALE_OBSERVATION', 'Proposal references a stale observation');
        }
        record('proposal_validated', { valid: true, kind: proposal.kind }, proposal);
        const pair = `${currentObservation.stateFingerprint}:${proposal.kind}:${'elementReference' in proposal ? proposal.elementReference : ''}`;
        pairHistory.push(pair);
        if (pairHistory.filter((item) => item === pair).length > goal.budgets.maxRepeatedStates)
          throw new DiscoveryStop('REPEATED_STATE', 'Repeated state/action limit reached');
        step += 1;

        if (proposal.kind === 'finish') {
          record(
            'policy_decision',
            { decision: 'allow', ruleId: 'declared-success-validation' },
            proposal,
          );
          guard.assertCanAct();
          for (const checkpoint of goal.successCriteria) {
            const evaluation = await options.adapter.evaluateCheckpoint(
              checkpoint,
              this.context(options, runId, outputs, 'discovery-finish'),
            );
            record(
              'checkpoint_candidate',
              {
                checkpointJson: JSON.stringify(checkpoint),
                passed: evaluation.passed,
                kind: evaluation.kind,
                final: true,
              },
              proposal,
            );
            if (!evaluation.passed)
              throw new DiscoveryStop(
                'CONSECUTIVE_FAILURES',
                'Declared success criteria did not pass',
              );
          }
          for (const [name, spec] of Object.entries(goal.outputs))
            if (!matchesShape(outputs[name], spec.shape as DataShapeType))
              throw new DiscoveryStop(
                'CONSECUTIVE_FAILURES',
                `Output ${name} is missing or invalid`,
              );
          const result = DiscoveryResult.parse({
            status: 'success',
            runId,
            outputs,
            modelCalls,
            actions,
          });
          record(
            'run_completed',
            {
              status: 'success',
              outputNames: Object.keys(outputs),
              traceHash: contentHash(trace),
            },
            proposal,
          );
          await options.adapter.writeResult(result);
          return result;
        }
        if (proposal.kind === 'reportBusinessOutcome') {
          const outcome = goal.businessOutcomes.find((item) => item.code === proposal.outcomeCode);
          record(
            'policy_decision',
            { decision: outcome ? 'allow' : 'deny', ruleId: 'declared-business-outcome' },
            proposal,
          );
          if (!outcome)
            throw new DiscoveryStop('POLICY_DENIED', 'Business outcome is not declared');
          guard.assertCanAct();
          const evaluation = await options.adapter.evaluateCheckpoint(
            outcome.detection,
            this.context(options, runId, outputs, 'discovery-outcome'),
          );
          if (!evaluation.passed)
            throw new DiscoveryStop('CONSECUTIVE_FAILURES', 'Business outcome was not observed');
          const result = DiscoveryResult.parse({
            status: 'businessOutcome',
            runId,
            outcome: outcome.code,
            modelCalls,
            actions,
          });
          record(
            'business_outcome',
            { code: outcome.code, checkpointJson: JSON.stringify(outcome.detection) },
            proposal,
          );
          record(
            'run_completed',
            { status: 'businessOutcome', code: outcome.code, traceHash: contentHash(trace) },
            proposal,
          );
          await options.adapter.writeResult(result);
          return result;
        }
        if (proposal.kind === 'stopSafely') {
          record('policy_decision', { decision: 'allow', ruleId: 'safe-stop' }, proposal);
          throw new DiscoveryStop('STOPPED_SAFELY', proposal.reason);
        }
        if (proposal.kind === 'requestHuman') {
          record(
            'policy_decision',
            {
              decision: goal.allowHumanIntervention ? 'requireIntervention' : 'deny',
              ruleId: 'goal-human-intervention',
            },
            proposal,
          );
          if (!goal.allowHumanIntervention || !coordinator)
            throw new DiscoveryStop('INTERVENTION_REQUIRED', 'Human intervention is unavailable');
          await options.adapter.captureSessionContinuityBaseline?.();
          const pausedGeneration = guard.requestPause();
          record('intervention', { phase: 'paused', reason: proposal.reason }, proposal);
          await options.adapter.bringToFront?.();
          const decision = await coordinator.awaitDecision({
            interventionId,
            runId,
            artifactId: goal.id,
            artifactVersion: goal.version,
            stepId: `discovery-${step}`,
            policyId: options.loadedPolicy.policy.id,
            policyVersion: options.loadedPolicy.policy.version,
            reason: proposal.reason,
            risk: 'read',
            boundary: {
              pendingStepId: `discovery-${step}`,
              pendingActionType: 'discovery',
              currentUrl: currentObservation.url,
              retryable: true,
              consequential: false,
              checkpointDescription: proposal.expectedPostcondition,
              leaseGeneration: pausedGeneration,
            },
            resumeCheckpointDescription: proposal.expectedPostcondition,
            createdAt: new Date(now()).toISOString(),
            expiresAt: new Date(now() + remaining().timeMs).toISOString(),
          });
          const terminal = this.interventionStop(decision);
          if (terminal) throw terminal;
          guard.resume(decision.leaseGeneration);
          (coordinator as Partial<ValidationReportingCoordinator>).validationFinished?.();
          const continuity = await options.adapter.verifySessionContinuity?.();
          record('intervention', { phase: 'resumed', ...(continuity ?? {}) }, proposal);
          previousResult = { ok: true, intervention: 'resumed', observationInvalidated: true };
          continue;
        }
        if (proposal.kind === 'assertCheckpoint') {
          record('policy_decision', { decision: 'allow', ruleId: 'checkpoint-read' }, proposal);
          guard.assertCanAct();
          const evaluation = await options.adapter.evaluateCheckpoint(
            proposal.checkpoint,
            this.context(options, runId, outputs, `discovery-${step}`),
          );
          record(
            'checkpoint_candidate',
            {
              checkpointJson: JSON.stringify(proposal.checkpoint),
              passed: evaluation.passed,
              kind: evaluation.kind,
            },
            proposal,
          );
          previousResult = { ok: evaluation.passed, kind: 'checkpoint' };
          failures = evaluation.passed ? 0 : failures + 1;
          continue;
        }

        const action = actionFor(proposal, currentObservation);
        if (!action) throw new DiscoveryStop('POLICY_DENIED', 'Proposal action is unsupported');
        this.validateReferences(proposal, options, goal.outputs);
        const decision = policy.decide(
          action,
          { id: `discovery-${proposal.kind}` },
          runId,
          1,
          navigations,
          0,
        );
        record(
          'policy_decision',
          {
            decision: decision.decision,
            ruleId: decision.ruleId ?? null,
            actionType: decision.actionType,
            reason: decision.reason,
            risk: decision.risk,
            secretReference: proposal.kind === 'enterSecret' ? proposal.secretName : null,
          },
          proposal,
        );
        if (decision.decision === 'deny') throw new DiscoveryStop('POLICY_DENIED', decision.reason);
        if (decision.decision === 'requireIntervention') {
          const signature = JSON.stringify(action);
          if (humanApprovedActionSignature === signature) {
            humanApprovedActionSignature = undefined;
            record(
              'policy_decision',
              {
                decision: 'allow',
                ruleId: 'human-approved-policy-intervention',
                actionType: decision.actionType,
              },
              proposal,
            );
          } else {
            if (!goal.allowHumanIntervention || !coordinator)
              throw new DiscoveryStop('INTERVENTION_REQUIRED', decision.reason);
            await options.adapter.captureSessionContinuityBaseline?.();
            const pausedGeneration = guard.requestPause();
            record('intervention', { phase: 'paused', reason: decision.reason }, proposal);
            await options.adapter.bringToFront?.();
            const humanDecision = await coordinator.awaitDecision({
              interventionId,
              runId,
              artifactId: goal.id,
              artifactVersion: goal.version,
              stepId: `discovery-${proposal.kind}`,
              policyId: options.loadedPolicy.policy.id,
              policyVersion: options.loadedPolicy.policy.version,
              reason: decision.reason,
              risk: decision.risk,
              boundary: {
                pendingStepId: `discovery-${proposal.kind}`,
                pendingActionType: action.kind,
                currentUrl: currentObservation.url,
                retryable: true,
                consequential: false,
                checkpointDescription: proposal.expectedPostcondition,
                leaseGeneration: pausedGeneration,
              },
              resumeCheckpointDescription: proposal.expectedPostcondition,
              createdAt: new Date(now()).toISOString(),
              expiresAt: new Date(now() + remaining().timeMs).toISOString(),
            });
            const terminal = this.interventionStop(humanDecision);
            if (terminal) throw terminal;
            guard.resume(humanDecision.leaseGeneration);
            (coordinator as Partial<ValidationReportingCoordinator>).validationFinished?.();
            humanApprovedActionSignature = signature;
            record('intervention', { phase: 'resumed', approval: 'one-action' }, proposal);
            previousResult = { ok: true, intervention: 'resumed', observationInvalidated: true };
            continue;
          }
        }
        if (actions >= goal.budgets.maxActions)
          throw new DiscoveryStop('ACTION_BUDGET_EXHAUSTED', 'Action budget exhausted');
        if (action.kind === 'navigate' && navigations >= goal.budgets.maxNavigations)
          throw new DiscoveryStop('POLICY_DENIED', 'Discovery navigation limit reached');
        guard.assertCanAct();
        record(
          'action_executed',
          {
            actionJson: JSON.stringify(action),
          },
          proposal,
        );
        const result = await options.adapter.execute(
          action,
          this.context(options, runId, outputs, `discovery-${step}`),
        );
        actions += 1;
        if (action.kind === 'navigate') navigations += 1;
        record(
          'action_result',
          {
            ok: result.ok,
            action: result.action,
            errorCode: result.error?.code ?? null,
            outputName: result.output?.name ?? null,
            locatorStrategy: result.target?.strategy ?? null,
            locatorCandidateIndex: result.target?.candidateIndex ?? null,
            resolvedFramePath: result.target?.framePath ?? null,
            durationMs: Math.max(
              0,
              new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime(),
            ),
          },
          proposal,
        );
        if (result.output)
          record('output_candidate', { outputName: result.output.name, valid: true }, proposal);
        previousResult = { ok: result.ok, action: result.action, errorCode: result.error?.code };
        failures = result.ok ? 0 : failures + 1;
      }
    } catch (error: unknown) {
      if (!(error instanceof DiscoveryStop))
        options.logger?.error(
          {
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorMessage: error instanceof Error ? error.message : 'Non-error thrown',
          },
          'Discovery stopped after an internal failure',
        );
      const stopped =
        error instanceof DiscoveryStop
          ? error
          : options.cancellationSignal?.aborted
            ? new DiscoveryStop('CANCELLED', 'Discovery was cancelled')
            : new DiscoveryStop('PROVIDER_FAILURE', 'Discovery stopped after an internal failure');
      const result = DiscoveryResult.parse({
        status: 'stopped',
        runId,
        code: stopped.code,
        reason: stopped.message,
        modelCalls,
        actions,
      });
      record('stopping_condition', {
        code: stopped.code,
        reason: stopped.message,
        traceHash: contentHash(trace),
      });
      if (surfaceStarted) await options.adapter.writeResult(result).catch(() => undefined);
      return result;
    } finally {
      if (surfaceStarted) {
        await options.adapter.writeDiscoveryTrace?.(trace).catch(() => undefined);
        await options.adapter.close();
      }
      if (coordinator && 'close' in coordinator)
        await (coordinator as LeaseBoundInterventionCoordinator).close().catch(() => undefined);
    }
  }

  private context(
    options: DiscoveryOptions,
    runId: string,
    outputs: Record<string, unknown>,
    stepId: string,
  ): ExecutionContext {
    return {
      inputs: options.inputs,
      secrets: options.secrets,
      outputs,
      baseUrl: new URL(options.loadedGoal.goal.startUrl).origin,
      outputShapes: Object.fromEntries(
        Object.entries(options.loadedGoal.goal.outputs).map(([name, spec]) => [
          name,
          spec.shape as DataShapeType,
        ]),
      ) as Record<string, DataShapeType>,
      runId,
      stepId,
      ...(options.logger ? { logger: options.logger } : {}),
    };
  }

  private validateBindings(options: DiscoveryOptions): void {
    const { goal } = options.loadedGoal;
    for (const name of Object.keys(options.inputs))
      if (!(name in goal.inputs))
        throw new DiscoveryStop('POLICY_DENIED', `Input ${name} is undeclared`);
    for (const [name, spec] of Object.entries(goal.inputs))
      if (!matchesShape(options.inputs[name], spec.shape as DataShapeType))
        throw new DiscoveryStop('POLICY_DENIED', `Input ${name} is missing or invalid`);
    for (const name of Object.keys(options.secrets))
      if (!goal.secretReferences.includes(name))
        throw new DiscoveryStop('POLICY_DENIED', `Secret ${name} is undeclared`);
    for (const name of goal.secretReferences)
      if (!options.secrets[name])
        throw new DiscoveryStop('POLICY_DENIED', `Secret ${name} is missing`);
    if (goal.policyRef !== options.loadedPolicy.policy.id)
      throw new DiscoveryStop('POLICY_DENIED', 'Goal policy reference does not match');
  }

  private validateReferences(
    proposal: DiscoveryProposalType,
    options: DiscoveryOptions,
    outputs: Record<string, { shape: unknown }>,
  ): void {
    if (proposal.kind === 'enterInput' && !(proposal.inputName in options.loadedGoal.goal.inputs))
      throw new DiscoveryStop('POLICY_DENIED', 'Proposal references an undeclared input');
    if (
      proposal.kind === 'enterSecret' &&
      !options.loadedGoal.goal.secretReferences.includes(proposal.secretName)
    )
      throw new DiscoveryStop('POLICY_DENIED', 'Proposal references an undeclared secret');
    if (proposal.kind === 'extract' && !(proposal.outputName in outputs))
      throw new DiscoveryStop('POLICY_DENIED', 'Proposal references an undeclared output');
  }

  private assertLimits(
    options: DiscoveryOptions,
    started: number,
    current: number,
    modelCalls: number,
    actions: number,
    failures: number,
  ): void {
    const budget = options.loadedGoal.goal.budgets;
    if (options.cancellationSignal?.aborted)
      throw new DiscoveryStop('CANCELLED', 'Discovery was cancelled');
    if (current - started >= budget.timeoutMs)
      throw new DiscoveryStop('DISCOVERY_TIMEOUT', 'Discovery timeout reached');
    if (modelCalls >= budget.maxModelCalls)
      throw new DiscoveryStop('MODEL_CALL_BUDGET_EXHAUSTED', 'Model-call budget exhausted');
    if (actions >= budget.maxActions)
      throw new DiscoveryStop('ACTION_BUDGET_EXHAUSTED', 'Action budget exhausted');
    if (failures >= budget.maxConsecutiveFailures)
      throw new DiscoveryStop('CONSECUTIVE_FAILURES', 'Consecutive-failure limit reached');
  }

  private assertScope(url: string, origins: readonly string[], routes: readonly string[]): void {
    const parsed = new URL(url);
    if (
      !origins.includes(parsed.origin) ||
      !routes.some((pattern) => new RegExp(pattern).test(parsed.pathname))
    )
      throw new DiscoveryStop('POLICY_DENIED', 'URL is outside the declared application scope');
  }

  private interventionStop(decision: ReplayInterventionDecision): DiscoveryStop | undefined {
    switch (decision.kind) {
      case 'resume':
      case 'complete':
        return undefined;
      case 'abort':
        return new DiscoveryStop('ABORTED_BY_HUMAN', 'Discovery aborted by human');
      case 'timeout':
        return new DiscoveryStop('INTERVENTION_TIMEOUT', 'Human intervention timed out');
      case 'browserSessionLost':
        return new DiscoveryStop('BROWSER_SESSION_LOST', 'Browser session was lost');
      case 'interrupted':
        return new DiscoveryStop('CANCELLED', `Discovery interrupted by ${decision.source}`);
    }
  }
}
