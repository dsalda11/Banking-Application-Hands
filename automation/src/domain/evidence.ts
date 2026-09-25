import { z } from 'zod';

import { EvidencePath, Identifier, NonEmptyString } from './primitives.js';

export const EvidenceKind = z.enum([
  'screenshot',
  'semanticSnapshot',
  'domSnapshot',
  'trace',
  'eventLog',
  'result',
  'artifact',
  'intervention',
]);

export const SanitizationStatus = z.enum(['sanitized', 'redacted', 'synthetic']);

/** Metadata pointing to evidence stored outside a domain object. */
export const EvidenceReference = z.strictObject({
  evidenceId: Identifier,
  kind: EvidenceKind,
  path: EvidencePath,
  sanitization: SanitizationStatus,
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  mediaType: NonEmptyString.max(128).optional(),
});

export type EvidenceReferenceType = z.infer<typeof EvidenceReference>;
