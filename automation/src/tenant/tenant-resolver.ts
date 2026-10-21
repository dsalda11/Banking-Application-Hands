import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { contentHash } from '../compiler/canonical-json.js';
import {
  TenantConfiguration,
  Identifier,
  type TenantConfigurationType,
  type TenantOverrideType,
} from '../domain/index.js';
import type { LoadedArtifact } from '../replay/artifact-loader.js';

export type TenantResolutionErrorCode =
  | 'TENANT_CONFIG_READ_FAILED'
  | 'TENANT_CONFIG_MALFORMED_JSON'
  | 'TENANT_CONFIG_INVALID'
  | 'TENANT_CONFIG_NOT_FOUND'
  | 'TENANT_IDENTITY_MISMATCH'
  | 'BASE_CAPABILITY_MISMATCH'
  | 'BASE_HASH_MISMATCH'
  | 'VENDOR_MISMATCH'
  | 'INCOMPATIBLE_VENDOR_VERSION'
  | 'RUNTIME_BINDING_MISMATCH'
  | 'UNKNOWN_OVERRIDE_TARGET'
  | 'INCOMPATIBLE_OVERRIDE'
  | 'CONFLICTING_OVERRIDE';

export class TenantResolutionError extends Error {
  constructor(
    readonly code: TenantResolutionErrorCode,
    message: string,
    readonly issues: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'TenantResolutionError';
  }
}

export interface TenantCompatibility {
  readonly vendorFamily: string;
  readonly product: string;
  readonly supportedApplicationVersions: readonly string[];
}

export interface ResolvedTenantConfiguration {
  readonly schemaVersion: '1.0.0';
  readonly version: string;
  readonly activation: 'testFixture';
  readonly tenantId: string;
  readonly vendor: TenantConfigurationType['vendor'];
  readonly baseCapability: TenantConfigurationType['baseCapability'];
  readonly target: TenantConfigurationType['target'];
  readonly runtime: TenantConfigurationType['runtime'];
  readonly overrides: readonly TenantOverrideType[];
  readonly configurationHash: string;
  readonly effectiveConfigurationHash: string;
}

function overrideKey(override: TenantOverrideType): string {
  switch (override.kind) {
    case 'stepTarget':
      return `${override.kind}:${override.stepId}:${override.surface}`;
    case 'urlCheckpoint':
      return `${override.kind}:${override.stepId}`;
    case 'businessOutcomeText':
      return `${override.kind}:${override.outcomeCode}`;
  }
}

function verifySecretBindings(
  config: TenantConfigurationType,
  loadedArtifact: LoadedArtifact,
): void {
  const declared = [...loadedArtifact.artifact.contract.requiredSecrets].sort();
  const bound = Object.keys(config.runtime.secretBindings).sort();
  if (declared.length !== bound.length || declared.some((name, index) => name !== bound[index]))
    throw new TenantResolutionError(
      'RUNTIME_BINDING_MISMATCH',
      'Tenant runtime bindings must map every and only the base capability secret reference',
      [`expected=${declared.join(',')}`, `received=${bound.join(',')}`],
    );
}

function verifyEntryPoint(config: TenantConfigurationType, loadedArtifact: LoadedArtifact): void {
  const base = loadedArtifact.artifact.target.entryPoint;
  const tenant = config.target.entryPoint;
  if (base.kind === 'relativeRoute') {
    if (tenant.kind !== 'relativeRoute')
      throw new TenantResolutionError(
        'INCOMPATIBLE_OVERRIDE',
        'A relative base entry point cannot be expanded to an absolute tenant URL',
      );
    return;
  }
  if (tenant.kind !== 'absoluteUrl' || new URL(tenant.url).origin !== new URL(base.url).origin)
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      'Tenant entry point must remain on the approved base artifact origin',
    );
}

function verifyOverride(override: TenantOverrideType, loadedArtifact: LoadedArtifact): void {
  if (override.kind === 'businessOutcomeText') {
    const outcome = loadedArtifact.artifact.contract.businessOutcomes.find(
      (candidate) => candidate.code === override.outcomeCode,
    );
    if (!outcome)
      throw new TenantResolutionError(
        'UNKNOWN_OVERRIDE_TARGET',
        `Unknown business outcome ${override.outcomeCode}`,
      );
    if (outcome.detection.kind !== 'textPresent')
      throw new TenantResolutionError(
        'INCOMPATIBLE_OVERRIDE',
        `Outcome ${override.outcomeCode} does not use text-present detection`,
      );
    return;
  }

  const step = loadedArtifact.artifact.steps.find((candidate) => candidate.id === override.stepId);
  if (!step)
    throw new TenantResolutionError(
      'UNKNOWN_OVERRIDE_TARGET',
      `Unknown base capability step ${override.stepId}`,
    );

  if (override.kind === 'urlCheckpoint') {
    if (step.checkpoint.kind !== 'urlMatches')
      throw new TenantResolutionError(
        'INCOMPATIBLE_OVERRIDE',
        `Step ${override.stepId} does not have a URL checkpoint`,
      );
    return;
  }

  if (override.surface === 'action') {
    if (!('target' in step.action) || step.action.target === undefined)
      throw new TenantResolutionError(
        'INCOMPATIBLE_OVERRIDE',
        `Step ${override.stepId} does not have an action target`,
      );
    if (override.target.match !== step.action.target.match)
      throw new TenantResolutionError(
        'INCOMPATIBLE_OVERRIDE',
        `Step ${override.stepId} cannot weaken action target match semantics`,
      );
    return;
  }

  if (
    (step.checkpoint.kind !== 'elementVisible' &&
      step.checkpoint.kind !== 'elementAbsent' &&
      step.checkpoint.kind !== 'valueEquals') ||
    !('target' in step.checkpoint)
  )
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      `Step ${override.stepId} does not have a target-bearing checkpoint`,
    );
  const checkpointTarget = (step.checkpoint as { target: { match: string } }).target;
  if (override.target.match !== checkpointTarget.match)
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      `Step ${override.stepId} cannot weaken checkpoint target match semantics`,
    );
}

