import { describe, expect, it } from 'vitest';

import { RunResult } from '../../src/domain/run-result.js';

const base = { runId: 'run-1', evidence: [], completedAt: '2026-09-17T00:00:00Z' };

describe('RunResult', () => {
  it('represents success, CUSTOMER_NOT_FOUND, human takeover, and failure separately', () => {
    expect(
      RunResult.parse({
        status: 'success',
        ...base,
        artifactId: 'banking.lookup',
        artifactVersion: '1.0.0',
        outputs: { accountNumber: '2023' },
      }).status,
    ).toBe('success');
    expect(
      RunResult.parse({
        status: 'businessOutcome',
        ...base,
        artifactId: 'banking.lookup',
        artifactVersion: '1.0.0',
        code: 'CUSTOMER_NOT_FOUND',
      }).status,
    ).toBe('businessOutcome');
    expect(
      RunResult.parse({
        status: 'needsHuman',
        runId: 'run-1',
        interventionId: 'int-1',
        currentStepId: 'step-1',
        reasonCode: 'ambiguousTarget',
        evidence: [],
      }).status,
    ).toBe('needsHuman');
    expect(
      RunResult.parse({
        status: 'failure',
        ...base,
        error: {
          category: 'target',
          code: 'TARGET_NOT_FOUND',
          message: 'Target missing',
          retryable: false,
          evidence: [],
        },
      }).status,
    ).toBe('failure');
  });

  it('rejects fields mixed across statuses', () => {
    expect(
      RunResult.safeParse({
        status: 'success',
        ...base,
        artifactId: 'banking.lookup',
        artifactVersion: '1.0.0',
        outputs: {},
        error: { category: 'internal', code: 'X', message: 'x', retryable: false, evidence: [] },
      }).success,
    ).toBe(false);
  });
});
