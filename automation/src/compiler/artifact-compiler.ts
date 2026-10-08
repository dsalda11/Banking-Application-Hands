import type {
  CapabilityActionType,
  CapabilityArtifactType,
  CapabilityStepType,
  CheckpointType,
  LocatorCandidateType,
  TargetDescriptorType,
} from '../domain/index.js';
import { CapabilityArtifact } from '../domain/artifact.js';
import { validateArtifactSemantics } from '../domain/semantic-validation.js';
import type { LoadedDiscoveryGoal } from '../discovery/goal-loader.js';
import { canonicalJsonFile, contentHash } from './canonical-json.js';
import {
  traceAction,
  traceObservation,
  traceProposal,
  type ValidatedTrace,
} from './trace-loader.js';

export const COMPILER_NAME = 'deterministic-trace-artifact-compiler';
export const COMPILER_VERSION = '1.0.0';

export interface CompilerConfiguration {
  readonly timeoutMs?: number;
  readonly navigationRetryAttempts?: number;
  readonly compilationTime?: string;
}

export interface CompilationDiagnostic {
  readonly severity: 'warning' | 'info';
  readonly code: string;
  readonly message: string;
}

export interface CompilationManifest {
  readonly schemaVersion: '1.0.0';
  readonly compiler: { readonly name: string; readonly version: string };
  readonly artifact: { readonly id: string; readonly version: string; readonly hash: string };
  readonly goal: { readonly id: string; readonly version: string; readonly hash: string };
  readonly discoveryRunIds: readonly string[];
  readonly traceHashes: readonly string[];
  readonly providerProvenance: readonly {
    runId: string;
    provider: string;
    model: string;
  }[];
  readonly policies: readonly {
    id: string;
    version: string;
    hash: string;
  }[];
  readonly schemaVersions: {
    readonly goal: string;
    readonly trace: string;
    readonly artifact: string;
    readonly manifest: string;
  };
  readonly compiledAt: string;
  readonly selectedSteps: readonly {
    stepId: string;
    runId: string;
    proposalId?: string;
    eventSequence: number;
  }[];
  readonly discardedEvents: readonly {
    runId: string;
    sequence: number;
    proposalId?: string;
    reason: string;
  }[];
  readonly locatorSelections: readonly {
    stepId: string;
    selectedStrategies: readonly string[];
    reason: string;
  }[];
  readonly warnings: readonly string[];
  readonly result: 'draft';
}

export interface CompilationResult {
  readonly artifact: CapabilityArtifactType;
  readonly artifactBytes: string;
  readonly artifactHash: string;
  readonly manifest: CompilationManifest;
  readonly diagnostics: readonly CompilationDiagnostic[];
}

export class CompilationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompilationError';
  }
}

interface SuccessfulAction {
  action: CapabilityActionType;
  proposalId?: string;
  eventSequence: number;
  resultSequence: number;
  resolvedIndex?: number;
  elementReference?: string;
  preObservation?: ReturnType<typeof traceObservation>;
  postObservation?: ReturnType<typeof traceObservation>;
  risk?: unknown;
}

