import { describe, expect, it } from 'vitest';

import { CapabilityArtifact } from '../../src/domain/artifact.js';
import { validateArtifactSemantics } from '../../src/domain/semantic-validation.js';
import { cloneFixture, parsedFixture } from './helpers.js';

function validate(value: unknown) {
  const artifact = CapabilityArtifact.parse(value);
  return validateArtifactSemantics(artifact);
}

describe('artifact semantic validation', () => {
  it('accepts the valid draft with no error issues', () => {
    const result = validateArtifactSemantics(CapabilityArtifact.parse(parsedFixture()));
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('detects duplicate steps and outcome codes', () => {
    const value = cloneFixture();
    const steps = value.steps as Record<string, unknown>[];
    steps[1]!.id = steps[0]!.id;
    const contract = value.contract as Record<string, unknown>;
    const outcomes = contract.businessOutcomes as Record<string, unknown>[];
    outcomes.push(structuredClone(outcomes[0]!));
    const result = validate(value);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['DUPLICATE_STEP_ID', 'DUPLICATE_OUTCOME_CODE']),
    );
  });

  it('detects undeclared references and outputs that are never produced', () => {
    const value = cloneFixture();
    const contract = value.contract as Record<string, unknown>;
    const step = (value.steps as Record<string, unknown>[])[5]!;
    const action = step.action as Record<string, unknown>;
    const source = action.value as Record<string, unknown>;
    source.name = 'missingInput';
    const outputs = contract.outputs as Record<string, unknown>;
    outputs.unused = { description: 'Unused', shape: { kind: 'string' } };
    const result = validate(value);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['UNDECLARED_INPUT', 'OUTPUT_NEVER_PRODUCED']),
    );
  });

  it('detects invalid required fields, unsafe retries, excessive retries, and weak approved metadata', () => {
    const value = cloneFixture();
    const contract = value.contract as Record<string, unknown>;
    const outputs = contract.outputs as Record<string, unknown>;
    const balance = outputs.currentBalance as Record<string, unknown>;
    const shape = balance.shape as Record<string, unknown>;
    shape.required = ['missing'];
    const steps = value.steps as Record<string, unknown>[];
    const retryStep = steps[0]!;
    retryStep.risk = 'irreversibleWrite';
    const recovery = retryStep.recovery as Record<string, unknown>;
    recovery.maxAttempts = 4;
    value.lifecycle = 'approved';
    const metadata = value.metadata as Record<string, unknown>;
    delete metadata.compilerVersion;
    delete metadata.checksum;
    const result = validate(value);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'REQUIRED_PROPERTY_UNDECLARED',
        'RETRY_IRREVERSIBLE',
        'RETRY_LIMIT_EXCEEDED',
        'LIFECYCLE_METADATA_MISSING',
        'LIFECYCLE_PROVENANCE_MISSING',
      ]),
    );
  });

  it('rejects artifacts with only visual targeting or without final output checks', () => {
    const value = cloneFixture();
    for (const step of value.steps as Record<string, unknown>[]) {
      const action = step.action as Record<string, unknown>;
      if ('target' in action) {
        const target = action.target as Record<string, unknown>;
        target.candidates = [
          {
            strategy: 'visualAnchor',
            evidence: {
              evidenceId: 'ev1',
              kind: 'screenshot',
              path: 'local/x.png',
              sanitization: 'synthetic',
            },
            anchorName: 'button',
            threshold: 0.8,
          },
        ];
      }
    }
    value.success = { kind: 'textPresent', description: 'done', text: 'done' };
    const result = validate(value);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['NO_USABLE_NON_COORDINATE_LOCATOR', 'SUCCESS_OUTPUT_CHECK_MISSING']),
    );
  });
});
