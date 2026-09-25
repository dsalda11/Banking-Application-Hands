import { describe, expect, it } from 'vitest';

import { EvidenceReference } from '../../src/domain/evidence.js';
import { InterventionRequest } from '../../src/domain/intervention.js';

const valid = {
  interventionId: 'int-1',
  runId: 'run-1',
  capabilitySummary: 'Locate a customer',
  reasonCode: 'ambiguousTarget',
  explanation: 'Two customer links matched.',
  recentActions: ['Opened customer list'],
  evidence: [],
  requestedAt: '2026-09-17T00:00:00Z',
  controlOwner: 'human',
  status: 'requested',
  suggestedResumeBehavior: 'Recheck the customer list before resuming.',
};

describe('intervention and evidence contracts', () => {
  it('parses a sanitized intervention request', () => {
    expect(InterventionRequest.parse(valid).status).toBe('requested');
  });

  it('rejects invalid owners, raw screenshot data, absolute paths, and traversal', () => {
    expect(InterventionRequest.safeParse({ ...valid, controlOwner: 'browser' }).success).toBe(
      false,
    );
    expect(InterventionRequest.safeParse({ ...valid, screenshotBytes: 'base64' }).success).toBe(
      false,
    );
    expect(
      EvidenceReference.safeParse({
        evidenceId: 'ev1',
        kind: 'screenshot',
        path: '/tmp/a.png',
        sanitization: 'sanitized',
      }).success,
    ).toBe(false);
    expect(
      EvidenceReference.safeParse({
        evidenceId: 'ev1',
        kind: 'screenshot',
        path: '../a.png',
        sanitization: 'sanitized',
      }).success,
    ).toBe(false);
  });
});
