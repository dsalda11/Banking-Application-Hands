import { describe, expect, it } from 'vitest';

import { preparePermissionDeniedProof } from './permission-denied-proof.js';

const roleTarget = (role: string, value: string) => ({
  description: `${role} ${value}`,
  candidates: [{ strategy: 'role', role, name: { kind: 'literal', value } }],
  match: 'exactlyOne',
});

describe('permission-denied proof preparation', () => {
  it('uses semantic targets rather than compiler-generated step IDs', () => {
    const artifact = {
      contract: { businessOutcomes: [] },
      steps: [
        {
          id: 'step-004-activate',
          action: { kind: 'activate', target: roleTarget('button', 'Submit') },
          checkpoint: { kind: 'urlMatches', description: 'staff landing', pattern: '/main' },
        },
        {
          id: 'step-005-activate',
          action: { kind: 'activate', target: roleTarget('link', 'Customers') },
          checkpoint: { kind: 'urlMatches', description: 'customer list', pattern: '/showcust' },
        },
      ],
    };

    const prepared = preparePermissionDeniedProof(artifact);

    expect(prepared.steps[0]?.checkpoint).toMatchObject({
      kind: 'textPresent',
      text: 'Transfer Money',
    });
    expect(prepared.steps[1]?.action).toEqual({
      kind: 'navigate',
      destination: { kind: 'relativeRoute', route: '/showcust' },
    });
    expect(artifact.steps[1]?.action).toMatchObject({ kind: 'activate' });
    expect(prepared.contract.businessOutcomes).toContainEqual(
      expect.objectContaining({ code: 'PERMISSION_DENIED', result: 'permissionDenied' }),
    );
    expect(artifact.contract.businessOutcomes).toEqual([]);
  });

  it('fails closed when either required semantic action is absent', () => {
    expect(() =>
      preparePermissionDeniedProof({
        contract: { businessOutcomes: [] },
        steps: [
          {
            id: 'unrelated',
            action: { kind: 'activate', target: roleTarget('button', 'Other') },
            checkpoint: { kind: 'textPresent', description: 'other', text: 'Other' },
          },
        ],
      }),
    ).toThrow('requires login and staff-navigation steps');
  });
});