function actions(trace: ValidatedTrace): SuccessfulAction[] {
  const selected: SuccessfulAction[] = [];
  for (const [index, event] of trace.events.entries()) {
    const action = traceAction(event);
    if (!action) continue;
    const result = trace.events
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.eventType === 'action_result' && candidate.proposalId === event.proposalId,
      );
    if (!result || result.data.ok !== true) continue;
    if (event.proposalId) {
      const validated = trace.events.some(
        (candidate) =>
          candidate.eventType === 'proposal_validated' &&
          candidate.proposalId === event.proposalId &&
          candidate.data.valid === true,
      );
      const allowed = trace.events.some(
        (candidate) =>
          candidate.eventType === 'policy_decision' &&
          candidate.proposalId === event.proposalId &&
          candidate.data.decision === 'allow',
      );
      if (!validated || !allowed) continue;
    }
    const postObservation = trace.events
      .slice(trace.events.indexOf(result) + 1)
      .map(traceObservation)
      .find(Boolean);
    const preObservation = [...trace.events]
      .reverse()
      .find(
        (candidate) => candidate.sequence < event.sequence && candidate.eventType === 'observation',
      );
    const before = preObservation ? traceObservation(preObservation) : undefined;
    if (
      before &&
      postObservation &&
      before.stateFingerprint === postObservation.stateFingerprint &&
      ['activate', 'pressKey', 'scroll'].includes(action.kind)
    )
      continue;
    const policy = [...trace.events]
      .reverse()
      .find(
        (candidate) =>
          candidate.sequence < event.sequence &&
          candidate.eventType === 'policy_decision' &&
          candidate.proposalId === event.proposalId,
      );
    const proposalEvent = event.proposalId
      ? [...trace.events]
          .reverse()
          .find(
            (candidate) =>
              candidate.sequence < event.sequence &&
              candidate.eventType === 'planner_proposal' &&
              candidate.proposalId === event.proposalId,
          )
      : undefined;
    const proposal = proposalEvent ? traceProposal(proposalEvent) : undefined;
    selected.push({
      action,
      ...(event.proposalId ? { proposalId: event.proposalId } : {}),
      eventSequence: event.sequence,
      resultSequence: result.sequence,
      ...(typeof result.data.locatorCandidateIndex === 'number'
        ? { resolvedIndex: result.data.locatorCandidateIndex }
        : {}),
      ...(proposal &&
      'elementReference' in proposal &&
      typeof proposal.elementReference === 'string'
        ? { elementReference: proposal.elementReference }
        : {}),
      ...(before ? { preObservation: before } : {}),
      ...(postObservation ? { postObservation } : {}),
      risk: policy?.data.risk,
    });
  }
  return selected;
}

function candidateRank(candidate: LocatorCandidateType): number {
  switch (candidate.strategy) {
    case 'role':
    case 'accessibility':
      return 0;
    case 'label':
    case 'tableCell':
      return 1;
    case 'text':
      return 2;
    case 'attribute':
      return candidate.name === 'placeholder' ? 3 : 4;
    case 'css':
      return 5;
    default:
      return 99;
  }
}

function safeCandidate(candidate: LocatorCandidateType): boolean {
  if (candidate.strategy === 'visualAnchor' || candidate.strategy === 'xpath') return false;
  if (candidate.strategy === 'css') return !/:nth-|\[[0-9]+\]|>[ ]*[^ ]+:/.test(candidate.selector);
  return true;
}

function normalizeTarget(
  target: TargetDescriptorType,
  resolvedIndexes: readonly number[],
  replacement?: LocatorCandidateType,
): TargetDescriptorType {
  const candidates = (
    replacement
      ? [replacement]
      : [
          ...new Set([...resolvedIndexes, ...target.candidates.map((_candidate, index) => index)]),
        ].map((index) => target.candidates[index])
  )
    .filter((candidate): candidate is LocatorCandidateType => Boolean(candidate))
    .filter(safeCandidate)
    .sort((left, right) => candidateRank(left) - candidateRank(right));
  if (candidates.length === 0)
    throw new CompilationError(
      'LOCATOR_UNSUPPORTED',
      `No stable resolved locator for ${target.description}`,
    );
  return {
    description: target.description,
    ...(target.framePath ? { framePath: target.framePath.filter(safeCandidate) } : {}),
    candidates,
    match: 'exactlyOne',
  };
}

function overlapsHorizontally(
  left: { x: number; width: number },
  right: { x: number; width: number },
): boolean {
  return Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x) > 0;
}

