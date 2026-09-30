import { z } from 'zod';

import { Checkpoint } from './checkpoints.js';
import { Identifier, NonEmptyString } from './primitives.js';
import { TargetDescriptor } from './locators.js';
import { ValueSource } from './values.js';

export const RecoveryPolicy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('retry'),
    maxAttempts: z.number().int().min(1).max(5),
    retryableErrorCodes: z.array(Identifier).min(1).max(8),
    backoff: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('fixed'), delayMs: z.number().int().min(0).max(10000) }),
      z.strictObject({
        kind: z.literal('exponential'),
        initialDelayMs: z.number().int().min(0).max(5000),
        maxDelayMs: z.number().int().min(0).max(10000),
      }),
    ]),
    idempotent: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal('reauthenticate'),
    maxAttempts: z.literal(1),
    sessionExpired: Checkpoint,
    steps: z
      .array(z.lazy(() => RecoveryStep))
      .min(1)
      .max(16),
    checkpoint: Checkpoint,
  }),
  z.strictObject({ kind: z.literal('escalateToHuman'), reason: NonEmptyString.max(256) }),
]);

export const Transform = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('identity') }),
  z.strictObject({ kind: z.literal('trim') }),
  z.strictObject({ kind: z.literal('normalizeWhitespace') }),
  z.strictObject({ kind: z.literal('parseIntegerString') }),
  z.strictObject({ kind: z.literal('parseDecimalString') }),
  z.strictObject({ kind: z.literal('amountWithCurrency'), currency: z.literal('USD') }),
]);

const Destination = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('relativeRoute'),
    route: z.string().regex(/^\/[A-Za-z0-9_./?=&-]{0,255}$/),
  }),
  z.strictObject({ kind: z.literal('absoluteUrl'), url: z.string().url() }),
]);

/** Surface-neutral action vocabulary interpreted by future adapters. */
export const CapabilityAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigate'), destination: z.union([Destination, ValueSource]) }),
  z.strictObject({ kind: z.literal('activate'), target: TargetDescriptor }),
  z.strictObject({
    kind: z.literal('enterText'),
    target: TargetDescriptor,
    value: ValueSource,
    clear: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('selectOption'), target: TargetDescriptor, value: ValueSource }),
  z.strictObject({
    kind: z.literal('pressKey'),
    target: TargetDescriptor.optional(),
    key: z.enum([
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Backspace',
    ]),
  }),
  z
    .strictObject({
      kind: z.literal('scroll'),
      target: TargetDescriptor.optional(),
      direction: z.enum(['up', 'down']),
      amount: z.number().int().min(1).max(1000).optional(),
    })
    .refine((value) => value.target || value.amount, 'scroll needs a target or amount'),
  z.strictObject({ kind: z.literal('wait'), condition: Checkpoint }),
  z.strictObject({
    kind: z.literal('extract'),
    output: Identifier,
    target: TargetDescriptor,
    transform: Transform,
  }),
]);

export const RecoveryStep = z.strictObject({
  id: Identifier,
  description: NonEmptyString.max(256),
  action: CapabilityAction,
  timeoutMs: z.number().int().min(1).max(120000),
  checkpoint: Checkpoint,
});
export type RecoveryStepType = z.infer<typeof RecoveryStep>;

export const RiskClassification = z.enum(['read', 'reversibleWrite', 'irreversibleWrite']);

export const CapabilityStep = z.strictObject({
  id: Identifier,
  description: NonEmptyString.max(256),
  action: CapabilityAction,
  risk: RiskClassification,
  timeoutMs: z.number().int().min(1).max(120000),
  checkpoint: Checkpoint,
  recovery: RecoveryPolicy,
});

export type RecoveryPolicyType = z.infer<typeof RecoveryPolicy>;
export type TransformType = z.infer<typeof Transform>;
export type CapabilityActionType = z.infer<typeof CapabilityAction>;
export type CapabilityStepType = z.infer<typeof CapabilityStep>;
