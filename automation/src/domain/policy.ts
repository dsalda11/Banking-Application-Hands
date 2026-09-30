import { z } from 'zod';
import { Identifier, NonEmptyString, SemanticVersion, Timestamp } from './primitives.js';

export const PolicyActionKind = z.enum([
  'navigate',
  'activate',
  'enterText',
  'selectOption',
  'pressKey',
  'scroll',
  'wait',
  'extract',
]);
export const PolicyRisk = z.enum([
  'read',
  'input',
  'navigation',
  'authentication',
  'consequential',
  'prohibited',
]);

export const ReplayPolicy = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  id: Identifier,
  version: SemanticVersion,
  description: NonEmptyString.max(512),
  allowedOrigins: z.array(z.string().url()).min(1).max(16),
  allowedRoutes: z
    .array(z.strictObject({ id: Identifier, pattern: NonEmptyString.max(512) }))
    .max(64),
  allowedActions: z.array(PolicyActionKind).max(16),
  deniedActions: z.array(PolicyActionKind).max(16),
  riskByAction: z.record(PolicyActionKind, PolicyRisk),
  allowedSecretReferences: z.array(Identifier).max(32),
  allowedSecretStepIds: z.array(Identifier).max(32),
  screenshotRules: z.strictObject({
    enabled: z.boolean(),
    forbidWhileSecretFieldPopulated: z.literal(true),
  }),
  traceRules: z.strictObject({ enabled: z.boolean(), startAfterAuthentication: z.literal(true) }),
  navigation: z.strictObject({
    allowExternal: z.literal(false),
    maxNavigations: z.number().int().min(1).max(100),
  }),
  downloads: z.literal('deny'),
  uploads: z.literal('deny'),
  maxReplayDurationMs: z.number().int().min(1000).max(3_600_000),
  maxActionAttempts: z.number().int().min(1).max(10),
  authenticationRecovery: z.strictObject({ allowed: z.boolean(), maxAttempts: z.literal(1) }),
  interventionActions: z.array(PolicyActionKind).max(16),
  defaultDecision: z.literal('deny'),
  metadata: z.strictObject({ createdAt: Timestamp }),
});

export type ReplayPolicyType = z.infer<typeof ReplayPolicy>;
export type PolicyActionKindType = z.infer<typeof PolicyActionKind>;
export type PolicyRiskType = z.infer<typeof PolicyRisk>;
