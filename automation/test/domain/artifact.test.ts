import { describe, expect, it } from 'vitest';

import { CapabilityArtifact } from '../../src/domain/artifact.js';
import { cloneFixture, parsedFixture } from './helpers.js';

describe('CapabilityArtifact', () => {
  it('parses the draft example and survives JSON serialization', () => {
    const artifact = CapabilityArtifact.parse(parsedFixture());
    expect(artifact.id).toBe('banking.lookup-customer-account');
    const details = artifact.steps.find((step) => step.id === 'open-customer-details');
    expect(details?.checkpoint).toMatchObject({
      kind: 'all',
      children: expect.arrayContaining([
        expect.objectContaining({ kind: 'urlMatches', pattern: '/getDetails' }),
        expect.objectContaining({ kind: 'textPresent', text: 'Account No.' }),
      ]),
    });
    expect(CapabilityArtifact.parse(JSON.parse(JSON.stringify(artifact))).version).toBe('1.0.0');
  });

  it('rejects unknown fields, invalid versions, empty steps, missing checkpoints, and empty locators', () => {
    const unknown = cloneFixture();
    unknown.extra = true;
    expect(CapabilityArtifact.safeParse(unknown).success).toBe(false);

    const invalidVersion = cloneFixture();
    invalidVersion.schemaVersion = '2.0.0';
    expect(CapabilityArtifact.safeParse(invalidVersion).success).toBe(false);

    const emptySteps = cloneFixture();
    emptySteps.steps = [];
    expect(CapabilityArtifact.safeParse(emptySteps).success).toBe(false);

    const missingCheckpoint = cloneFixture();
    const firstStep = (missingCheckpoint.steps as Record<string, unknown>[])[0]!;
    delete firstStep.checkpoint;
    expect(CapabilityArtifact.safeParse(missingCheckpoint).success).toBe(false);

    const emptyLocators = cloneFixture();
    const detailStep = (emptyLocators.steps as Record<string, unknown>[]).find(
      (step) => step.id === 'open-customer-details',
    );
    const action = detailStep?.action as Record<string, unknown>;
    const target = action.target as Record<string, unknown>;
    target.candidates = [];
    expect(CapabilityArtifact.safeParse(emptyLocators).success).toBe(false);
  });
});
