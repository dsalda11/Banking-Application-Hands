import { z } from 'zod';

import { EvidenceReference } from './evidence.js';
import { Identifier, JsonValue, NonEmptyString, Timestamp } from './primitives.js';

export const ControlOwner = z.enum(['automation', 'human', 'none']);
export const InterventionStatus = z.enum([
  'requested',
  'humanActive',
  'resuming',
  'resolved',
  'aborted',
]);
export const InterventionReason = z.enum([
  'repeatedNoProgress',
  'ambiguousTarget',
  'unknownDialog',
  'checkpointFailure',
  'policyApproval',
  'riskyAction',
  'manualTestInjection',
  'unknownFailure',
]);

/** Same-session handoff request with sanitized state only. */
export const InterventionRequest = z.strictObject({
  interventionId: Identifier,
  runId: Identifier,
  artifactId: Identifier.optional(),
  artifactVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  currentStepId: Identifier.optional(),
  capabilitySummary: NonEmptyString.max(512),
  reasonCode: InterventionReason,
  explanation: NonEmptyString.max(512),
  currentUrl: z.string().url().optional(),
  surfaceIdentity: NonEmptyString.max(256).optional(),
  expectedState: JsonValue.optional(),
  observedState: JsonValue.optional(),
  recentActions: z.array(NonEmptyString.max(256)).max(8),
  evidence: z.array(EvidenceReference).max(16),
  requestedAt: Timestamp,
  controlOwner: ControlOwner,
  status: InterventionStatus,
  suggestedResumeBehavior: NonEmptyString.max(512),
});

export type InterventionRequestType = z.infer<typeof InterventionRequest>;
