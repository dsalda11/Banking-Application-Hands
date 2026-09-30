import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { CapabilityArtifactType, CapabilityStepType, RunResultType } from '../domain/index.js';
import { ErrorDetail } from '../domain/errors.js';
import type { DataShapeType } from '../domain/data-shapes.js';
import type { EvidenceReferenceType } from '../domain/evidence.js';
import type { ExecutionContext } from '../execution/execution-context.js';
import { SurfaceError } from '../surfaces/surface-errors.js';
import type { SurfaceAdapter, SurfaceEvent } from '../surfaces/surface-types.js';
import { ArtifactLoadError, type LoadedArtifact } from './artifact-loader.js';
import { RuntimeBindingError, validateRuntimeBindings } from './runtime-bindings.js';
import { PolicyDecisionError, PolicyEngine } from '../policy/policy-engine.js';
import type { LoadedPolicy } from '../policy/policy-loader.js';
import {
  AutomationActionGuard,
  createInterventionId,
  type InterventionCoordinator,
  type LeaseBoundInterventionCoordinator,
  type ReplayInterventionDecision,
  type ValidationReportingCoordinator,
} from '../intervention/intervention-coordinator.js';
import { ControlLeaseManager, LeaseError } from '../intervention/control-lease.js';

export interface ReplayOptions {
  readonly loadedArtifact: LoadedArtifact;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly baseUrl: string;
  readonly evidenceDirectory: string;
  readonly headless: boolean;
  readonly adapter: SurfaceAdapter;
  readonly loadedPolicy: LoadedPolicy;
  readonly logger?: Logger;
  readonly executionMode?: 'nonInteractive' | 'interactive';
  /** Test-only deterministic lease clock; production omits it and uses wall time. */
  readonly leaseNow?: () => number;
  /** Step 8A seam; Step 8B supplies the local operator-server implementation. */
  readonly interventionCoordinator?: InterventionCoordinator;
}

class ReplayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ReplayError';
  }
}

function errorDetail(error: unknown, stepId?: string) {
  if (error instanceof SurfaceError) return error.toErrorDetail(stepId);
  if (error instanceof ReplayError)
    return ErrorDetail.parse({
      category: error.code.includes('CHECKPOINT') ? 'checkpoint' : 'application',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      evidence: [],
      ...(stepId ? { stepId } : {}),
    });
  if (error instanceof RuntimeBindingError)
    return ErrorDetail.parse({
      category: 'session',
      code: error.code,
      message: error.message,
      retryable: false,
      evidence: [],
    });
  if (error instanceof ArtifactLoadError)
    return ErrorDetail.parse({
      category: 'schema',
      code: error.code,
      message: error.message,
      retryable: false,
      evidence: [],
    });
  if (error instanceof PolicyDecisionError)
    return ErrorDetail.parse({
      category: error.code === 'POLICY_INTERVENTION_REQUIRED' ? 'permission' : 'policy',
      code: error.code,
      message: error.message,
      retryable: false,
      evidence: [],
      ...(stepId ? { stepId } : {}),
    });
  if (error instanceof LeaseError)
    return ErrorDetail.parse({
      category: 'session',
      code: error.code,
      message: error.message,
      retryable: false,
      evidence: [],
      ...(stepId ? { stepId } : {}),
    });
  return ErrorDetail.parse({
    category: 'internal',
    code: 'REPLAY_FAILED',
    message: 'Replay failed unexpectedly',
    retryable: false,
    evidence: [],
    ...(stepId ? { stepId } : {}),
  });
}

function delayMs(step: CapabilityStepType, attempt: number): number {
  if (step.recovery.kind !== 'retry') return 0;
  return step.recovery.backoff.kind === 'fixed'
    ? step.recovery.backoff.delayMs
    : Math.min(
        step.recovery.backoff.initialDelayMs * 2 ** Math.max(0, attempt - 1),
        step.recovery.backoff.maxDelayMs,
      );
}

function canRetry(step: CapabilityStepType, code: string): boolean {
  return step.recovery.kind === 'retry' && step.recovery.retryableErrorCodes.includes(code);
}

function localEvidenceReference(
  root: string,
  filePath: string,
  kind: EvidenceReferenceType['kind'],
  mediaType: string,
): EvidenceReferenceType {
  return {
    evidenceId: `replay-${path.basename(filePath)}`,
    kind,
    path: path.relative(root, filePath).split(path.sep).join('/'),
    sanitization: 'sanitized',
    mediaType,
  };
}

