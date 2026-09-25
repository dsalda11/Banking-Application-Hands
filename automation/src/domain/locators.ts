import { z } from 'zod';

import { EvidenceReference } from './evidence.js';
import { Identifier, NonEmptyString } from './primitives.js';

/** A locator value may be static or bound to a declared invocation input. */
export const LocatorValueSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: NonEmptyString.max(512) }),
  z.strictObject({ kind: z.literal('input'), name: Identifier }),
]);

const LocatorText = {
  text: LocatorValueSource,
  exact: z.boolean().optional(),
};

/** Provider-neutral locator candidate; it contains no executable selector code. */
export const LocatorCandidate = z.discriminatedUnion('strategy', [
  z.strictObject({
    strategy: z.literal('role'),
    role: NonEmptyString.max(128),
    name: LocatorValueSource.optional(),
    exact: z.boolean().optional(),
  }),
  z.strictObject({ strategy: z.literal('label'), ...LocatorText }),
  z.strictObject({ strategy: z.literal('text'), ...LocatorText }),
  z.strictObject({
    strategy: z.literal('attribute'),
    name: Identifier,
    value: LocatorValueSource,
  }),
  z.strictObject({ strategy: z.literal('css'), selector: NonEmptyString.max(512) }),
  z.strictObject({ strategy: z.literal('xpath'), expression: NonEmptyString.max(512) }),
  z
    .strictObject({
      strategy: z.literal('accessibility'),
      role: NonEmptyString.max(128).optional(),
      name: LocatorValueSource.optional(),
    })
    .refine(
      (value) => Boolean(value.role || value.name),
      'accessibility locator needs role or name',
    ),
  z.strictObject({
    strategy: z.literal('visualAnchor'),
    evidence: EvidenceReference,
    anchorName: NonEmptyString.max(128),
    threshold: z.number().min(0.5).max(1),
  }),
]);

/** Ordered, scoped locator bundle used by a replay action. */
export const TargetDescriptor = z.strictObject({
  description: NonEmptyString.max(256),
  framePath: z.array(LocatorCandidate).max(4).optional(),
  scope: z.array(LocatorCandidate).max(4).optional(),
  candidates: z.array(LocatorCandidate).min(1).max(8),
  match: z.enum(['exactlyOne', 'firstVisible']),
});

export type LocatorCandidateType = z.infer<typeof LocatorCandidate>;
export type TargetDescriptorType = z.infer<typeof TargetDescriptor>;
export type LocatorValueSourceType = z.infer<typeof LocatorValueSource>;
