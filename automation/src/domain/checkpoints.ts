import { z } from 'zod';

import { Identifier, NonEmptyString } from './primitives.js';
import { TargetDescriptor } from './locators.js';

const CheckpointBase = { description: NonEmptyString.max(256) };

/** Inferred checkpoint data; runtime parsing supplies the discriminated detail. */
export interface CheckpointType {
  readonly kind: string;
  readonly description: string;
  readonly output?: string;
  readonly children?: readonly CheckpointType[];
  readonly child?: CheckpointType;
}

/** Closed state assertions; nesting is bounded to two levels for finite schemas. */
function checkpointSchema(depth: number): z.ZodTypeAny {
  const nested = depth > 0 ? checkpointSchema(depth - 1) : z.never();
  return z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('urlMatches'),
      ...CheckpointBase,
      pattern: NonEmptyString.max(512),
    }),
    z.strictObject({
      kind: z.literal('titleMatches'),
      ...CheckpointBase,
      pattern: NonEmptyString.max(256),
    }),
    z.strictObject({
      kind: z.literal('elementVisible'),
      ...CheckpointBase,
      target: TargetDescriptor,
    }),
    z.strictObject({
      kind: z.literal('elementAbsent'),
      ...CheckpointBase,
      target: TargetDescriptor,
    }),
    z.strictObject({
      kind: z.literal('textPresent'),
      ...CheckpointBase,
      text: NonEmptyString.max(512),
    }),
    z.strictObject({
      kind: z.literal('textAbsent'),
      ...CheckpointBase,
      text: NonEmptyString.max(512),
    }),
    z.strictObject({
      kind: z.literal('valueEquals'),
      ...CheckpointBase,
      target: TargetDescriptor,
      value: NonEmptyString.max(512),
    }),
    z.strictObject({ kind: z.literal('outputPresent'), ...CheckpointBase, output: Identifier }),
    z.strictObject({
      kind: z.literal('outputMatchesShape'),
      ...CheckpointBase,
      output: Identifier,
    }),
    z.strictObject({
      kind: z.literal('applicationFingerprint'),
      ...CheckpointBase,
      fingerprintId: Identifier,
    }),
    z.strictObject({
      kind: z.literal('all'),
      ...CheckpointBase,
      children: z.array(nested).min(1).max(8),
    }),
    z.strictObject({
      kind: z.literal('any'),
      ...CheckpointBase,
      children: z.array(nested).min(1).max(8),
    }),
    z.strictObject({ kind: z.literal('not'), ...CheckpointBase, child: nested }),
  ]);
}

export const Checkpoint = checkpointSchema(2) as z.ZodType<CheckpointType>;