function structuralExtractorCandidate(item: SuccessfulAction): LocatorCandidateType | undefined {
  if (item.action.kind !== 'extract') return undefined;
  const resolved =
    item.resolvedIndex === undefined
      ? undefined
      : item.action.target.candidates[item.resolvedIndex];
  if (resolved?.strategy !== 'text' || resolved.text.kind !== 'literal') return undefined;
  const observation = item.preObservation;
  const outputElement = observation?.elements.find(
    (element) => element.reference === item.elementReference,
  );
  const outputBox = outputElement?.boundingBox;
  if (!observation || !outputElement || !outputBox)
    throw new CompilationError(
      'OUTPUT_LOCATOR_VALUE_DEPENDENT',
      `Output ${item.action.output} has only a literal-value locator and no structural evidence`,
    );
  const possibleHeaders = observation.elements.filter(
    (element) =>
      element.frameId === outputElement.frameId &&
      (element.tagName === 'td' || element.tagName === 'th') &&
      Boolean(element.text && element.boundingBox) &&
      element.boundingBox!.y < outputBox.y &&
      overlapsHorizontally(element.boundingBox!, outputBox),
  );
  const header = possibleHeaders.sort(
    (left, right) => right.boundingBox!.y - left.boundingBox!.y,
  )[0];
  if (!header?.text || !header.boundingBox)
    throw new CompilationError(
      'OUTPUT_LOCATOR_VALUE_DEPENDENT',
      `Output ${item.action.output} has no stable associated table header`,
    );
  const headerRow = observation.elements
    .filter(
      (element) =>
        element.frameId === header.frameId &&
        (element.tagName === 'td' || element.tagName === 'th') &&
        element.boundingBox &&
        Math.abs(element.boundingBox.y - header.boundingBox!.y) < 0.002,
    )
    .sort((left, right) => left.boundingBox!.x - right.boundingBox!.x);
  const columnIndex = headerRow.findIndex((element) => element.reference === header.reference) + 1;
  if (columnIndex < 1)
    throw new CompilationError(
      'OUTPUT_LOCATOR_VALUE_DEPENDENT',
      `Output ${item.action.output} table column could not be established`,
    );
  return {
    strategy: 'tableCell',
    header: { kind: 'literal', value: header.text },
    columnIndex,
  };
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkpointFor(action: CapabilityActionType, postUrl?: string): CheckpointType {
  if (action.kind === 'extract')
    return {
      kind: 'outputMatchesShape',
      description: `The extracted ${action.output} output matches its declared shape.`,
      output: action.output,
    };
  if (
    postUrl &&
    (action.kind === 'navigate' || action.kind === 'activate' || action.kind === 'pressKey')
  ) {
    const parsed = new URL(postUrl);
    return {
      kind: 'urlMatches',
      description: `The observed post-action route is ${parsed.pathname}.`,
      pattern: escapePattern(parsed.pathname),
    } as CheckpointType;
  }
  if ('target' in action && action.target)
    return {
      kind: 'elementVisible',
      description: `${action.target.description} remains visible after the action.`,
      target: action.target,
    } as CheckpointType;
  throw new CompilationError(
    'CHECKPOINT_UNOBSERVED',
    `No meaningful checkpoint for ${action.kind}`,
  );
}

function normalizedAction(
  item: SuccessfulAction,
  fallbackIndexes: readonly number[],
): CapabilityActionType {
  const action = item.action;
  if (!('target' in action) || !action.target) return action;
  if (item.resolvedIndex === undefined)
    throw new CompilationError(
      'LOCATOR_PROVENANCE_MISSING',
      'Target action lacks resolved locator provenance',
    );
  const structural = structuralExtractorCandidate(item);
  const target = normalizeTarget(
    action.target,
    [item.resolvedIndex, ...fallbackIndexes],
    structural,
  );
  return {
    ...action,
    target:
      structural?.strategy === 'tableCell' &&
      structural.header.kind === 'literal' &&
      action.kind === 'extract'
        ? { ...target, description: `${action.output} table cell under ${structural.header.value}` }
        : target,
  };
}

function observedAuthenticatedTransition(selected: readonly SuccessfulAction[]): boolean {
  let secretSeen = false;
  for (const item of selected) {
    if (item.action.kind === 'enterText' && item.action.value.kind === 'secret') secretSeen = true;
    if (
      secretSeen &&
      (item.action.kind === 'activate' || item.action.kind === 'pressKey') &&
      item.postObservation &&
      new URL(item.postObservation.url).pathname !== '/'
    )
      return true;
  }
  return false;
}

function validateGoalAndTraces(goal: LoadedDiscoveryGoal, traces: readonly ValidatedTrace[]): void {
  if (traces.length === 0) throw new CompilationError('TRACE_SET_EMPTY', 'No traces supplied');
  for (const trace of traces)
    if (
      trace.goalId !== goal.goal.id ||
      trace.goalVersion !== goal.goal.version ||
      trace.goalHash !== goal.contentHash ||
      trace.policyId !== goal.goal.policyRef
    )
      throw new CompilationError('TRACE_GOAL_MISMATCH', 'Trace does not match the supplied goal');
  for (const trace of traces)
    for (const event of trace.events) {
      const observation = traceObservation(event);
      if (!observation) continue;
      const url = new URL(observation.url);
      if (
        !goal.goal.applicationScope.allowedOrigins.includes(url.origin) ||
        !goal.goal.applicationScope.allowedRoutePatterns.some((pattern) =>
          new RegExp(pattern).test(url.pathname),
        )
      )
        throw new CompilationError(
          'TRACE_APPLICATION_MISMATCH',
          'Trace observation is outside goal scope',
        );
    }
  const suppliedOutcomes = new Set(
    traces
      .filter((trace) => trace.terminal.kind === 'businessOutcome')
      .map((trace) => (trace.terminal as { code: string }).code),
  );
  for (const code of suppliedOutcomes)
    if (!goal.goal.businessOutcomes.some((outcome) => outcome.code === code))
      throw new CompilationError('TRACE_OUTCOME_UNDECLARED', `Outcome ${code} is undeclared`);
  for (const trace of traces.filter((item) => item.terminal.kind === 'businessOutcome')) {
    const code = (trace.terminal as { code: string }).code;
    const declared = goal.goal.businessOutcomes.find((outcome) => outcome.code === code)!;
    const evidence = trace.events.find(
      (event) => event.eventType === 'business_outcome' && event.data.code === code,
    );
    if (
      !evidence ||
      contentHash(JSON.parse(String(evidence.data.checkpointJson))) !==
        contentHash(declared.detection)
    )
      throw new CompilationError(
        'TRACE_OUTCOME_EVIDENCE_MISMATCH',
        `Outcome ${code} evidence differs from its contract`,
      );
  }
}

export class ArtifactCompiler {
  compile(
    loadedGoal: LoadedDiscoveryGoal,
    traces: readonly ValidatedTrace[],
    identity: { readonly id: string; readonly version: string },
    configuration: CompilerConfiguration = {},
  ): CompilationResult {
    validateGoalAndTraces(loadedGoal, traces);
    const primary = traces.find((trace) => trace.terminal.kind === 'success');
    if (!primary)
      throw new CompilationError('TRACE_SET_NO_SUCCESS', 'Primary successful trace missing');
    const selected = actions(primary);
    if (selected.length === 0)
      throw new CompilationError('TRACE_NO_ACTIONS', 'No successful actions found');
    if (!observedAuthenticatedTransition(selected))
      throw new CompilationError(
        'AUTHENTICATED_CHECKPOINT_MISSING',
        'No observed authenticated-state transition follows secret entry',
      );
    const start = selected[0]?.action;
    if (
      start?.kind !== 'navigate' ||
      !('kind' in start.destination) ||
      start.destination.kind !== 'absoluteUrl' ||
      start.destination.url !== loadedGoal.goal.startUrl
    )
      throw new CompilationError(
        'START_ACTION_MISMATCH',
        'Observed start action differs from goal entry point',
      );
    const observedFinal = new Set(
      primary.events
        .filter(
          (event) =>
            event.eventType === 'checkpoint_candidate' &&
            event.data.final === true &&
            event.data.passed === true,
        )
        .map((event) => contentHash(JSON.parse(String(event.data.checkpointJson)))),
    );
    if (
      loadedGoal.goal.successCriteria.some(
        (checkpoint) => !observedFinal.has(contentHash(checkpoint)),
      )
    )
      throw new CompilationError(
        'SUCCESS_EVIDENCE_MISMATCH',
        'Observed final checkpoints differ from goal success criteria',
      );
    const repeats = traces.filter(
      (trace) => trace !== primary && trace.terminal.kind === 'success',
    );
    const steps: CapabilityStepType[] = selected.map((item, index) => {
      const fallbackIndexes = repeats
        .map((trace) => actions(trace)[index])
        .filter((other) => other?.action.kind === item.action.kind)
        .flatMap((other) => (other?.resolvedIndex === undefined ? [] : [other.resolvedIndex]));
      const action = normalizedAction(item, fallbackIndexes);
      const id = `step-${String(index + 1).padStart(3, '0')}-${action.kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      const postUrl = item.postObservation?.url;
      const checkpoint = checkpointFor(action, postUrl);
      const retry = action.kind === 'navigate' && traces.length > 1;
      return {
        id,
        description: `Replay the observed ${action.kind} action.`,
        action,
        risk:
          item.risk === 'prohibited'
            ? 'irreversibleWrite'
            : action.kind === 'enterText'
              ? 'reversibleWrite'
              : 'read',
        timeoutMs: configuration.timeoutMs ?? 15_000,
        checkpoint,
        recovery: retry
          ? {
              kind: 'retry',
              maxAttempts: Math.min(configuration.navigationRetryAttempts ?? 2, 3),
              retryableErrorCodes: ['NAVIGATION_TIMEOUT'],
              backoff: { kind: 'fixed', delayMs: 250 },
              idempotent: true,
            }
          : { kind: 'none' },
      };
    });
    if (steps.some((step) => step.risk === 'irreversibleWrite'))
      throw new CompilationError(
        'RETRY_SAFETY_AMBIGUOUS',
        'Trace contains a prohibited-risk action',
      );
    const extracted = new Set(
      steps
        .filter((step) => step.action.kind === 'extract')
        .map((step) => (step.action as { output: string }).output),
    );
    for (const output of Object.keys(loadedGoal.goal.outputs))
      if (!extracted.has(output))
        throw new CompilationError(
          'OUTPUT_EXTRACTOR_MISSING',
          `Output ${output} lacks an observed extractor`,
        );
    const firstObservation = primary.events.map(traceObservation).find(Boolean);
    if (!firstObservation)
      throw new CompilationError('OBSERVATION_MISSING', 'Trace lacks an observation');
    const success: CheckpointType = {
      kind: 'all',
      description: 'All declared typed outputs were observed and validated.',
      children: loadedGoal.goal.successCriteria,
    };
    const artifact = CapabilityArtifact.parse({
      schemaVersion: '1.0.0',
      id: identity.id,
      version: identity.version,
      lifecycle: 'draft',
      name: identity.id,
      description: loadedGoal.goal.objective,
      target: {
        surface: 'web',
        product: `web-${new URL(loadedGoal.goal.startUrl).hostname.replace(/[^A-Za-z0-9_.-]/g, '-')}`,
        entryPoint: { kind: 'absoluteUrl', url: loadedGoal.goal.startUrl },
        fingerprints: [
          {
            kind: 'urlPathPattern',
            id: 'observed-start-route',
            pattern: `^${escapePattern(new URL(firstObservation.url).pathname)}$`,
          },
          ...firstObservation.headings
            .filter((heading) => !heading.includes('[REDACTED]'))
            .slice(0, 2)
            .map((heading, index) => ({
              kind: 'requiredText' as const,
              id: `observed-start-heading-${index + 1}`,
              text: heading,
            })),
          ...(firstObservation.title === '(untitled)'
            ? []
            : [
                {
                  kind: 'titlePattern' as const,
                  id: 'observed-start-title',
                  pattern: `^${escapePattern(firstObservation.title)}$`,
                },
              ]),
        ],
      },
      contract: {
        inputs: loadedGoal.goal.inputs,
        requiredSecrets: loadedGoal.goal.secretReferences,
        outputs: loadedGoal.goal.outputs,
        businessOutcomes: loadedGoal.goal.businessOutcomes.filter((outcome) =>
          traces.some(
            (trace) =>
              trace.terminal.kind === 'businessOutcome' && trace.terminal.code === outcome.code,
          ),
        ),
      },
      policyRef: loadedGoal.goal.policyRef,
      preconditions: [],
      steps,
      success,
      metadata: {
        createdAt: '1970-01-01T00:00:00.000Z',
        provenance: { kind: 'discoveryRun', runId: primary.runId },
        compilerVersion: COMPILER_VERSION,
        sourceDiscoveryRunId: primary.runId,
      },
    });
    const semantic = validateArtifactSemantics(artifact);
    if (!semantic.valid)
      throw new CompilationError(
        'ARTIFACT_SEMANTIC_INVALID',
        semantic.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message)
          .join('; '),
      );
    const artifactHash = contentHash(artifact);
    const successfulProposalIds = new Set(
      selected.flatMap((item) => (item.proposalId ? [item.proposalId] : [])),
    );
    const discardedEvents = primary.events
      .filter(
        (event) =>
          (event.eventType === 'planner_proposal' ||
            event.eventType === 'action_executed' ||
            event.eventType === 'action_result' ||
            event.eventType === 'policy_decision') &&
          event.proposalId &&
          !successfulProposalIds.has(event.proposalId),
      )
      .map((event) => ({
        runId: primary.runId,
        sequence: event.sequence,
        proposalId: event.proposalId!,
        reason:
          event.eventType === 'action_result' && event.data.ok === false
            ? 'failed exploratory action'
            : event.eventType === 'action_result' && event.data.ok === true
              ? 'successful action produced no verified progress and was superseded'
              : event.eventType === 'policy_decision' && event.data.decision !== 'allow'
                ? 'policy did not allow proposal'
                : 'proposal was not part of the verified successful path',
      }));
    const warnings = semantic.issues
      .filter((issue) => issue.severity === 'warning')
      .map((issue) => issue.message);
    const providerProvenance = [
      ...new Map(
        traces.flatMap((trace) =>
          trace.events.flatMap((event) =>
            event.eventType === 'planner_proposal' &&
            typeof event.data.provider === 'string' &&
            typeof event.data.model === 'string'
              ? [
                  [
                    `${trace.runId}|${event.data.provider}|${event.data.model}`,
                    {
                      runId: trace.runId,
                      provider: event.data.provider,
                      model: event.data.model,
                    },
                  ] as const,
                ]
              : [],
          ),
        ),
      ).values(),
    ].sort((left, right) =>
      `${left.runId}|${left.provider}|${left.model}`.localeCompare(
        `${right.runId}|${right.provider}|${right.model}`,
      ),
    );
    const manifest: CompilationManifest = {
      schemaVersion: '1.0.0',
      compiler: { name: COMPILER_NAME, version: COMPILER_VERSION },
      artifact: { id: artifact.id, version: artifact.version, hash: artifactHash },
      goal: {
        id: loadedGoal.goal.id,
        version: loadedGoal.goal.version,
        hash: loadedGoal.contentHash,
      },
      discoveryRunIds: traces.map((trace) => trace.runId).sort(),
      traceHashes: traces.map((trace) => trace.traceHash).sort(),
      providerProvenance,
      policies: [
        {
          id: primary.policyId,
          version: primary.policyVersion,
          hash: primary.policyHash,
        },
      ],
      schemaVersions: {
        goal: loadedGoal.goal.schemaVersion,
        trace: '1.0.0',
        artifact: artifact.schemaVersion,
        manifest: '1.0.0',
      },
      compiledAt: configuration.compilationTime ?? new Date().toISOString(),
      selectedSteps: selected.map((item, index) => ({
        stepId: steps[index]!.id,
        runId: primary.runId,
        ...(item.proposalId ? { proposalId: item.proposalId } : {}),
        eventSequence: item.eventSequence,
      })),
      discardedEvents,
      locatorSelections: steps.flatMap((step) =>
        'target' in step.action && step.action.target
          ? [
              {
                stepId: step.id,
                selectedStrategies: step.action.target.candidates.map(
                  (candidate) => candidate.strategy,
                ),
                reason:
                  step.action.kind === 'extract'
                    ? 'Literal output-value locators were replaced by observed table-header and column structure.'
                    : 'The resolved locator and independent stable candidates issued by the same observation were ranked semantically.',
              },
            ]
          : [],
      ),
      warnings,
      result: 'draft',
    };
    return {
      artifact,
      artifactBytes: canonicalJsonFile(artifact),
      artifactHash,
      manifest,
      diagnostics: [
        {
          severity: 'info',
          code: 'DEAD_ENDS_REMOVED',
          message: `${discardedEvents.length} exploratory events were excluded.`,
        },
      ],
    };
  }
}
