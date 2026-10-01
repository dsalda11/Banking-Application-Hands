import { z } from 'zod';

import { Checkpoint } from './checkpoints.js';
import { DataShape } from './data-shapes.js';
import { EvidenceReference } from './evidence.js';
import { LocatorCandidate } from './locators.js';
import { BusinessOutcome } from './outcomes.js';
import { Identifier, JsonValue, NonEmptyString, SemanticVersion, Timestamp } from './primitives.js';

const ObservationElement = z.strictObject({
  reference: Identifier,
  role: NonEmptyString.max(128).optional(),
  name: NonEmptyString.max(256).optional(),
  text: NonEmptyString.max(512).optional(),
  framePath: z.array(Identifier).max(4),
  frameId: Identifier,
  frameLocatorCandidates: z.array(LocatorCandidate).min(1).max(4).optional(),
  tagName: Identifier.optional(),
  inputType: Identifier.optional(),
  visible: z.boolean(),
  enabled: z.boolean(),
  editable: z.boolean(),
  locatorCandidates: z.array(LocatorCandidate).min(1).max(4),
  boundingBox: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    })
    .optional(),
});

export const DiscoveryObservation = z.strictObject({
  observationId: Identifier,
  capturedAt: Timestamp,
  url: NonEmptyString.max(1024),
  title: NonEmptyString.max(256),
  headings: z.array(NonEmptyString.max(256)).max(24),
  visibleText: z.array(NonEmptyString.max(512)).max(80),
  elements: z.array(ObservationElement).max(120),
  frames: z.array(z.strictObject({ id: Identifier, url: NonEmptyString.max(1024) })).max(8),
  scroll: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  stateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  screenshot: EvidenceReference.optional(),
  evidence: z.array(EvidenceReference).max(8),
});

const GoalValueSpec = z.strictObject({ description: NonEmptyString.max(256), shape: DataShape });
export const DiscoveryGoal = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  id: Identifier,
  version: SemanticVersion,
  objective: NonEmptyString.max(1024),
  startUrl: z.string().url(),
  inputs: z.record(Identifier, GoalValueSpec),
  secretReferences: z.array(Identifier).max(16),
  outputs: z.record(Identifier, GoalValueSpec),
  successCriteria: z.array(Checkpoint).min(1).max(8),
  businessOutcomes: z.array(BusinessOutcome).max(16),
  applicationScope: z.strictObject({
    allowedOrigins: z.array(z.string().url()).min(1).max(8),
    allowedRoutePatterns: z.array(NonEmptyString.max(256)).min(1).max(32),
  }),
  budgets: z.strictObject({
    maxModelCalls: z.number().int().min(1).max(200),
    maxActions: z.number().int().min(1).max(200),
    timeoutMs: z.number().int().min(1000).max(3_600_000),
    maxRepeatedStates: z.number().int().min(1).max(20),
    maxConsecutiveFailures: z.number().int().min(1).max(20),
    maxNavigations: z.number().int().min(1).max(50),
  }),
  allowHumanIntervention: z.boolean(),
  screenshotPolicy: z.enum(['disabled', 'sanitized']),
  policyRef: Identifier,
});

