import { z } from 'zod';

import { EntryPoint, Fingerprint } from './artifact.js';
import { TargetDescriptor } from './locators.js';
import { Identifier, NonEmptyString, SemanticVersion } from './primitives.js';

const CanonicalHash = z.string().regex(/^[a-f0-9]{64}$/);
const EnvironmentVariableName = z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/);
const AnchoredRoutePattern = z
  .string()
  .trim()
  .min(4)
  .max(512)
  .regex(/^\^\/[A-Za-z0-9_./-]+\$$/);

const TenantTarget = z
  .strictObject({
    entryPoint: EntryPoint,
    fingerprints: z.array(Fingerprint).min(2).max(16),
  })
  .superRefine((target, context) => {
    if (!target.fingerprints.some((fingerprint) => fingerprint.kind === 'urlPathPattern'))
      context.addIssue({
        code: 'custom',
        path: ['fingerprints'],
        message: 'tenant target needs a URL-path fingerprint',
      });
    if (
      !target.fingerprints.some(
        (fingerprint) =>
          fingerprint.kind === 'requiredText' || fingerprint.kind === 'requiredTarget',
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['fingerprints'],
        message: 'tenant target needs an independent visible-state fingerprint',
      });
  });

export const TenantOverride = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stepTarget'),
    stepId: Identifier,
    surface: z.enum(['action', 'checkpoint']),
    target: TargetDescriptor,
  }),
  z.strictObject({
    kind: z.literal('urlCheckpoint'),
    stepId: Identifier,
    pattern: AnchoredRoutePattern,
  }),
  z.strictObject({
    kind: z.literal('businessOutcomeText'),
    outcomeCode: Identifier,
    text: NonEmptyString.max(512),
  }),
]);

/**
 * Declarative, non-secret tenant specialization for one approved vendor capability.
 * It intentionally has no action, policy, output, risk, or credential-value fields.
 */
export const TenantConfiguration = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  version: SemanticVersion,
  activation: z.literal('testFixture'),
  tenantId: Identifier,
  vendor: z.strictObject({
    family: Identifier,
    product: Identifier,
    applicationVersion: SemanticVersion,
    variant: Identifier,
  }),
  baseCapability: z.strictObject({
    id: Identifier,
    version: SemanticVersion,
    canonicalHash: CanonicalHash,
  }),
  target: TenantTarget,
  runtime: z.strictObject({
    baseUrlReference: EnvironmentVariableName,
    secretBindings: z.record(Identifier, EnvironmentVariableName),
  }),
  overrides: z.array(TenantOverride).max(64),
});

export type TenantConfigurationType = z.infer<typeof TenantConfiguration>;
export type TenantOverrideType = z.infer<typeof TenantOverride>;
