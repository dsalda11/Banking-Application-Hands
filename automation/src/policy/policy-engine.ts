import type {
  CapabilityActionType,
  CapabilityArtifactType,
  CapabilityStepType,
} from '../domain/index.js';
import type { ReplayPolicyType, PolicyActionKindType, PolicyRiskType } from '../domain/policy.js';

export type PolicyDecisionKind = 'allow' | 'deny' | 'requireIntervention';
export interface PolicyDecision {
  readonly decision: PolicyDecisionKind;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly runId: string;
  readonly stepId: string;
  readonly actionType: PolicyActionKindType;
  readonly target?:
    { readonly description?: string; readonly strategies?: readonly string[] } | undefined;
  readonly risk: PolicyRiskType;
  readonly ruleId?: string;
  readonly reason: string;
  readonly timestamp: string;
}

export class PolicyDecisionError extends Error {
  constructor(
    readonly code: 'POLICY_DENIED' | 'POLICY_INTERVENTION_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyDecisionError';
  }
}

function targetMetadata(action: CapabilityActionType) {
  if (!('target' in action) || !action.target) return undefined;
  return {
    description: action.target.description,
    strategies: action.target.candidates.map((candidate) => candidate.strategy),
  };
}

function routeFor(action: CapabilityActionType): string | undefined {
  if (action.kind !== 'navigate' || !('kind' in action.destination)) return undefined;
  if (action.destination.kind === 'relativeRoute') return action.destination.route;
  if (action.destination.kind === 'absoluteUrl') return action.destination.url;
  return undefined;
}

export class PolicyEngine {
  constructor(
    readonly policy: ReplayPolicyType,
    readonly policyHash: string,
  ) {}

  preflight(artifact: CapabilityArtifactType): void {
    if (artifact.policyRef !== this.policy.id)
      throw new PolicyDecisionError(
        'POLICY_DENIED',
        'Artifact policy reference does not match the loaded policy',
      );
    for (const step of artifact.steps) {
      this.assertStaticAction(step, artifact);
      if (step.recovery.kind === 'reauthenticate') {
        if (!this.policy.authenticationRecovery.allowed)
          throw new PolicyDecisionError(
            'POLICY_DENIED',
            'Authentication recovery is disabled by policy',
          );
        for (const recoveryStep of step.recovery.steps)
          this.assertAction(recoveryStep.action, recoveryStep.id, artifact, true);
      }
    }
  }

  decide(
    action: CapabilityActionType,
    step: CapabilityStepType | { id: string },
    runId: string,
    attempt: number,
    navigationCount: number,
    recoveryCount: number,
  ): PolicyDecision {
    const actionType = action.kind as PolicyActionKindType;
    const configuredRisk = this.policy.riskByAction[actionType];
    const risk: PolicyRiskType = configuredRisk ?? 'prohibited';
    const base = {
      policyId: this.policy.id,
      policyVersion: this.policy.version,
      policyHash: this.policyHash,
      runId,
      stepId: step.id,
      actionType,
      ...(targetMetadata(action) ? { target: targetMetadata(action) } : {}),
      risk,
      timestamp: new Date().toISOString(),
    };
    if (
      !configuredRisk ||
      !this.policy.allowedActions.includes(actionType) ||
      this.policy.deniedActions.includes(actionType)
    )
      return { ...base, decision: 'deny', reason: 'Action is not explicitly allowed by policy' };
    if (attempt > this.policy.maxActionAttempts)
      return { ...base, decision: 'deny', reason: 'Action attempt limit exceeded' };
    if (navigationCount >= this.policy.navigation.maxNavigations && actionType === 'navigate')
      return { ...base, decision: 'deny', reason: 'Navigation limit exceeded' };
    if (recoveryCount > this.policy.authenticationRecovery.maxAttempts)
      return { ...base, decision: 'deny', reason: 'Authentication recovery limit exceeded' };
    if ('risk' in step && step.risk === 'irreversibleWrite')
      return {
        ...base,
        decision: 'deny',
        risk: 'prohibited',
        reason: 'Consequential actions are prohibited by policy',
      };
    if (actionType === 'navigate') {
      const route = routeFor(action);
      if (!route)
        return { ...base, decision: 'deny', reason: 'Dynamic navigation cannot be pre-approved' };
      let url: URL;
      try {
        url = new URL(route, this.policy.allowedOrigins[0]);
      } catch {
        return { ...base, decision: 'deny', reason: 'Invalid navigation URL' };
      }
      if (
        !this.policy.allowedOrigins.includes(url.origin) ||
        !this.policy.allowedRoutes.some((rule) => new RegExp(rule.pattern).test(url.pathname))
      )
        return { ...base, decision: 'deny', reason: 'Navigation origin or route is not allowed' };
      return {
        ...base,
        decision: 'allow',
        ruleId: 'navigation-allowlist',
        reason: 'Navigation matches the policy allowlist',
      };
    }
    if (action.kind === 'enterText' && action.value.kind === 'secret') {
      if (
        !this.policy.allowedSecretReferences.includes(action.value.name) ||
        !this.policy.allowedSecretStepIds.includes(step.id)
      )
        return {
          ...base,
          decision: 'deny',
          reason: 'Secret reference is not approved for this step',
        };
    }
    if (this.policy.interventionActions.includes(actionType))
      return {
        ...base,
        decision: 'requireIntervention',
        reason: 'Action requires human intervention',
      };
    return {
      ...base,
      decision: 'allow',
      ruleId: `action-${actionType}`,
      reason: 'Action is explicitly allowed',
    };
  }

  assertDecision(decision: PolicyDecision): void {
    if (decision.decision === 'deny')
      throw new PolicyDecisionError('POLICY_DENIED', decision.reason);
    if (decision.decision === 'requireIntervention')
      throw new PolicyDecisionError('POLICY_INTERVENTION_REQUIRED', decision.reason);
  }

  private assertStaticAction(step: CapabilityStepType, artifact: CapabilityArtifactType): void {
    this.assertAction(step.action, step.id, artifact, false);
  }

  private assertAction(
    action: CapabilityActionType,
    stepId: string,
    artifact: CapabilityArtifactType,
    recovery: boolean,
  ): void {
    const decision = this.decide(action, { id: stepId }, 'preflight', 1, 0, recovery ? 1 : 0);
    if (decision.decision !== 'allow')
      throw new PolicyDecisionError('POLICY_DENIED', decision.reason);
    if (
      action.kind === 'enterText' &&
      action.value.kind === 'input' &&
      !(action.value.name in artifact.contract.inputs)
    )
      throw new PolicyDecisionError(
        'POLICY_DENIED',
        `Input ${action.value.name} is not declared by the artifact`,
      );
  }
}