const ProposalBase = {
  proposalId: Identifier,
  observationId: Identifier,
  stateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rationale: NonEmptyString.max(240),
  expectedPostcondition: NonEmptyString.max(256),
  confidence: z.number().min(0).max(1).optional(),
};
const elementAction = { ...ProposalBase, elementReference: Identifier };
export const DiscoveryProposal = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), ...elementAction }),
  z.strictObject({ kind: z.literal('enterInput'), ...elementAction, inputName: Identifier }),
  z.strictObject({ kind: z.literal('enterSecret'), ...elementAction, secretName: Identifier }),
  z.strictObject({ kind: z.literal('navigate'), ...ProposalBase, url: z.string().url() }),
  z.strictObject({
    kind: z.literal('pressKey'),
    ...ProposalBase,
    elementReference: Identifier.optional(),
    key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']),
  }),
  z.strictObject({
    kind: z.literal('scroll'),
    ...ProposalBase,
    direction: z.enum(['up', 'down']),
    amount: z.number().int().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal('extract'),
    ...elementAction,
    outputName: Identifier,
    transform: z.enum([
      'identity',
      'trim',
      'normalizeWhitespace',
      'parseIntegerString',
      'parseDecimalString',
      'amountUsd',
    ]),
  }),
  z.strictObject({ kind: z.literal('assertCheckpoint'), ...ProposalBase, checkpoint: Checkpoint }),
  z.strictObject({
    kind: z.literal('reportBusinessOutcome'),
    ...ProposalBase,
    outcomeCode: Identifier,
  }),
  z.strictObject({ kind: z.literal('finish'), ...ProposalBase }),
  z.strictObject({
    kind: z.literal('requestHuman'),
    ...ProposalBase,
    reason: NonEmptyString.max(256),
  }),
  z.strictObject({
    kind: z.literal('stopSafely'),
    ...ProposalBase,
    reason: NonEmptyString.max(256),
  }),
]);

export const DiscoveryBudgetsRemaining = z.strictObject({
  modelCalls: z.number().int().min(0),
  actions: z.number().int().min(0),
  timeMs: z.number().int().min(0),
});

export const DiscoveryTraceEvent = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  eventId: Identifier,
  runId: Identifier,
  goalId: Identifier,
  goalVersion: SemanticVersion,
  policyId: Identifier,
  policyVersion: SemanticVersion,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().min(1),
  timestamp: Timestamp,
  step: z.number().int().min(0),
  eventType: z.enum([
    'run_started',
    'observation',
    'planner_request',
    'planner_proposal',
    'proposal_validated',
    'policy_decision',
    'action_executed',
    'action_result',
    'checkpoint_candidate',
    'output_candidate',
    'business_outcome',
    'intervention',
    'stopping_condition',
    'run_completed',
  ]),
  stateFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  proposalId: Identifier.optional(),
  budgetsRemaining: DiscoveryBudgetsRemaining,
  data: z.record(z.string().max(64), JsonValue),
});

export const DiscoveryResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    runId: Identifier,
    outputs: z.record(Identifier, JsonValue),
    modelCalls: z.number().int().min(0),
    actions: z.number().int().min(0),
  }),
  z.strictObject({
    status: z.literal('businessOutcome'),
    runId: Identifier,
    outcome: Identifier,
    modelCalls: z.number().int().min(0),
    actions: z.number().int().min(0),
  }),
  z.strictObject({
    status: z.literal('stopped'),
    runId: Identifier,
    code: z.enum([
      'POLICY_DENIED',
      'MODEL_CALL_BUDGET_EXHAUSTED',
      'ACTION_BUDGET_EXHAUSTED',
      'DISCOVERY_TIMEOUT',
      'REPEATED_STATE',
      'CONSECUTIVE_FAILURES',
      'STALE_OBSERVATION',
      'PROVIDER_FAILURE',
      'STOPPED_SAFELY',
      'INTERVENTION_REQUIRED',
      'ABORTED_BY_HUMAN',
      'INTERVENTION_TIMEOUT',
      'BROWSER_SESSION_LOST',
      'CANCELLED',
    ]),
    reason: NonEmptyString.max(512),
    modelCalls: z.number().int().min(0),
    actions: z.number().int().min(0),
  }),
]);

export const DiscoveryDecision = DiscoveryProposal;
export type DiscoveryGoalType = z.infer<typeof DiscoveryGoal>;
export type DiscoveryProposalType = z.infer<typeof DiscoveryProposal>;
export type DiscoveryObservationType = z.infer<typeof DiscoveryObservation>;
export type DiscoveryTraceEventType = z.infer<typeof DiscoveryTraceEvent>;
export type DiscoveryResultType = z.infer<typeof DiscoveryResult>;
export type DiscoveryDecisionType = DiscoveryProposalType;
