import { readFile } from 'node:fs/promises';
import {
  DiscoveryObservation,
  DiscoveryProposal,
  DiscoveryTraceEvent,
  type DiscoveryObservationType,
  type DiscoveryProposalType,
  type DiscoveryTraceEventType,
} from '../domain/discovery.js';
import { CapabilityAction, type CapabilityActionType } from '../domain/actions.js';
import { Checkpoint, type CheckpointType } from '../domain/checkpoints.js';
import { contentHash } from './canonical-json.js';

export type TraceTerminal =
  | { readonly kind: 'success'; readonly outputNames: readonly string[] }
  | { readonly kind: 'businessOutcome'; readonly code: string };

export interface ValidatedTrace {
  readonly path: string;
  readonly events: readonly DiscoveryTraceEventType[];
  readonly traceHash: string;
  readonly runId: string;
  readonly goalId: string;
  readonly goalVersion: string;
  readonly goalHash: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly terminal: TraceTerminal;
}

export class TraceLoadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'TraceLoadError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function forbiddenMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenMaterial);
  const record = object(value);
  if (!record) return false;
  return Object.entries(record).some(([key, child]) => {
    const normalized = key.toLowerCase();
    return (
      ['cookie', 'cookies', 'storage', 'rawdom', 'rawhtml', 'operatorToken', 'apiPayload']
        .map((item) => item.toLowerCase())
        .includes(normalized) || forbiddenMaterial(child)
    );
  });
}

function proposalMatchesAction(
  proposal: DiscoveryProposalType,
  action: CapabilityActionType,
): boolean {
  switch (proposal.kind) {
    case 'click':
      return action.kind === 'activate';
    case 'enterInput':
      return (
        action.kind === 'enterText' &&
        action.value.kind === 'input' &&
        action.value.name === proposal.inputName
      );
    case 'enterSecret':
      return (
        action.kind === 'enterText' &&
        action.value.kind === 'secret' &&
        action.value.name === proposal.secretName
      );
    case 'navigate':
      return action.kind === 'navigate';
    case 'pressKey':
      return action.kind === 'pressKey' && action.key === proposal.key;
    case 'scroll':
      return action.kind === 'scroll' && action.direction === proposal.direction;
    case 'extract':
      return action.kind === 'extract' && action.output === proposal.outputName;
    default:
      return false;
  }
}

