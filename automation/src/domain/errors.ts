import { z } from 'zod';

import { EvidenceReference } from './evidence.js';
import { Identifier, JsonValue, NonEmptyString } from './primitives.js';

export const ErrorCategory = z.enum([
  'schema',
  'policy',
  'target',
  'timeout',
  'session',
  'permission',
  'checkpoint',
  'application',
  'internal',
]);

export const ErrorDetail = z.strictObject({
  category: ErrorCategory,
  code: Identifier,
  message: NonEmptyString.max(1024),
  stepId: Identifier.optional(),
  retryable: z.boolean(),
  expectedState: JsonValue.optional(),
  observedState: JsonValue.optional(),
  evidence: z.array(EvidenceReference).max(16),
  causeCode: Identifier.optional(),
});

export type ErrorDetailType = z.infer<typeof ErrorDetail>;
