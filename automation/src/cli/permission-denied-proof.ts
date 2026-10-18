interface ProofStep {
  readonly id: string;
  action: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
}

interface ProofArtifact {
  readonly steps: ProofStep[];
  contract: {
    businessOutcomes: Array<Record<string, unknown>>;
  };
}

function hasRoleTarget(step: ProofStep, role: string, accessibleName: string): boolean {
  if (step.action.kind !== 'activate') return false;
  const target = step.action.target;
  if (!target || typeof target !== 'object') return false;
  const candidates = (target as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return false;

  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const value = candidate as {
      strategy?: unknown;
      role?: unknown;
      name?: { kind?: unknown; value?: unknown };
    };
    return (
      value.strategy === 'role' &&
      value.role === role &&
      value.name?.kind === 'literal' &&
      value.name.value === accessibleName
    );
  });
}

/**
 * Builds the temporary permission-denial proof from semantic action targets.
 * Compiler-generated step IDs are intentionally not part of this proof contract.
 */
export function preparePermissionDeniedProof(artifact: ProofArtifact): ProofArtifact {
  const prepared = structuredClone(artifact);
  const submitLogin = prepared.steps.find((step) => hasRoleTarget(step, 'button', 'Submit'));
  const openCustomers = prepared.steps.find((step) => hasRoleTarget(step, 'link', 'Customers'));
  if (!submitLogin || !openCustomers) {
    throw new Error('Permission-denied fixture requires login and staff-navigation steps');
  }

  submitLogin.checkpoint = {
    kind: 'textPresent',
    description: 'Non-staff authentication reaches the customer console.',
    text: 'Transfer Money',
  };
  openCustomers.action = {
    kind: 'navigate',
    destination: { kind: 'relativeRoute', route: '/showcust' },
  };
  openCustomers.checkpoint = {
    kind: 'textPresent',
    description: 'The protected staff route reports access denial.',
    text: 'Error Occured!! GO back and try again.',
  };
  if (!prepared.contract.businessOutcomes.some((outcome) => outcome.code === 'PERMISSION_DENIED')) {
    prepared.contract.businessOutcomes.push({
      code: 'PERMISSION_DENIED',
      result: 'permissionDenied',
      description: 'The authenticated identity cannot access the staff customer console.',
      detection: {
        kind: 'textPresent',
        description: 'The protected staff route reports access denial.',
        text: 'Error Occured!! GO back and try again.',
      },
    });
  }
  return prepared;
}
