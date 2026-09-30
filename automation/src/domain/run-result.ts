import { z } from 'zod';

import { ErrorDetail } from './errors.js';
import { EvidenceReference } from './evidence.js';
import { Identifier, JsonValue, Timestamp } from './primitives.js';

const ResultBase = {
  runId: Identifier,
  artifactHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  evidence: z.array(EvidenceReference).max(32),
  completedAt: Timestamp,
};

/** Runtime result union distinguishing success, business outcomes, handoff, and failures. */
export const RunResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    ...ResultBase,
    artifactId: Identifier,
    artifactVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    outputs: z.record(Identifier, JsonValue),
  }),
  z.strictObject({
    status: z.literal('businessOutcome'),
    ...ResultBase,
    artifactId: Identifier,
    artifactVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    code: Identifier,
    details: z.record(Identifier, JsonValue).optional(),
  }),
  z.strictObject({
    status: z.literal('permissionDenied'),
    ...ResultBase,
    artifactId: Identifier,
    artifactVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    code: z.literal('PERMISSION_DENIED'),
    stepId: Identifier.optional(),
  }),
  z.strictObject({
    status: z.literal('needsHuman'),
    runId: Identifier,
    interventionId: Identifier,
    currentStepId: Identifier,
    reasonCode: Identifier,
    evidence: z.array(EvidenceReference).max(32),
  }),
  z.strictObject({
    status: z.literal('failure'),
    ...ResultBase,
    artifactId: Identifier.optional(),
    artifactVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    error: ErrorDetail,
  }),
]);

export type RunResultType = z.infer<typeof RunResult>;
