import { z } from 'zod';

import { Checkpoint } from './checkpoints.js';
import { EvidenceReference } from './evidence.js';
import { Identifier, NonEmptyString, Timestamp } from './primitives.js';
import { DataShape } from './data-shapes.js';

const ObservationElement = z.strictObject({
  reference: Identifier,
  role: NonEmptyString.max(128).optional(),
  name: NonEmptyString.max(256).optional(),
  text: NonEmptyString.max(512).optional(),
  framePath: z.array(Identifier).max(4),
  tagName: Identifier.optional(),
  inputType: Identifier.optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  editable: z.boolean().optional(),
  boundingBox: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    })
    .optional(),
});

const DiscoveryCoordinate = z.strictObject({
  observationId: Identifier,
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const DiscoveryAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('activate'), elementReference: Identifier }),
  z.strictObject({
    kind: z.literal('enterText'),
    elementReference: Identifier,
    text: NonEmptyString.max(512),
    clear: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('navigate'),
    route: z.string().regex(/^\/[A-Za-z0-9_./?=&-]{0,255}$/),
  }),
  z.strictObject({ kind: z.literal('coordinateClick'), coordinate: DiscoveryCoordinate }),
]);

/** Structured response returned by the future discovery model adapter. */
export const DiscoveryDecision = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('action'),
    reason: NonEmptyString.max(512),
    action: DiscoveryAction,
  }),
  z.strictObject({
    kind: z.literal('complete'),
    summary: NonEmptyString.max(512),
    candidateOutputs: z.record(Identifier, DataShape),
    successEvidence: Checkpoint,
  }),
  z.strictObject({
    kind: z.literal('requestHuman'),
    reasonCode: z.enum([
      'repeatedNoProgress',
      'ambiguousTarget',
      'unknownDialog',
      'checkpointFailure',
      'policyApproval',
      'riskyAction',
      'manualTestInjection',
      'unknownFailure',
    ]),
    explanation: NonEmptyString.max(512),
    currentStateSummary: NonEmptyString.max(512),
  }),
]);

export const DiscoveryObservation = z.strictObject({
  observationId: Identifier,
  capturedAt: Timestamp,
  url: NonEmptyString.max(1024),
  title: NonEmptyString.max(256),
  elements: z.array(ObservationElement).max(200),
  evidence: z.array(EvidenceReference).max(8),
});

export type DiscoveryDecisionType = z.infer<typeof DiscoveryDecision>;
export type DiscoveryObservationType = z.infer<typeof DiscoveryObservation>;