export function traceObservation(
  event: DiscoveryTraceEventType,
): DiscoveryObservationType | undefined {
  if (event.eventType !== 'observation') return undefined;
  if (typeof event.data.observationJson !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(event.data.observationJson) as unknown;
  } catch {
    return undefined;
  }
  const parsed = DiscoveryObservation.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function traceProposal(event: DiscoveryTraceEventType): DiscoveryProposalType | undefined {
  if (event.eventType !== 'planner_proposal') return undefined;
  if (typeof event.data.proposalJson !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(event.data.proposalJson) as unknown;
  } catch {
    return undefined;
  }
  const parsed = DiscoveryProposal.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function traceAction(event: DiscoveryTraceEventType): CapabilityActionType | undefined {
  if (event.eventType !== 'action_executed') return undefined;
  if (typeof event.data.actionJson !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(event.data.actionJson) as unknown;
  } catch {
    return undefined;
  }
  const parsed = CapabilityAction.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function traceCheckpoint(event: DiscoveryTraceEventType): CheckpointType | undefined {
  if (event.eventType !== 'checkpoint_candidate' && event.eventType !== 'business_outcome')
    return undefined;
  if (typeof event.data.checkpointJson !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(event.data.checkpointJson) as unknown;
  } catch {
    return undefined;
  }
  const parsed = Checkpoint.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class DiscoveryTraceLoader {
  async load(filePath: string): Promise<ValidatedTrace> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      throw new TraceLoadError('TRACE_READ_FAILED', 'Could not read discovery trace');
    }
    if (!text.endsWith('\n'))
      throw new TraceLoadError('TRACE_TRUNCATED', 'Discovery trace must end with a newline');
    const lines = text.split('\n').slice(0, -1);
    if (lines.length === 0 || lines.some((line) => line.trim() === ''))
      throw new TraceLoadError('TRACE_TRUNCATED', 'Discovery trace contains an empty record');
    const events = lines.map((line, index) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        throw new TraceLoadError('TRACE_MALFORMED_JSONL', 'Malformed JSONL record', index + 1);
      }
      if (object(raw)?.schemaVersion !== '1.0.0')
        throw new TraceLoadError(
          'UNSUPPORTED_TRACE_VERSION',
          'Unsupported trace version',
          index + 1,
        );
      const parsed = DiscoveryTraceEvent.safeParse(raw);
      if (!parsed.success)
        throw new TraceLoadError(
          'TRACE_EVENT_INVALID',
          'Unknown or malformed trace event',
          index + 1,
        );
      return parsed.data;
    });
    return this.validate(filePath, events);
  }

  validate(path: string, events: readonly DiscoveryTraceEventType[]): ValidatedTrace {
    if (events.length === 0 || events[0]?.eventType !== 'run_started')
      throw new TraceLoadError('TRACE_ORDER_INVALID', 'Trace must start with run_started');
    const first = events[0]!;
    const identity = `${first.runId}|${first.goalId}|${first.goalVersion}|${first.policyId}|${first.policyVersion}|${first.policyHash}`;
    const eventIds = new Set<string>();
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1)
        throw new TraceLoadError(
          'TRACE_SEQUENCE_INVALID',
          'Trace sequence has a gap or duplicate',
          index + 1,
        );
      if (eventIds.has(event.eventId))
        throw new TraceLoadError(
          'TRACE_SEQUENCE_INVALID',
          'Trace event ID is duplicated',
          index + 1,
        );
      eventIds.add(event.eventId);
      if (
        `${event.runId}|${event.goalId}|${event.goalVersion}|${event.policyId}|${event.policyVersion}|${event.policyHash}` !==
        identity
      )
        throw new TraceLoadError(
          'TRACE_IDENTITY_MISMATCH',
          'Run, goal, or policy identity changed',
          index + 1,
        );
      if (forbiddenMaterial(event.data))
        throw new TraceLoadError(
          'TRACE_SECRET_MATERIAL',
          'Forbidden confidential trace material',
          index + 1,
        );
      if (event.eventType === 'observation' && !traceObservation(event))
        throw new TraceLoadError(
          'TRACE_OBSERVATION_INVALID',
          'Observation evidence is missing or malformed',
          index + 1,
        );
      if (event.eventType === 'planner_proposal' && !traceProposal(event))
        throw new TraceLoadError(
          'TRACE_PROPOSAL_INVALID',
          'Validated proposal payload is missing',
          index + 1,
        );
      if (event.eventType === 'action_executed' && !traceAction(event))
        throw new TraceLoadError(
          'TRACE_ACTION_INVALID',
          'Executed action payload is missing',
          index + 1,
        );
    }
    if (events.slice(1).some((event) => event.eventType === 'run_started'))
      throw new TraceLoadError('TRACE_ORDER_INVALID', 'Trace contains multiple run_started events');
    if (
      events
        .slice(0, -1)
        .some(
          (event) =>
            event.eventType === 'run_completed' || event.eventType === 'stopping_condition',
        )
    )
      throw new TraceLoadError('TRACE_ORDER_INVALID', 'Terminal event occurs before end of trace');
    let interventionOpen = false;
    for (const event of events) {
      if (event.eventType === 'intervention' && event.data.phase === 'paused')
        interventionOpen = true;
      if (event.eventType === 'intervention' && event.data.phase === 'resumed')
        interventionOpen = false;
    }
    if (interventionOpen)
      throw new TraceLoadError(
        'TRACE_INTERVENTION_UNRESOLVED',
        'Trace contains unresolved intervention',
      );
    for (const event of events.filter(
      (candidate) => candidate.eventType === 'action_result' && candidate.data.ok === true,
    )) {
      const executed = [...events]
        .reverse()
        .find(
          (candidate) =>
            candidate.sequence < event.sequence &&
            candidate.eventType === 'action_executed' &&
            candidate.proposalId === event.proposalId,
        );
      const action = executed ? traceAction(executed) : undefined;
      if (!action)
        throw new TraceLoadError(
          'TRACE_ACTION_UNEXECUTED',
          'Successful result lacks executed action',
        );
      const proposalEvent = executed?.proposalId
        ? [...events]
            .reverse()
            .find(
              (candidate) =>
                candidate.sequence < executed.sequence &&
                candidate.eventType === 'planner_proposal' &&
                candidate.proposalId === executed.proposalId,
            )
        : undefined;
      const proposal = proposalEvent ? traceProposal(proposalEvent) : undefined;
      if (executed?.proposalId && (!proposal || !proposalMatchesAction(proposal, action)))
        throw new TraceLoadError(
          'TRACE_ACTION_PROPOSAL_MISMATCH',
          'Executed action differs from its validated proposal',
        );
      if ('target' in action && action.target) {
        const index = event.data.locatorCandidateIndex;
        const strategy = event.data.locatorStrategy;
        if (
          typeof index !== 'number' ||
          index < 0 ||
          index >= action.target.candidates.length ||
          action.target.candidates[index]?.strategy !== strategy
        )
          throw new TraceLoadError(
            'TRACE_LOCATOR_PROVENANCE_INVALID',
            'Resolved locator provenance is invalid',
          );
        if (executed?.proposalId) {
          const observationEvent = [...events]
            .reverse()
            .find(
              (candidate) =>
                candidate.sequence < executed.sequence && candidate.eventType === 'observation',
            );
          const observation = observationEvent ? traceObservation(observationEvent) : undefined;
          const reference =
            proposal && 'elementReference' in proposal ? proposal.elementReference : undefined;
          const element = observation?.elements.find(
            (candidate) => candidate.reference === reference,
          );
          if (
            !element ||
            contentHash(action.target.candidates) !== contentHash(element.locatorCandidates) ||
            contentHash(action.target.framePath ?? []) !==
              contentHash(element.frameLocatorCandidates ?? [])
          )
            throw new TraceLoadError(
              'TRACE_LOCATOR_PROVENANCE_INVALID',
              'Executed target was not issued by the referenced observation',
            );
        }
      }
    }
    const retainedText = JSON.stringify(events);
    const referencedSecrets = new Set(
      events
        .map(traceAction)
        .filter(
          (action): action is Extract<CapabilityActionType, { kind: 'enterText' }> =>
            action?.kind === 'enterText' && action.value.kind === 'secret',
        )
        .map((action) => (action.value as { kind: 'secret'; name: string }).name),
    );
    for (const name of referencedSecrets) {
      const value = process.env[name];
      if (value && value.length >= 3 && retainedText.includes(value))
        throw new TraceLoadError(
          'TRACE_SECRET_MATERIAL',
          `Trace contains value for secret ${name}`,
        );
    }
    const terminal = events.at(-1);
    if (!terminal || !['run_completed', 'stopping_condition'].includes(terminal.eventType))
      throw new TraceLoadError('TRACE_TRUNCATED', 'Trace lacks a terminal event');
    const claimedHash = terminal.data.traceHash;
    const computedHash = contentHash(events.slice(0, -1));
    if (claimedHash !== computedHash)
      throw new TraceLoadError('TRACE_HASH_MISMATCH', 'Trace integrity hash does not match');
    if (terminal.eventType === 'stopping_condition')
      throw new TraceLoadError(
        `TRACE_${String(terminal.data.code ?? 'STOPPED')}`,
        'Stopped discovery traces are not compilable',
      );
    const goalHash = first.data.goalHash;
    if (typeof goalHash !== 'string' || !/^[a-f0-9]{64}$/.test(goalHash))
      throw new TraceLoadError('TRACE_GOAL_HASH_MISSING', 'Trace lacks a valid goal hash');
    const status = terminal.data.status;
    if (status === 'success') {
      const outputs = terminal.data.outputNames;
      if (!Array.isArray(outputs) || outputs.some((name) => typeof name !== 'string'))
        throw new TraceLoadError('TRACE_OUTPUTS_MISSING', 'Successful trace lacks output names');
      const candidates = new Set(
        events
          .filter((event) => event.eventType === 'output_candidate' && event.data.valid === true)
          .map((event) => event.data.outputName),
      );
      if (outputs.some((name) => !candidates.has(name)))
        throw new TraceLoadError('TRACE_OUTPUTS_MISSING', 'Required output was not observed');
      const finalChecks = events.filter(
        (event) =>
          event.eventType === 'checkpoint_candidate' &&
          event.data.final === true &&
          event.data.passed === true &&
          Boolean(traceCheckpoint(event)),
      );
      if (finalChecks.length === 0)
        throw new TraceLoadError('TRACE_SUCCESS_UNOBSERVED', 'Success lacks observed checkpoints');
      const finish = events.some(
        (event) =>
          traceProposal(event)?.kind === 'finish' && event.proposalId === terminal.proposalId,
      );
      if (!finish)
        throw new TraceLoadError(
          'TRACE_SUCCESS_UNEXECUTED',
          'Terminal success has no validated finish',
        );
      return {
        path,
        events,
        traceHash: computedHash,
        runId: first.runId,
        goalId: first.goalId,
        goalVersion: first.goalVersion,
        goalHash,
        policyId: first.policyId,
        policyVersion: first.policyVersion,
        policyHash: first.policyHash,
        terminal: { kind: 'success', outputNames: outputs as string[] },
      };
    }
    if (status === 'businessOutcome') {
      const code = terminal.data.code;
      const evidence = events.some(
        (event) =>
          event.eventType === 'business_outcome' &&
          event.data.code === code &&
          Boolean(traceCheckpoint(event)),
      );
      if (typeof code !== 'string' || !evidence)
        throw new TraceLoadError('TRACE_OUTCOME_UNOBSERVED', 'Business outcome lacks evidence');
      return {
        path,
        events,
        traceHash: computedHash,
        runId: first.runId,
        goalId: first.goalId,
        goalVersion: first.goalVersion,
        goalHash,
        policyId: first.policyId,
        policyVersion: first.policyVersion,
        policyHash: first.policyHash,
        terminal: { kind: 'businessOutcome', code },
      };
    }
    throw new TraceLoadError('TRACE_TERMINAL_INVALID', 'Unsupported terminal trace status');
  }

  async loadSet(paths: readonly string[]): Promise<readonly ValidatedTrace[]> {
    if (paths.length === 0)
      throw new TraceLoadError('TRACE_SET_EMPTY', 'At least one trace is required');
    const traces = await Promise.all(paths.map((path) => this.load(path)));
    const first = traces[0]!;
    for (const trace of traces.slice(1)) {
      if (
        trace.goalId !== first.goalId ||
        trace.goalVersion !== first.goalVersion ||
        trace.goalHash !== first.goalHash ||
        trace.policyId !== first.policyId ||
        trace.policyVersion !== first.policyVersion ||
        trace.policyHash !== first.policyHash
      )
        throw new TraceLoadError('TRACE_SET_INCOMPATIBLE', 'Trace set identities are incompatible');
    }
    if (!traces.some((trace) => trace.terminal.kind === 'success'))
      throw new TraceLoadError(
        'TRACE_SET_NO_SUCCESS',
        'Trace set needs a primary successful trace',
      );
    return traces;
  }
}
