import { describe, expect, it } from 'vitest';

import { DiscoveryDecision } from '../../src/domain/discovery.js';

describe('DiscoveryDecision', () => {
  it('accepts element actions, bounded coordinate fallback, completion, and human request', () => {
    expect(
      DiscoveryDecision.parse({
        kind: 'action',
        reason: 'Open customers',
        action: { kind: 'activate', elementReference: 'el1' },
      }).kind,
    ).toBe('action');
    expect(
      DiscoveryDecision.parse({
        kind: 'action',
        reason: 'Fallback',
        action: { kind: 'coordinateClick', coordinate: { observationId: 'obs1', x: 0.5, y: 0.25 } },
      }).kind,
    ).toBe('action');
    expect(
      DiscoveryDecision.parse({
        kind: 'complete',
        summary: 'Done',
        candidateOutputs: {},
        successEvidence: { kind: 'textPresent', description: 'done', text: 'done' },
      }).kind,
    ).toBe('complete');
    expect(
      DiscoveryDecision.parse({
        kind: 'requestHuman',
        reasonCode: 'ambiguousTarget',
        explanation: 'Two matches',
        currentStateSummary: 'Customer list',
      }).kind,
    ).toBe('requestHuman');
  });

  it('rejects out-of-range coordinates, unknown kinds, extra fields, and chain-of-thought fields', () => {
    expect(
      DiscoveryDecision.safeParse({
        kind: 'action',
        reason: 'Fallback',
        action: { kind: 'coordinateClick', coordinate: { observationId: 'obs1', x: 1.1, y: 0.25 } },
      }).success,
    ).toBe(false);
    expect(DiscoveryDecision.safeParse({ kind: 'unknown' }).success).toBe(false);
    expect(
      DiscoveryDecision.safeParse({
        kind: 'complete',
        summary: 'Done',
        candidateOutputs: {},
        successEvidence: { kind: 'textPresent', description: 'done', text: 'done' },
        chainOfThought: 'secret reasoning',
      }).success,
    ).toBe(false);
  });
});
