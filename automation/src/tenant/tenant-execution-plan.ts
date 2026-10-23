import { contentHash } from '../compiler/canonical-json.js';
import { CapabilityArtifact, type CapabilityArtifactType } from '../domain/index.js';
import { validateArtifactSemantics } from '../domain/semantic-validation.js';
import type { LoadedArtifact } from '../replay/artifact-loader.js';
import {
  TenantResolutionError,
  type ResolvedTenantConfiguration,
} from './tenant-resolver.js';

export interface TenantExecutionPlan {
  readonly tenantId: string;
  readonly tenantConfigurationVersion: string;
  readonly activation: 'testFixture';
  readonly baseArtifactHash: string;
  readonly tenantConfigurationHash: string;
  readonly effectiveConfigurationHash: string;
  readonly effectiveArtifactHash: string;
  readonly effectivePlanHash: string;
  readonly artifact: CapabilityArtifactType;
}

function incompatible(message: string): never {
  throw new TenantResolutionError('INCOMPATIBLE_OVERRIDE', message);
}

export function createTenantExecutionPlan(
  loadedArtifact: LoadedArtifact,
  tenant: ResolvedTenantConfiguration,
): TenantExecutionPlan {
  if (tenant.baseCapability.canonicalHash !== loadedArtifact.contentHash)
    throw new TenantResolutionError(
      'BASE_HASH_MISMATCH',
      'Resolved tenant configuration no longer matches the loaded base artifact',
    );

  const effective = structuredClone(loadedArtifact.artifact);
  effective.target.entryPoint = structuredClone(tenant.target.entryPoint);
  effective.target.fingerprints = structuredClone(tenant.target.fingerprints);

  const entryStep = effective.steps[0];
  if (!entryStep || entryStep.action.kind !== 'navigate')
    incompatible('Base capability must begin with one deterministic navigation action');
  entryStep.action.destination = structuredClone(tenant.target.entryPoint);

  for (const override of tenant.overrides) {
    if (override.kind === 'businessOutcomeText') {
      const outcome = effective.contract.businessOutcomes.find(
        (candidate) => candidate.code === override.outcomeCode,
      );
      if (!outcome || outcome.detection.kind !== 'textPresent')
        incompatible(`Business outcome ${override.outcomeCode} cannot be specialized`);
      (outcome.detection as unknown as { text: string }).text = override.text;
      continue;
    }

    const step = effective.steps.find((candidate) => candidate.id === override.stepId);
    if (!step) incompatible(`Step ${override.stepId} cannot be specialized`);
    if (override.kind === 'urlCheckpoint') {
      if (step.checkpoint.kind !== 'urlMatches')
        incompatible(`Step ${override.stepId} has no URL checkpoint`);
      (step.checkpoint as unknown as { pattern: string }).pattern = override.pattern;
      continue;
    }

    if (override.surface === 'action') {
      if (!('target' in step.action) || !step.action.target)
        incompatible(`Step ${override.stepId} has no action target`);
      step.action.target = structuredClone(override.target);
      continue;
    }
    if (!('target' in step.checkpoint))
      incompatible(`Step ${override.stepId} has no checkpoint target`);
    (step.checkpoint as { target: typeof override.target }).target = structuredClone(
      override.target,
    );
  }

  const parsed = CapabilityArtifact.safeParse(effective);
  if (!parsed.success)
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      'Resolved tenant execution artifact failed schema validation',
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  const semantic = validateArtifactSemantics(parsed.data);
  const errors = semantic.issues.filter((issue) => issue.severity === 'error');
  if (errors.length)
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      'Resolved tenant execution artifact failed semantic validation',
      errors.map((issue) => issue.message),
    );

  const effectiveArtifactHash = contentHash(parsed.data);
  const identity = {
    tenantId: tenant.tenantId,
    tenantConfigurationVersion: tenant.version,
    activation: tenant.activation,
    baseArtifactHash: loadedArtifact.contentHash,
    tenantConfigurationHash: tenant.configurationHash,
    effectiveConfigurationHash: tenant.effectiveConfigurationHash,
    effectiveArtifactHash,
  } as const;
  return {
    ...identity,
    effectivePlanHash: contentHash(identity),
    artifact: parsed.data,
  };
}

export function verifyTenantExecutionPlan(
  loadedArtifact: LoadedArtifact,
  plan: TenantExecutionPlan,
): void {
  if (plan.baseArtifactHash !== loadedArtifact.contentHash)
    throw new TenantResolutionError(
      'BASE_HASH_MISMATCH',
      'Tenant plan is not bound to the loaded approved base artifact',
    );
  if (contentHash(plan.artifact) !== plan.effectiveArtifactHash)
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      'Tenant execution artifact changed after plan resolution',
    );
  const identity = {
    tenantId: plan.tenantId,
    tenantConfigurationVersion: plan.tenantConfigurationVersion,
    activation: plan.activation,
    baseArtifactHash: plan.baseArtifactHash,
    tenantConfigurationHash: plan.tenantConfigurationHash,
    effectiveConfigurationHash: plan.effectiveConfigurationHash,
    effectiveArtifactHash: plan.effectiveArtifactHash,
  } as const;
  if (contentHash(identity) !== plan.effectivePlanHash)
    throw new TenantResolutionError(
      'INCOMPATIBLE_OVERRIDE',
      'Tenant execution plan identity is not canonical',
    );
}