async function writePreflightEvents(
  evidenceRoot: string,
  runId: string,
  events: readonly SurfaceEvent[],
): Promise<EvidenceReferenceType> {
  const root = path.resolve(evidenceRoot);
  const directory = path.join(root, 'runs', runId);
  await mkdir(directory, { recursive: true });
  const eventPath = path.join(directory, 'events.jsonl');
  await writeFile(
    eventPath,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  return localEvidenceReference(root, eventPath, 'eventLog', 'application/x-ndjson');
}

async function writePreflightResult(
  evidenceRoot: string,
  runId: string,
  result: RunResultType,
): Promise<EvidenceReferenceType> {
  const root = path.resolve(evidenceRoot);
  const directory = path.join(root, 'runs', runId);
  await mkdir(directory, { recursive: true });
  const resultPath = path.join(directory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return localEvidenceReference(root, resultPath, 'result', 'application/json');
}

export class ReplayEngine {
  async run(options: ReplayOptions): Promise<RunResultType> {
    const runId = `replay-${randomUUID()}`;
    const { artifact, contentHash } = options.loadedArtifact;
    const policyEngine = new PolicyEngine(
      options.loadedPolicy.policy,
      options.loadedPolicy.contentHash,
    );
    const events: SurfaceEvent[] = [];
    let trace: EvidenceReferenceType | undefined;
    let startedTrace = false;
    let secretStepSeen = false;
    let navigationCount = 0;
    let surfaceStarted = false;
    let context: ExecutionContext | undefined;
    let coordinatorClosed = false;
    const executionMode = options.executionMode ?? 'nonInteractive';
    const lease = new ControlLeaseManager(
      runId,
      `control-${runId}`,
      'replay automation',
      options.leaseNow,
    );
    if (options.interventionCoordinator && 'bindLease' in options.interventionCoordinator)
      (options.interventionCoordinator as LeaseBoundInterventionCoordinator).bindLease(lease);
    const guard = new AutomationActionGuard(lease);
    let lastCompletedStepId: string | undefined;

    try {
      const bindings = validateRuntimeBindings(artifact, options.inputs, options.secrets);
      const replayContext: ExecutionContext = {
        inputs: bindings.inputs,
        secrets: bindings.secrets,
        outputs: {},
        baseUrl: options.baseUrl,
        outputShapes: Object.fromEntries(
          Object.entries(artifact.contract.outputs).map(([name, spec]) => [name, spec.shape]),
        ) as Record<string, DataShapeType>,
        runId,
        ...(options.logger ? { logger: options.logger } : {}),
      };
      context = replayContext;
      events.push({
        timestamp: new Date().toISOString(),
        eventType: 'policy_loaded',
        action: 'policy',
        ok: true,
        policyId: options.loadedPolicy.policy.id,
        policyVersion: options.loadedPolicy.policy.version,
        policyHash: options.loadedPolicy.contentHash,
      });
      if (!options.loadedPolicy.policy.traceRules.enabled)
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'trace_omitted',
          action: 'trace',
          reason:
            'Raw Playwright traces are disabled by policy because they cannot be retained safely.',
          ok: true,
        });
      policyEngine.preflight(artifact);
      await options.adapter.start({
        baseUrl: options.baseUrl,
        headless: options.headless,
        runId,
        evidenceDirectory: options.evidenceDirectory,
        timeoutMs: 15000,
        viewport: { width: 1280, height: 720 },
      });
      surfaceStarted = true;
      for (const precondition of artifact.preconditions) {
        guard.assertCanAct();
        const result = await options.adapter.evaluateCheckpoint(precondition, context);
        events.push({
          timestamp: new Date().toISOString(),
          action: `checkpoint:${result.kind}`,
          eventType: 'checkpoint_result',
          expected: result.description,
          observed: result.observedState,
          ok: result.passed,
        });
        if (!result.passed)
          throw result.error ?? new ReplayError('CHECKPOINT_FAILED', result.description);
      }

      for (const step of artifact.steps) {
        const result = await this.executeStep(
          step,
          artifact,
          replayContext,
          options.adapter,
          events,
          policyEngine,
          runId,
          () => navigationCount,
          () => {
            navigationCount += 1;
          },
          async () => {
            if (startedTrace) {
              await options.adapter.stopTrace();
              startedTrace = false;
            }
          },
          async () => {
            if (options.loadedPolicy.policy.traceRules.enabled && secretStepSeen) {
              await options.adapter.startTrace({ name: 'post-recovery-replay-trace' });
              startedTrace = true;
            }
          },
          guard,
          async (decision, pendingStep, retryable) =>
            this.pauseForIntervention({
              options,
              artifact,
              runId,
              decision,
              step: pendingStep,
              retryable,
              ...(lastCompletedStepId ? { lastCompletedStepId } : {}),
              guard,
              events,
              executionMode,
              adapter: options.adapter,
              context: replayContext,
            }),
        );
        lastCompletedStepId = step.id;
        if (result.outcome) {
          const evidence = await this.finishEvidence(options.adapter, events, trace);
          if (result.outcome.result === 'permissionDenied') {
            const permissionResult: RunResultType = {
              status: 'permissionDenied',
              runId,
              artifactId: artifact.id,
              artifactVersion: artifact.version,
              artifactHash: contentHash,
              code: 'PERMISSION_DENIED',
              ...(result.outcome.stepId ? { stepId: result.outcome.stepId } : {}),
              evidence,
              completedAt: new Date().toISOString(),
            };
            await options.adapter.writeResult(permissionResult);
            return permissionResult;
          }
          const businessResult: RunResultType = {
            status: 'businessOutcome',
            runId,
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            artifactHash: contentHash,
            code: result.outcome.code,
            evidence,
            completedAt: new Date().toISOString(),
          };
          await options.adapter.writeResult(businessResult);
          return businessResult;
        }
        if (step.action.kind === 'enterText' && step.action.value.kind === 'secret')
          secretStepSeen = true;
        if (
          options.loadedPolicy.policy.traceRules.enabled &&
          secretStepSeen &&
          !startedTrace &&
          step.action.kind !== 'enterText'
        ) {
          await options.adapter.startTrace({ name: 'post-secret-replay-trace' });
          startedTrace = true;
        }
      }
      if (!context)
        throw new ReplayError('REPLAY_CONTEXT_MISSING', 'Replay context was not initialized');
      guard.assertCanAct();
      const success = await options.adapter.evaluateCheckpoint(artifact.success, replayContext);
      events.push({
        timestamp: new Date().toISOString(),
        action: `checkpoint:${success.kind}`,
        eventType: 'checkpoint_result',
        expected: success.description,
        observed: success.observedState,
        ok: success.passed,
      });
      if (!success.passed)
        throw success.error ?? new ReplayError('CHECKPOINT_FAILED', success.description);
      for (const outputName of Object.keys(artifact.contract.outputs))
        if (!(outputName in replayContext.outputs))
          throw new ReplayError(
            'REQUIRED_OUTPUT_MISSING',
            `Required output ${outputName} was not produced`,
          );
      guard.assertCanAct();
      const screenshot = await options.adapter.captureScreenshot({ name: 'replay-final' });
      guard.assertCanAct();
      const observation = await options.adapter.observe();
      const observationEvidence = await options.adapter.writeObservation(observation);
      trace = startedTrace ? await options.adapter.stopTrace() : undefined;
      const evidence = [screenshot, observationEvidence, ...(trace ? [trace] : [])];
      const successResult: RunResultType = {
        status: 'success',
        runId,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactHash: contentHash,
        outputs: replayContext.outputs,
        evidence,
        completedAt: new Date().toISOString(),
      };
      if (options.interventionCoordinator && 'close' in options.interventionCoordinator) {
        await (options.interventionCoordinator as LeaseBoundInterventionCoordinator).close();
        coordinatorClosed = true;
      }
      this.appendCoordinatorEvents(events, options.interventionCoordinator);
      const eventEvidence = await options.adapter.writeEventLog(events).catch((error: unknown) => {
        throw new ReplayError(
          'EVIDENCE_WRITE_FAILED',
          'Replay evidence could not be written',
          false,
          error,
        );
      });
      successResult.evidence.push(eventEvidence);
      await options.adapter.writeResult(successResult);
      return successResult;
    } catch (error: unknown) {
      if (startedTrace) trace = await options.adapter.stopTrace().catch(() => undefined);
      let failure = errorDetail(error, events.at(-1)?.stepId);
      const failureEvidence: EvidenceReferenceType[] = [];
      if (surfaceStarted) {
        try {
          failureEvidence.push(await options.adapter.captureScreenshot({ name: 'replay-failure' }));
        } catch {
          // Screenshots remain best-effort and are blocked by the adapter while secrets are visible.
        }
      }
      if (error instanceof PolicyDecisionError && error.decision) {
        events.push({
          timestamp: error.decision.timestamp,
          eventType: `policy_${error.decision.decision}`,
          stepId: error.decision.stepId,
          action: error.decision.actionType,
          risk: error.decision.risk,
          policyDecision: error.decision.decision,
          policyId: error.decision.policyId,
          policyVersion: error.decision.policyVersion,
          policyHash: error.decision.policyHash,
          ...(error.decision.ruleId ? { matchingRuleId: error.decision.ruleId } : {}),
          reason: error.decision.reason,
          ok: false,
        });
      }
      try {
        if (options.interventionCoordinator && 'close' in options.interventionCoordinator) {
          await (options.interventionCoordinator as LeaseBoundInterventionCoordinator).close();
          coordinatorClosed = true;
        }
        this.appendCoordinatorEvents(events, options.interventionCoordinator);
        events.push({
          timestamp: new Date().toISOString(),
          eventType: failure.code === 'ABORTED_BY_HUMAN' ? 'run_aborted' : 'run_failed',
          action: 'run',
          ok: false,
          errorCode: failure.code,
          reason: failure.message,
        });
        if (surfaceStarted) failureEvidence.push(await options.adapter.writeEventLog(events));
        else
          failureEvidence.push(
            await writePreflightEvents(options.evidenceDirectory, runId, events),
          );
      } catch (evidenceError: unknown) {
        failure = ErrorDetail.parse({
          category: 'internal',
          code: 'EVIDENCE_WRITE_FAILED',
          message: 'Replay evidence could not be written',
          retryable: false,
          evidence: [],
          ...(events.at(-1)?.stepId ? { stepId: events.at(-1)!.stepId } : {}),
        });
        options.logger?.error(
          { code: 'EVIDENCE_WRITE_FAILED', runId },
          'Replay evidence could not be written',
        );
        void evidenceError;
      }
      const specialCode = failure.code;
      const result: RunResultType =
        specialCode === 'COMPLETED_BY_HUMAN' && context
          ? {
              status: 'success',
              runId,
              artifactId: artifact.id,
              artifactVersion: artifact.version,
              artifactHash: contentHash,
              outputs: context.outputs,
              completionMode: 'human',
              evidence: [...failureEvidence, ...(trace ? [trace] : [])],
              completedAt: new Date().toISOString(),
            }
          : specialCode === 'INTERVENTION_REQUIRED'
            ? {
                status: 'needsHuman',
                runId,
                interventionId: `control-${runId}`,
                currentStepId: failure.stepId ?? 'unknown-step',
                reasonCode: 'INTERVENTION_REQUIRED',
                evidence: [...failureEvidence, ...(trace ? [trace] : [])],
              }
            : specialCode === 'ABORTED_BY_HUMAN'
              ? {
                  status: 'aborted',
                  runId,
                  artifactId: artifact.id,
                  artifactVersion: artifact.version,
                  artifactHash: contentHash,
                  code: 'ABORTED_BY_HUMAN',
                  evidence: [...failureEvidence, ...(trace ? [trace] : [])],
                  completedAt: new Date().toISOString(),
                }
              : {
                  status: 'failure',
                  runId,
                  artifactId: artifact.id,
                  artifactVersion: artifact.version,
                  artifactHash: contentHash,
                  error: failure,
                  evidence: [...failureEvidence, ...(trace ? [trace] : [])],
                  completedAt: new Date().toISOString(),
                };
      try {
        if (surfaceStarted) await options.adapter.writeResult(result);
        else
          result.evidence.push(
            await writePreflightResult(options.evidenceDirectory, runId, result),
          );
      } catch (resultError: unknown) {
        options.logger?.error(
          { code: 'RESULT_EVIDENCE_WRITE_FAILED', runId },
          'Replay result evidence could not be written',
        );
        void resultError;
      }
      return result;
    } finally {
      await options.adapter.close();
      if (
        !coordinatorClosed &&
        options.interventionCoordinator &&
        'close' in options.interventionCoordinator
      )
        await (options.interventionCoordinator as LeaseBoundInterventionCoordinator).close();
    }
  }

  private async pauseForIntervention(args: {
    readonly options: ReplayOptions;
    readonly artifact: CapabilityArtifactType;
    readonly runId: string;
    readonly decision: ReturnType<PolicyEngine['decide']>;
    readonly step: CapabilityStepType;
    readonly retryable: boolean;
    readonly lastCompletedStepId?: string;
    readonly guard: AutomationActionGuard;
    readonly events: SurfaceEvent[];
    readonly executionMode: 'nonInteractive' | 'interactive';
    readonly adapter: SurfaceAdapter;
    readonly context: ExecutionContext;
  }): Promise<'execute' | 'satisfied'> {
    const { decision, step, events, guard } = args;
    const interventionId = createInterventionId();
    const timestamp = new Date().toISOString();
    events.push({
      timestamp,
      eventType: 'intervention_requested',
      stepId: step.id,
      action: step.action.kind,
      risk: decision.risk,
      policyDecision: decision.decision,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      policyHash: decision.policyHash,
      reason: decision.reason,
      ok: false,
    });
    if (args.executionMode === 'nonInteractive' || !args.options.interventionCoordinator)
      throw new ReplayError(
        'INTERVENTION_REQUIRED',
        'Policy requires an interactive human intervention before this action',
      );
    if (step.action.kind === 'enterText' && step.action.value.kind === 'secret')
      throw new ReplayError(
        'INTERVENTION_REQUIRED',
        'A secret-entry action cannot be paused for human intervention',
      );
    if (!args.retryable)
      throw new ReplayError(
        'INTERVENTION_REQUIRED',
        'The pending consequential action cannot be resumed automatically',
      );

    events.push({
      timestamp: new Date().toISOString(),
      eventType: 'pause_requested',
      stepId: step.id,
      action: step.action.kind,
      reason: decision.reason,
      ok: true,
    });
    let pausedGeneration = guard.requestPause();
    events.push({
      timestamp: new Date().toISOString(),
      eventType: 'safe_boundary_reached',
      stepId: step.id,
      action: step.action.kind,
      reason: `lastCompletedStep=${args.lastCompletedStepId ?? 'none'}; leaseGeneration=${pausedGeneration}`,
      ok: true,
    });
    events.push({
      timestamp: new Date().toISOString(),
      eventType: 'automation_paused',
      stepId: step.id,
      action: 'lease',
      reason: 'Automation stopped before the intervention-triggering action.',
      ok: true,
    });
    const request = {
      interventionId,
      runId: args.runId,
      artifactId: args.artifact.id,
      artifactVersion: args.artifact.version,
      stepId: step.id,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      reason: decision.reason,
      risk: decision.risk,
      boundary: {
        ...(args.lastCompletedStepId ? { lastCompletedStepId: args.lastCompletedStepId } : {}),
        pendingStepId: step.id,
        pendingActionType: step.action.kind,
        retryable: args.retryable,
        consequential: step.risk === 'irreversibleWrite',
        checkpointDescription: step.checkpoint.description,
        leaseGeneration: pausedGeneration,
      },
      resumeCheckpointDescription: step.checkpoint.description,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + args.options.loadedPolicy.policy.maxReplayDurationMs,
      ).toISOString(),
    } as const;
    events.push({
      timestamp: new Date().toISOString(),
      eventType: 'coordinator_waiting',
      stepId: step.id,
      action: 'intervention',
      reason: 'Replay is awaiting a coordinator decision at a safe boundary.',
      ok: true,
    });

    for (;;) {
      const response: ReplayInterventionDecision =
        await args.options.interventionCoordinator.awaitDecision(request);
      if (
        response.interventionId !== interventionId ||
        (response.kind !== 'abort' && !guard.acceptsDecisionGeneration(response.leaseGeneration))
      ) {
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'stale_resume_rejected',
          stepId: step.id,
          action: 'intervention',
          reason: 'Coordinator decision did not match the active intervention lease generation.',
          ok: false,
        });
        continue;
      }
      if (response.kind === 'abort') {
        guard.abort();
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'human_abort',
          stepId: step.id,
          action: 'intervention',
          ok: true,
        });
        throw new ReplayError('ABORTED_BY_HUMAN', 'Replay was aborted by a human operator');
      }
      if (response.kind === 'complete') {
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'completion_requested',
          stepId: step.id,
          action: 'intervention',
          ok: true,
        });
        const complete = await args.adapter.evaluateCheckpoint(args.artifact.success, args.context);
        const outputsPresent = Object.keys(args.artifact.contract.outputs).every(
          (name) => name in args.context.outputs,
        );
        if (!complete.passed || !outputsPresent) {
          events.push({
            timestamp: new Date().toISOString(),
            eventType: 'completion_rejected',
            stepId: step.id,
            action: 'intervention',
            reason: 'Declared final checkpoint or required outputs are not satisfied.',
            ok: false,
          });
          guard.rejectResume(response.leaseGeneration);
          pausedGeneration = await this.restoreHumanOwnership(
            args.options.interventionCoordinator,
            'Completion validation failed.',
            pausedGeneration,
          );
          continue;
        }
        guard.resume(response.leaseGeneration);
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'completion_accepted',
          stepId: step.id,
          action: 'intervention',
          ok: true,
        });
        this.validationFinished(args.options.interventionCoordinator);
        throw new ReplayError('COMPLETED_BY_HUMAN', 'Human completion was verified');
      }
      if (response.kind === 'timeout')
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'intervention_timeout',
          stepId: step.id,
          action: 'intervention',
          ok: false,
        });
      if (response.kind === 'timeout')
        throw new ReplayError('INTERVENTION_TIMEOUT', 'Human intervention timed out');
      if (response.kind === 'browserSessionLost') {
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'browser_session_lost',
          stepId: step.id,
          action: 'intervention',
          ok: false,
        });
        throw new ReplayError(
          'BROWSER_SESSION_LOST',
          'Browser session was lost during intervention',
        );
      }
      events.push({
        timestamp: new Date().toISOString(),
        eventType: 'resume_received',
        stepId: step.id,
        action: 'intervention',
        ok: true,
      });
      guard.resume(response.leaseGeneration);
      events.push({
        timestamp: new Date().toISOString(),
        eventType: 'automation_ownership_restored',
        stepId: step.id,
        action: 'lease',
        ok: true,
      });
      // Resume is safe only when the human placed the target page in the
      // declared postcondition. A failed validation returns to PAUSED instead
      // of retrying an action the operator may have partially performed.
      const postcondition = await args.adapter.evaluateCheckpoint(step.checkpoint, args.context);
      if (!postcondition.passed) {
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'resume_rejected',
          stepId: step.id,
          action: `checkpoint:${postcondition.kind}`,
          reason: 'The pending action postcondition is not satisfied.',
          ok: false,
        });
        pausedGeneration = guard.requestPause();
        pausedGeneration = await this.restoreHumanOwnership(
          args.options.interventionCoordinator,
          'Resume validation failed.',
          pausedGeneration,
        );
        continue;
      }
      // This second decision is deliberate evidence that the same policy still
      // governs the action after ownership changes. The coordinator approval is
      // only valid for this exact safe boundary.
      const reevaluated = new PolicyEngine(
        args.options.loadedPolicy.policy,
        args.options.loadedPolicy.contentHash,
      ).decide(step.action, step, args.runId, 1, 0, 0);
      if (reevaluated.decision === 'deny')
        throw new PolicyDecisionError('POLICY_DENIED', reevaluated.reason);
      events.push({
        timestamp: new Date().toISOString(),
        eventType: 'automation_resumed',
        stepId: step.id,
        action: step.action.kind,
        policyDecision: reevaluated.decision,
        risk: reevaluated.risk,
        ok: true,
      });
      this.validationFinished(args.options.interventionCoordinator);
      return 'satisfied';
    }
  }

  private async restoreHumanOwnership(
    coordinator: InterventionCoordinator | undefined,
    reason: string,
    fallbackGeneration: number,
  ): Promise<number> {
    if (coordinator && 'restoreHumanOwnership' in coordinator)
      return (coordinator as unknown as ValidationReportingCoordinator).restoreHumanOwnership(
        reason,
      );
    return fallbackGeneration;
  }

  private validationFinished(coordinator: InterventionCoordinator | undefined): void {
    if (coordinator && 'validationFinished' in coordinator)
      (coordinator as unknown as ValidationReportingCoordinator).validationFinished();
  }

  private async executeStep(
    step: CapabilityStepType,
    artifact: CapabilityArtifactType,
    context: ExecutionContext,
    adapter: SurfaceAdapter,
    events: SurfaceEvent[],
    policyEngine: PolicyEngine,
    runId: string,
    getNavigationCount: () => number,
    countNavigation: () => void,
    prepareRecovery: () => Promise<void>,
    resumeTrace: () => Promise<void>,
    guard: AutomationActionGuard,
    handleIntervention: (
      decision: ReturnType<PolicyEngine['decide']>,
      step: CapabilityStepType,
      retryable: boolean,
    ) => Promise<'execute' | 'satisfied'>,
  ): Promise<{
    outcome?: { code: string; result: 'businessOutcome' | 'permissionDenied'; stepId: string };
  }> {
    let attempts = step.recovery.kind === 'retry' ? step.recovery.maxAttempts : 1;
    let recoveryUsed = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      guard.assertCanAct();
      if (step.recovery.kind === 'reauthenticate') {
        guard.assertCanAct();
        const expired = await adapter.evaluateCheckpoint(step.recovery.sessionExpired, context);
        events.push({
          timestamp: new Date().toISOString(),
          eventType: 'session_expiration_check',
          stepId: step.id,
          action: `checkpoint:${expired.kind}`,
          ok: expired.passed,
        });
        if (expired.passed) {
          if (recoveryUsed || step.risk === 'irreversibleWrite')
            throw new ReplayError(
              'SESSION_EXPIRED',
              'Session expired and safe recovery is unavailable',
            );
          await prepareRecovery();
          await this.runAuthenticationRecovery(
            step,
            context,
            adapter,
            events,
            policyEngine,
            runId,
            guard,
          );
          recoveryUsed = true;
          attempts = Math.max(attempts, attempt + 1);
          await resumeTrace();
        }
      }
      const started = Date.now();
      const policyDecision = policyEngine.decide(
        step.action,
        step,
        runId,
        attempt,
        getNavigationCount(),
        0,
      );
      events.push({
        timestamp: policyDecision.timestamp,
        eventType: `policy_${policyDecision.decision}`,
        stepId: step.id,
        action: step.action.kind,
        attempt,
        risk: policyDecision.risk,
        policyDecision: policyDecision.decision,
        policyId: policyDecision.policyId,
        policyVersion: policyDecision.policyVersion,
        policyHash: policyDecision.policyHash,
        ...(policyDecision.ruleId ? { matchingRuleId: policyDecision.ruleId } : {}),
        reason: policyDecision.reason,
        ok: policyDecision.decision === 'allow',
      });
      if (policyDecision.decision === 'deny') policyEngine.assertDecision(policyDecision);
      const interventionResult =
        policyDecision.decision === 'requireIntervention'
          ? await handleIntervention(policyDecision, step, step.risk !== 'irreversibleWrite')
          : 'execute';
      if (interventionResult === 'satisfied') {
        const terminalOutcome = await this.detectOutcome(
          artifact,
          adapter,
          context,
          events,
          step.id,
          guard,
        );
        if (terminalOutcome) return { outcome: { ...terminalOutcome, stepId: step.id } };
        return {};
      }
      guard.assertCanAct();
      const actionResult = await adapter.execute(step.action, { ...context, stepId: step.id });
      if (step.action.kind === 'navigate') countNavigation();
      events.push({
        timestamp: new Date().toISOString(),
        stepId: step.id,
        action: step.action.kind,
        ...(actionResult.target ? { locatorStrategy: actionResult.target.strategy } : {}),
        durationMs: Date.now() - started,
        ok: actionResult.ok,
        ...(actionResult.error ? { errorCode: actionResult.error.code } : {}),
      });
      let failure: unknown;
      if (!actionResult.ok)
        failure = actionResult.error ?? new ReplayError('ACTION_FAILED', 'Artifact action failed');
      if (failure && step.recovery.kind === 'reauthenticate') {
        guard.assertCanAct();
        const expired = await adapter.evaluateCheckpoint(step.recovery.sessionExpired, context);
        if (expired.passed) {
          events.push({
            timestamp: new Date().toISOString(),
            eventType: 'session_expired',
            stepId: step.id,
            action: 'session',
            recoveryId: `${runId}-${step.id}-recovery`,
            ok: true,
          });
          if (recoveryUsed || step.risk === 'irreversibleWrite')
            throw new ReplayError('SESSION_EXPIRED', 'Session expired again after recovery');
          await prepareRecovery();
          await this.runAuthenticationRecovery(
            step,
            context,
            adapter,
            events,
            policyEngine,
            runId,
            guard,
          );
          recoveryUsed = true;
          attempts = Math.max(attempts, attempt + 1);
          await resumeTrace();
          continue;
        }
      }
      if (!failure) {
        guard.assertCanAct();
        const checkpoint = await adapter.evaluateCheckpoint(step.checkpoint, context);
        events.push({
          timestamp: new Date().toISOString(),
          stepId: step.id,
          action: `checkpoint:${checkpoint.kind}`,
          durationMs: checkpoint.durationMs,
          ok: checkpoint.passed,
          ...(checkpoint.error ? { errorCode: checkpoint.error.code } : {}),
        });
        if (!checkpoint.passed)
          failure =
            checkpoint.error ?? new ReplayError('CHECKPOINT_FAILED', checkpoint.description);
      }
      if (failure && step.recovery.kind === 'reauthenticate') {
        guard.assertCanAct();
        const expired = await adapter.evaluateCheckpoint(step.recovery.sessionExpired, context);
        if (expired.passed) {
          events.push({
            timestamp: new Date().toISOString(),
            eventType: 'session_expired',
            stepId: step.id,
            action: 'session',
            recoveryId: `${runId}-${step.id}-recovery`,
            ok: true,
          });
          if (recoveryUsed || step.risk === 'irreversibleWrite')
            throw new ReplayError('SESSION_EXPIRED', 'Session expired again after recovery');
          await prepareRecovery();
          await this.runAuthenticationRecovery(
            step,
            context,
            adapter,
            events,
            policyEngine,
            runId,
            guard,
          );
          recoveryUsed = true;
          attempts = Math.max(attempts, attempt + 1);
          await resumeTrace();
          continue;
        }
      }
      if (failure) {
        const terminalOutcome = await this.detectOutcome(
          artifact,
          adapter,
          context,
          events,
          step.id,
          guard,
        );
        if (terminalOutcome) return { outcome: { ...terminalOutcome, stepId: step.id } };
      }
      if (!failure) {
        const terminalOutcome = await this.detectOutcome(
          artifact,
          adapter,
          context,
          events,
          step.id,
          guard,
        );
        if (terminalOutcome) return { outcome: { ...terminalOutcome, stepId: step.id } };
        return {};
      }
      const code =
        failure instanceof SurfaceError || failure instanceof ReplayError
          ? failure.code
          : 'ACTION_FAILED';
      if (attempt < attempts && canRetry(step, code)) {
        guard.assertCanAct();
        const delay = delayMs(step, attempt);
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        guard.assertCanAct();
        continue;
      }
      throw failure;
    }
    throw new ReplayError('REPLAY_STEP_FAILED', `Step ${step.id} failed`);
  }

  private async detectOutcome(
    artifact: CapabilityArtifactType,
    adapter: SurfaceAdapter,
    context: ExecutionContext,
    events: SurfaceEvent[],
    stepId: string,
    guard: AutomationActionGuard,
  ): Promise<{ code: string; result: 'businessOutcome' | 'permissionDenied' } | undefined> {
    for (const outcome of artifact.contract.businessOutcomes) {
      guard.assertCanAct();
      const detection = await adapter.evaluateCheckpoint(outcome.detection, context);
      events.push({
        timestamp: new Date().toISOString(),
        stepId,
        action: `outcome:${outcome.code}`,
        eventType: detection.passed ? 'outcome_detected' : 'outcome_check',
        durationMs: detection.durationMs,
        expected: detection.description,
        observed: detection.observedState,
        ok: detection.passed,
      });
      if (detection.passed) return { code: outcome.code, result: outcome.result };
    }
    return undefined;
  }

  private async runAuthenticationRecovery(
    step: CapabilityStepType,
    context: ExecutionContext,
    adapter: SurfaceAdapter,
    events: SurfaceEvent[],
    policyEngine: PolicyEngine,
    runId: string,
    guard: AutomationActionGuard,
  ): Promise<void> {
    if (step.recovery.kind !== 'reauthenticate') return;
    const recoveryId = `${runId}-${step.id}-recovery`;
    events.push({
      timestamp: new Date().toISOString(),
      eventType: 'recovery_started',
      action: 'recovery',
      stepId: step.id,
      recoveryId,
      attempt: 1,
      ok: true,
    });
    for (const recoveryStep of step.recovery.steps) {
      guard.assertCanAct();
      const decision = policyEngine.decide(
        recoveryStep.action,
        { id: recoveryStep.id },
        runId,
        1,
        0,
        1,
      );
      events.push({
        timestamp: decision.timestamp,
        eventType: `policy_${decision.decision}`,
        stepId: recoveryStep.id,
        action: recoveryStep.action.kind,
        recoveryId,
        attempt: 1,
        risk: decision.risk,
        policyDecision: decision.decision,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        policyHash: decision.policyHash,
        ...(decision.ruleId ? { matchingRuleId: decision.ruleId } : {}),
        reason: decision.reason,
        ok: decision.decision === 'allow',
      });
      policyEngine.assertDecision(decision);
      guard.assertCanAct();
      const result = await adapter.execute(recoveryStep.action, {
        ...context,
        stepId: recoveryStep.id,
      });
      if (!result.ok)
        throw new ReplayError('RECOVERY_FAILED', 'Authentication recovery action failed');
      guard.assertCanAct();
      const checkpoint = await adapter.evaluateCheckpoint(recoveryStep.checkpoint, context);
      events.push({
        timestamp: new Date().toISOString(),
        eventType: 'recovery_step_checkpoint',
        stepId: recoveryStep.id,
        action: `checkpoint:${checkpoint.kind}`,
        recoveryId,
        ok: checkpoint.passed,
      });
      if (!checkpoint.passed)
        throw new ReplayError('RECOVERY_FAILED', 'Authentication recovery checkpoint failed');
    }
    guard.assertCanAct();
    const authenticated = await adapter.evaluateCheckpoint(step.recovery.checkpoint, context);
    events.push({
      timestamp: new Date().toISOString(),
      eventType: authenticated.passed ? 'recovery_succeeded' : 'recovery_failed',
      stepId: step.id,
      action: `checkpoint:${authenticated.kind}`,
      recoveryId,
      ok: authenticated.passed,
    });
    if (!authenticated.passed)
      throw new ReplayError(
        'RECOVERY_FAILED',
        'Authentication recovery did not restore the authenticated checkpoint',
      );
  }

  private async finishEvidence(
    adapter: SurfaceAdapter,
    events: readonly SurfaceEvent[],
    trace: EvidenceReferenceType | undefined,
  ): Promise<EvidenceReferenceType[]> {
    const screenshot = await adapter.captureScreenshot({ name: 'replay-business-outcome' });
    const observation = await adapter.observe();
    const observationEvidence = await adapter.writeObservation(observation);
    const stoppedTrace = trace ?? (await adapter.stopTrace());
    const eventEvidence = await adapter.writeEventLog(events);
    return [
      screenshot,
      observationEvidence,
      eventEvidence,
      ...(stoppedTrace ? [stoppedTrace] : []),
    ];
  }

  private appendCoordinatorEvents(
    events: SurfaceEvent[],
    coordinator: InterventionCoordinator | undefined,
  ): void {
    if (coordinator && 'drainEvents' in coordinator) {
      const drain = (coordinator as unknown as { drainEvents(): SurfaceEvent[] }).drainEvents;
      events.push(...drain.call(coordinator));
    }
  }
}
