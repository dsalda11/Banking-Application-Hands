import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { LoadedArtifact } from '../../src/replay/artifact-loader.js';
import { loadArtifact } from '../../src/replay/artifact-loader.js';
import {
  resolveTenantConfiguration,
  type TenantCompatibility,
} from '../../src/tenant/tenant-resolver.js';

const artifactPath = path.resolve(
  process.cwd(),
  '../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json',
);
const tenantAPath = path.resolve(process.cwd(), '../tenants/tenant-a.json');
const tenantBPath = path.resolve(process.cwd(), '../tenants/tenant-b.json');
const compatibility: TenantCompatibility = {
  vendorFamily: 'abc-legacy-banking',
  product: 'web-127.0.0.1',
  supportedApplicationVersions: ['1.0.0', '1.1.0'],
};

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('tenant configuration resolution', () => {
  let loadedArtifact: LoadedArtifact;
  let tenantA: Record<string, unknown>;
  let tenantB: Record<string, unknown>;

  beforeAll(async () => {
    [loadedArtifact, tenantA, tenantB] = await Promise.all([
      loadArtifact(artifactPath),
      readJson(tenantAPath),
      readJson(tenantBPath),
    ]);
  });

  it('validates both variants against the same exact approved base capability', () => {
    const resolvedA = resolveTenantConfiguration(tenantA, loadedArtifact, compatibility);
    const resolvedB = resolveTenantConfiguration(tenantB, loadedArtifact, compatibility);

    expect(resolvedA.tenantId).toBe('tenant-a');
    expect(resolvedB.tenantId).toBe('tenant-b');
    expect(resolvedA.baseCapability).toEqual(resolvedB.baseCapability);
    expect(resolvedA.baseCapability.canonicalHash).toBe(
      '1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095',
    );
    expect(resolvedA.vendor.applicationVersion).toBe('1.0.0');
    expect(resolvedB.vendor.applicationVersion).toBe('1.1.0');
  });

  it('accepts locator overrides and hashes equivalent override ordering deterministically', () => {
    const first = resolveTenantConfiguration(tenantB, loadedArtifact, compatibility);
    const reordered = structuredClone(tenantB);
    (reordered.overrides as unknown[]).reverse();
    const second = resolveTenantConfiguration(reordered, loadedArtifact, compatibility);

    expect(first.overrides.some((override) => override.kind === 'stepTarget')).toBe(true);
    expect(first.effectiveConfigurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.effectiveConfigurationHash).toBe(first.effectiveConfigurationHash);
  });

  it('rejects invalid tenant identities and malformed configurations', () => {
    const invalidId = structuredClone(tenantA);
    invalidId.tenantId = '../tenant';
    expect(() => resolveTenantConfiguration(invalidId, loadedArtifact, compatibility)).toThrowError(
      expect.objectContaining({ code: 'TENANT_CONFIG_INVALID' }),
    );

    const malformed = structuredClone(tenantA);
    delete malformed.target;
    expect(() => resolveTenantConfiguration(malformed, loadedArtifact, compatibility)).toThrowError(
      expect.objectContaining({ code: 'TENANT_CONFIG_INVALID' }),
    );
  });

  it('rejects a wrong base artifact hash and an incompatible vendor version', () => {
    const wrongHash = structuredClone(tenantA);
    (wrongHash.baseCapability as Record<string, unknown>).canonicalHash = '0'.repeat(64);
    expect(() => resolveTenantConfiguration(wrongHash, loadedArtifact, compatibility)).toThrowError(
      expect.objectContaining({ code: 'BASE_HASH_MISMATCH' }),
    );

    const wrongVersion = structuredClone(tenantB);
    (wrongVersion.vendor as Record<string, unknown>).applicationVersion = '9.0.0';
    expect(() =>
      resolveTenantConfiguration(wrongVersion, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_VENDOR_VERSION' }));
  });

  it('fails closed on attempts to weaken policy or add actions', () => {
    const weakened = structuredClone(tenantA);
    weakened.policy = { allowedOrigins: ['*'] };
    expect(() => resolveTenantConfiguration(weakened, loadedArtifact, compatibility)).toThrowError(
      expect.objectContaining({ code: 'TENANT_CONFIG_INVALID' }),
    );

    const addedAction = structuredClone(tenantA);
    addedAction.actions = [{ kind: 'navigate', destination: 'https://example.test' }];
    expect(() =>
      resolveTenantConfiguration(addedAction, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'TENANT_CONFIG_INVALID' }));

    const expandedOrigin = structuredClone(tenantB);
    ((expandedOrigin.target as Record<string, unknown>).entryPoint as Record<string, unknown>).url =
      'https://unapproved.example/tenant-b/login';
    expect(() =>
      resolveTenantConfiguration(expandedOrigin, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_OVERRIDE' }));

    const weakenedMatch = structuredClone(tenantB);
    const targetOverride = (weakenedMatch.overrides as Array<Record<string, unknown>>).find(
      (override) => override.kind === 'stepTarget',
    )!;
    (targetOverride.target as Record<string, unknown>).match = 'firstVisible';
    expect(() =>
      resolveTenantConfiguration(weakenedMatch, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_OVERRIDE' }));
  });

  it('rejects unknown override fields, targets, and conflicts', () => {
    const unknownField = structuredClone(tenantB);
    (unknownField.overrides as Array<Record<string, unknown>>)[0]!.removeCheckpoint = true;
    expect(() =>
      resolveTenantConfiguration(unknownField, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'TENANT_CONFIG_INVALID' }));

    const unknownStep = structuredClone(tenantA);
    unknownStep.overrides = [
      {
        kind: 'urlCheckpoint',
        stepId: 'missing-step',
        pattern: '^/tenant-b/login$',
      },
    ];
    expect(() =>
      resolveTenantConfiguration(unknownStep, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_OVERRIDE_TARGET' }));

    const conflicting = structuredClone(tenantB);
    const overrides = conflicting.overrides as unknown[];
    overrides.push(structuredClone(overrides[0]));
    expect(() =>
      resolveTenantConfiguration(conflicting, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICTING_OVERRIDE' }));
  });

  it('requires every runtime secret binding and rejects credential-shaped values', () => {
    const missingBinding = structuredClone(tenantA);
    delete (missingBinding.runtime as { secretBindings: Record<string, unknown> }).secretBindings
      .BANK_STAFF_PASSWORD;
    expect(() =>
      resolveTenantConfiguration(missingBinding, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'RUNTIME_BINDING_MISMATCH' }));

    const embeddedValue = structuredClone(tenantA);
    (
      embeddedValue.runtime as { secretBindings: Record<string, unknown> }
    ).secretBindings.BANK_STAFF_PASSWORD = 'not an environment variable';
    expect(() =>
      resolveTenantConfiguration(embeddedValue, loadedArtifact, compatibility),
    ).toThrowError(expect.objectContaining({ code: 'TENANT_CONFIG_INVALID' }));
  });
});