export function resolveTenantConfiguration(
  input: unknown,
  loadedArtifact: LoadedArtifact,
  compatibility: TenantCompatibility,
): ResolvedTenantConfiguration {
  const parsed = TenantConfiguration.safeParse(input);
  if (!parsed.success)
    throw new TenantResolutionError(
      'TENANT_CONFIG_INVALID',
      'Tenant configuration does not match the closed schema',
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  const config = parsed.data;
  if (
    config.baseCapability.id !== loadedArtifact.artifact.id ||
    config.baseCapability.version !== loadedArtifact.artifact.version
  )
    throw new TenantResolutionError(
      'BASE_CAPABILITY_MISMATCH',
      'Tenant configuration references a different base capability',
    );
  if (config.baseCapability.canonicalHash !== loadedArtifact.contentHash)
    throw new TenantResolutionError(
      'BASE_HASH_MISMATCH',
      'Tenant configuration base hash does not match the loaded artifact',
    );
  if (
    config.vendor.family !== compatibility.vendorFamily ||
    config.vendor.product !== compatibility.product ||
    config.vendor.product !== loadedArtifact.artifact.target.product
  )
    throw new TenantResolutionError(
      'VENDOR_MISMATCH',
      'Tenant configuration is not compatible with the intended vendor product',
    );
  if (!compatibility.supportedApplicationVersions.includes(config.vendor.applicationVersion))
    throw new TenantResolutionError(
      'INCOMPATIBLE_VENDOR_VERSION',
      `Unsupported vendor application version ${config.vendor.applicationVersion}`,
    );

  verifyEntryPoint(config, loadedArtifact);
  verifySecretBindings(config, loadedArtifact);
  const sortedOverrides = [...config.overrides].sort((left, right) =>
    overrideKey(left).localeCompare(overrideKey(right)),
  );
  const keys = sortedOverrides.map(overrideKey);
  const duplicate = keys.find((key, index) => key === keys[index - 1]);
  if (duplicate)
    throw new TenantResolutionError(
      'CONFLICTING_OVERRIDE',
      `Tenant configuration contains conflicting override ${duplicate}`,
    );
  for (const override of sortedOverrides) verifyOverride(override, loadedArtifact);

  const resolved = {
    schemaVersion: config.schemaVersion,
    version: config.version,
    activation: config.activation,
    tenantId: config.tenantId,
    vendor: config.vendor,
    baseCapability: config.baseCapability,
    target: config.target,
    runtime: config.runtime,
    overrides: sortedOverrides,
  } as const;
  return {
    ...resolved,
    configurationHash: contentHash(config),
    effectiveConfigurationHash: contentHash(resolved),
  };
}

export async function loadAndResolveTenantConfiguration(
  filePath: string,
  loadedArtifact: LoadedArtifact,
  compatibility: TenantCompatibility,
): Promise<ResolvedTenantConfiguration> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw new TenantResolutionError(
      'TENANT_CONFIG_READ_FAILED',
      'Could not read tenant configuration',
      [],
      error,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new TenantResolutionError(
      'TENANT_CONFIG_MALFORMED_JSON',
      'Tenant configuration is not valid JSON',
      [],
      error,
    );
  }
  return resolveTenantConfiguration(input, loadedArtifact, compatibility);
}

export async function loadTenantConfigurationById(
  directory: string,
  tenantId: string,
  loadedArtifact: LoadedArtifact,
  compatibility: TenantCompatibility,
): Promise<ResolvedTenantConfiguration> {
  if (!Identifier.safeParse(tenantId).success)
    throw new TenantResolutionError('TENANT_CONFIG_INVALID', 'Tenant identifier is invalid');
  const filePath = path.join(directory, `${tenantId}.json`);
  let resolved: ResolvedTenantConfiguration;
  try {
    resolved = await loadAndResolveTenantConfiguration(filePath, loadedArtifact, compatibility);
  } catch (error: unknown) {
    if (error instanceof TenantResolutionError && error.code === 'TENANT_CONFIG_READ_FAILED')
      throw new TenantResolutionError(
        'TENANT_CONFIG_NOT_FOUND',
        `No tenant configuration exists for ${tenantId}`,
        [],
        error,
      );
    throw error;
  }
  if (resolved.tenantId !== tenantId)
    throw new TenantResolutionError(
      'TENANT_IDENTITY_MISMATCH',
      'Requested tenant does not match the configuration identity',
    );
  return resolved;
}
