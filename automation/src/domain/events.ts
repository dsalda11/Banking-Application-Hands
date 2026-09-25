import { z } from 'zod';

import { Checkpoint } from './checkpoints.js';
import { DiscoveryDecision, DiscoveryObservation } from './discovery.js';
import { ErrorDetail } from './errors.js';
import { EvidenceReference } from './evidence.js';
import { ControlOwner, InterventionReason } from './intervention.js';
import { CapabilityAction } from './actions.js';
import { Identifier, JsonValue, NonEmptyString, Timestamp } from './primitives.js';

const EventBase = {
  schemaVersion: z.literal('1.0.0'),
  eventId: Identifier,
  runId: Identifier,
  sequence: z.number().int().min(0).max(1_000_000),
  timestamp: Timestamp,
};

const Event = <T extends z.ZodTypeAny>(eventType: string, payload: T) =>
  z.strictObject({ ...EventBase, eventType: z.literal(eventType), payload });

/** Append-only sanitized discovery/replay trace event. */
export const DiscoveryEvent = z.discriminatedUnion('eventType', [
  Event(
    'runStarted',
    z.strictObject({
      mode: z.enum(['discovery', 'replay']),
      goal: NonEmptyString.max(512),
      artifactId: Identifier.optional(),
    }),
  ),
  Event('observationCaptured', z.strictObject({ observation: DiscoveryObservation })),
  Event(
    'modelDecisionRecorded',
    z.strictObject({ decision: DiscoveryDecision, reason: NonEmptyString.max(512) }),
  ),
  Event(
    'actionStarted',
    z.strictObject({
      stepId: Identifier.optional(),
      action: CapabilityAction,
      attempt: z.number().int().min(1).max(3),
    }),
  ),
  Event(
    'actionCompleted',
    z.strictObject({
      stepId: Identifier.optional(),
      attempt: z.number().int().min(1).max(3),
      resolvedTarget: NonEmptyString.max(256).optional(),
      sanitizedFacts: z.record(Identifier, JsonValue).optional(),
      evidence: z.array(EvidenceReference).max(8),
    }),
  ),
  Event(
    'actionFailed',
    z.strictObject({
      stepId: Identifier.optional(),
      error: ErrorDetail,
      evidence: z.array(EvidenceReference).max(8),
    }),
  ),
  Event(
    'checkpointEvaluated',
    z.strictObject({
      stepId: Identifier.optional(),
      checkpoint: Checkpoint,
      passed: z.boolean(),
      observed: JsonValue.optional(),
      evidence: z.array(EvidenceReference).max(8),
    }),
  ),
  Event(
    'interventionRequested',
    z.strictObject({
      interventionId: Identifier,
      reasonCode: InterventionReason,
      controlOwner: ControlOwner,
      evidence: z.array(EvidenceReference).max(8),
    }),
  ),
  Event(
    'controlTransferred',
    z.strictObject({ interventionId: Identifier, from: ControlOwner, to: ControlOwner }),
  ),
  Event(
    'runCompleted',
    z.strictObject({
      resultStatus: z.enum(['success', 'businessOutcome', 'needsHuman']),
      evidence: z.array(EvidenceReference).max(8),
    }),
  ),
  Event(
    'runFailed',
    z.strictObject({ error: ErrorDetail, evidence: z.array(EvidenceReference).max(8) }),
  ),
]);

export type DiscoveryEventType = z.infer<typeof DiscoveryEvent>;
