import { z } from 'zod';

import { Checkpoint } from './checkpoints.js';
import { DataShape } from './data-shapes.js';
import { EvidenceReference } from './evidence.js';
import { CapabilityStep } from './actions.js';
import { Identifier, NonEmptyString, SemanticVersion, Timestamp } from './primitives.js';
import { BusinessOutcome } from './outcomes.js';

const InputSpec = z.strictObject({ description: NonEmptyString.max(256), shape: DataShape });
const OutputSpec = z.strictObject({ description: NonEmptyString.max(256), shape: DataShape });

const EntryPoint = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('relativeRoute'),
    route: z.string().regex(/^\/[A-Za-z0-9_./?=&-]{0,255}$/),
  }),
  z.strictObject({ kind: z.literal('absoluteUrl'), url: z.string().url() }),
]);

const Fingerprint = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('urlPathPattern'),
    id: Identifier,
    pattern: NonEmptyString.max(512),
  }),
  z.strictObject({
    kind: z.literal('titlePattern'),
    id: Identifier,
    pattern: NonEmptyString.max(256),
  }),
  z.strictObject({
    kind: z.literal('requiredText'),
    id: Identifier,
    text: NonEmptyString.max(512),
  }),
  z.strictObject({
    kind: z.literal('requiredTarget'),
    id: Identifier,
    targetDescription: NonEmptyString.max(256),
  }),
  z.strictObject({
    kind: z.literal('frameStructure'),
    id: Identifier,
    signature: NonEmptyString.max(256),
  }),
]);

const Provenance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('discoveryRun'), runId: Identifier }),
  z.strictObject({ kind: z.literal('authoredFixture'), reason: NonEmptyString.max(512) }),
]);

const Metadata = z.strictObject({
  createdAt: Timestamp,
  provenance: Provenance,
  compilerVersion: SemanticVersion.optional(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sourceDiscoveryRunId: Identifier.optional(),
  evidence: z.array(EvidenceReference).max(16).optional(),
});

/** Versioned, executable-data-only capability contract. */
export const CapabilityArtifact = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  id: Identifier,
  version: SemanticVersion,
  lifecycle: z.enum(['draft', 'validated', 'approved', 'deprecated']),
  name: NonEmptyString.max(128),
  description: NonEmptyString.max(1024),
  target: z.strictObject({
    surface: z.enum(['web', 'desktop']),
    product: Identifier,
    productVersionRange: NonEmptyString.max(128).optional(),
    entryPoint: EntryPoint,
    fingerprints: z.array(Fingerprint).min(1).max(16),
  }),
  contract: z.strictObject({
    inputs: z.record(Identifier, InputSpec),
    requiredSecrets: z.array(Identifier).max(16),
    outputs: z.record(Identifier, OutputSpec),
    businessOutcomes: z.array(BusinessOutcome).max(16),
  }),
  policyRef: Identifier,
  preconditions: z.array(Checkpoint).max(8),
  steps: z.array(CapabilityStep).min(1).max(100),
  success: Checkpoint,
  metadata: Metadata,
});

export type CapabilityArtifactType = z.infer<typeof CapabilityArtifact>;
export type InputSpecType = z.infer<typeof InputSpec>;
export type OutputSpecType = z.infer<typeof OutputSpec>;
