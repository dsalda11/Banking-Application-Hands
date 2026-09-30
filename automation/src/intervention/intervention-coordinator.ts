import { randomUUID } from 'node:crypto';

import type { PolicyRiskType } from '../domain/policy.js';
import type { SurfaceEvent } from '../surfaces/surface-types.js';
import { LeaseError, type ControlLease, type ControlLeaseManager } from './control-lease.js';
import {
  InterventionDecisionChannel,
  type DecisionChannelState,
} from './intervention-decision-channel.js';
import { startOperatorServer, type OperatorServer } from './operator-server.js';
import {
  systemInterventionScheduler,
  type InterventionScheduler,
} from './intervention-scheduler.js';

/** A sanitized boundary at which replay may safely transfer control. */
export interface SafeActionBoundary {
  readonly lastCompletedStepId?: string;
  readonly pendingStepId: string;
  readonly pendingActionType: string;
  readonly currentUrl?: string;
  readonly retryable: boolean;
  readonly consequential: boolean;
  readonly checkpointDescription?: string;
  readonly leaseGeneration: number;
}

/** No browser handles, credentials, storage, or operator tokens cross this boundary. */
export interface ReplayInterventionRequest {
  readonly interventionId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly stepId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reason: string;
  readonly risk: PolicyRiskType;
  readonly boundary: SafeActionBoundary;
  readonly resumeCheckpointDescription?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type ReplayInterventionDecision =
  | { readonly kind: 'resume'; readonly interventionId: string; readonly leaseGeneration: number }
  | { readonly kind: 'complete'; readonly interventionId: string; readonly leaseGeneration: number }
  | { readonly kind: 'abort'; readonly interventionId: string; readonly leaseGeneration: number }
  | { readonly kind: 'timeout'; readonly interventionId: string; readonly leaseGeneration: number }
  | {
      readonly kind: 'browserSessionLost';
      readonly interventionId: string;
      readonly leaseGeneration: number;
    };

export interface LeaseBoundInterventionCoordinator extends InterventionCoordinator {
  bindLease(lease: ControlLeaseManager): void;
  close(): Promise<void>;
}
export interface ValidationReportingCoordinator {
  restoreHumanOwnership(reason: string): Promise<number>;
  validationFinished(): void;
}

export interface CoordinatorSnapshot {
  readonly revision: number;
  readonly owner: 'automation' | 'human' | 'none';
  readonly generation: number;
  readonly validationState: 'idle' | 'validating' | 'rejected' | 'accepted';
  readonly validationCommand?: 'resume' | 'complete';
  readonly decisionChannelEpoch: number;
  readonly decisionChannelState: DecisionChannelState;
  readonly queuedDecisionType?: ReplayInterventionDecision['kind'];
  readonly leaseState: ControlLease['state'];
  readonly expiresAt?: string;
  readonly lastCommandResult?: string;
  readonly terminal: boolean;
}

/** Step 8A seam. Step 8B will adapt the local operator server to this interface. */
export interface InterventionCoordinator {
  awaitDecision(request: ReplayInterventionRequest): Promise<ReplayInterventionDecision>;
}

/** Test/local coordinator which deliberately blocks until a caller resolves the request. */
export class BlockingInterventionCoordinator implements InterventionCoordinator {
  private pending:
    | {
        request: ReplayInterventionRequest;
        resolve: (decision: ReplayInterventionDecision) => void;
      }
    | undefined;

  async awaitDecision(request: ReplayInterventionRequest): Promise<ReplayInterventionDecision> {
    if (this.pending) throw new Error('An intervention is already awaiting a decision');
    return new Promise<ReplayInterventionDecision>((resolve) => {
      this.pending = { request, resolve };
    });
  }

  get request(): ReplayInterventionRequest | undefined {
    return this.pending?.request;
  }

  decide(decision: ReplayInterventionDecision): void {
    if (!this.pending) throw new Error('No intervention is awaiting a decision');
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(decision);
  }
}

/**
 * One narrow action guard keeps lease assertions out of action handlers.  It is
 * intentionally provider-neutral: it protects every call before the adapter sees it.
 */
export class AutomationActionGuard {
  private generation: number;
  private aborted = false;

  constructor(readonly lease: ControlLeaseManager) {
    this.generation = lease.snapshot().generation;
  }

  assertCanAct(): void {
    if (this.aborted) throw new LeaseError('RUN_ABORTED', 'Replay was aborted by a human');
    this.lease.assertAutomation(this.generation);
  }

  requestPause(): number {
    this.assertCanAct();
    const requested = this.lease.requestPause(this.generation);
    const paused = this.lease.pause(requested.generation);
    this.generation = paused.generation;
    return this.generation;
  }

  resume(generation: number): number {
    const current = this.lease.snapshot();
    const resumed =
      current.state === 'AUTOMATION_OWNED'
        ? current
        : current.state === 'PAUSED'
          ? this.lease.resumeFromPaused(current.generation)
          : this.lease.resumeAutomation(generation);
    this.generation = resumed.generation;
    this.assertCanAct();
    return this.generation;
  }

  abort(): void {
    this.aborted = true;
  }

  rejectResume(generation: number): number {
    const paused = this.lease.rejectResume(generation);
    this.generation = paused.generation;
    return this.generation;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  acceptsDecisionGeneration(generation: number): boolean {
    const current = this.lease.snapshot();
    return generation === this.generation || current.generation === generation;
  }
}

export function createInterventionId(): string {
  return `intervention-${randomUUID()}`;
}

/** Production Step 8B bridge between a paused replay and the loopback console. */
export class OperatorInterventionCoordinator implements LeaseBoundInterventionCoordinator {
  private lease: ControlLeaseManager | undefined;
  private token: string | undefined;
  private server: OperatorServer | undefined;
  private request: ReplayInterventionRequest | undefined;
  private readonly decisions = new InterventionDecisionChannel();
  private validationMessage = 'Waiting for human control';
  private validationInProgress = false;
  private revision = 0;
  private validationState: CoordinatorSnapshot['validationState'] = 'idle';
  private validationCommand: CoordinatorSnapshot['validationCommand'];
  private terminal = false;
  private lastCommandResult: string | undefined;
  private expiryTimer: unknown;
  private expiryGeneration: number | undefined;
  private readonly lifecycleEvents: SurfaceEvent[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly onOperatorUrl?: (url: string) => void,
    private readonly ttlMs = 60_000,
    private readonly scheduler: InterventionScheduler = systemInterventionScheduler,
  ) {}

  bindLease(lease: ControlLeaseManager): void {
    if (this.lease && this.lease !== lease)
      throw new LeaseError('LEASE_ALREADY_BOUND', 'Coordinator is already bound to another replay');
    this.lease = lease;
  }

  async awaitDecision(request: ReplayInterventionRequest): Promise<ReplayInterventionDecision> {
    if (!this.lease) throw new LeaseError('LEASE_NOT_BOUND', 'Coordinator has no replay lease');
    if (this.lease.snapshot().runId !== request.runId)
      throw new LeaseError('LEASE_RUN_MISMATCH', 'Intervention does not match the active replay');
    if (this.request && this.request.interventionId !== request.interventionId)
      throw new LeaseError('INTERVENTION_ALREADY_PENDING', 'An intervention is active');
    this.request = request;
    this.token ??= this.lease.issueOperatorToken();
    if (!this.server) {
      const started = await startOperatorServer({
        getLease: () => this.requireLease().snapshot(),
        token: this.token,
        view: {
          runId: request.runId,
          interventionId: request.interventionId,
          reason: request.reason,
          stepId: request.stepId,
          risk: request.risk,
          resumeCheckpoint: request.resumeCheckpointDescription ?? 'Validate the paused step',
        },
        getStatus: () => {
          const snapshot = this.snapshot();
          return {
            revision: snapshot.revision,
            owner: snapshot.owner,
            generation: snapshot.generation,
            leaseState: snapshot.leaseState,
            ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
            validationState: snapshot.validationState,
            ...(snapshot.validationCommand
              ? { validationCommand: snapshot.validationCommand }
              : {}),
            decisionChannelState: snapshot.decisionChannelState,
            terminal: snapshot.terminal,
            ...(snapshot.lastCommandResult
              ? { lastCommandResult: snapshot.lastCommandResult }
              : {}),
          };
        },
        onRejectedCommand: (command, code) => {
          this.lastCommandResult = `${command}_rejected`;
          this.record(`operator_${command}_rejected`, `Operator command rejected: ${code}`);
          this.publish(this.validationState);
        },
        actions: {
          claim: async () => this.claim(),
          heartbeat: async (generation) => this.heartbeat(generation),
          reclaim: async () => this.reclaim(),
          resume: async (generation) => this.submitResume(generation),
          complete: async (generation) => this.submitComplete(generation),
          abort: async (generation) => this.submitAbort(generation),
        },
      });
      this.server = started;
      this.record('operator_server_started', 'Operator server started');
      this.onOperatorUrl?.(`${started.url}#${this.token}`);
    }
    const decision = this.decisions.receive();
    this.publish(this.validationState);
    return decision;
  }

  async close(): Promise<void> {
    if (this.terminal) return;
    this.clearExpiryTimer();
    this.decisions.close();
    this.request = undefined;
    this.token = undefined;
    if (this.server) await this.server.close();
    this.server = undefined;
    this.terminal = true;
    this.record('operator_server_stopped', 'Operator server stopped');
    this.publish(this.validationState);
  }

  snapshot(): CoordinatorSnapshot {
    const lease = this.observeLease();
    const channel = this.decisions.snapshot();
    return {
      revision: this.revision,
      owner: lease.owner,
      generation: lease.generation,
      validationState: this.validationState,
      ...(this.validationCommand ? { validationCommand: this.validationCommand } : {}),
      decisionChannelEpoch: channel.epoch,
      decisionChannelState: channel.state,
      ...(channel.queuedKind ? { queuedDecisionType: channel.queuedKind } : {}),
      leaseState: lease.state,
      ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
      ...(this.lastCommandResult ? { lastCommandResult: this.lastCommandResult } : {}),
      terminal: this.terminal || lease.state === 'ABORTED',
    };
  }

  async waitForRevisionAfter(
    revision: number,
    predicate: (snapshot: CoordinatorSnapshot) => boolean,
  ): Promise<CoordinatorSnapshot> {
    const current = this.snapshot();
    if (current.revision > revision && predicate(current)) return current;
    return new Promise<CoordinatorSnapshot>((resolve) => {
      const wake = () => {
        const next = this.snapshot();
        if (next.revision > revision && predicate(next)) {
          this.waiters.delete(wake);
          resolve(next);
        }
      };
      this.waiters.add(wake);
      wake();
    });
  }

  async restoreHumanOwnership(reason: string): Promise<number> {
    const lease = this.requireLease();
    const restored = lease.claim(this.requireToken(), 'local-operator', this.ttlMs);
    this.validationMessage = reason;
    this.validationInProgress = false;
    this.lastCommandResult = 'validation_rejected';
    this.armExpiryTimer(restored);
    this.record('human_ownership_restored', reason, restored);
    this.publish('rejected');
    return restored.generation;
  }

  validationFinished(): void {
    this.validationInProgress = false;
    this.lastCommandResult = 'validation_accepted';
    this.publish('accepted');
  }

  /** Sanitized lifecycle events are drained by replay before it writes JSONL evidence. */
  drainEvents(): SurfaceEvent[] {
    return this.lifecycleEvents.splice(0);
  }

  get pendingScheduledWork(): number {
    return this.expiryTimer === undefined ? 0 : 1;
  }

  private async submitResume(
    generation: number,
  ): Promise<{ lease: ControlLease; message?: string }> {
    this.assertNoValidationInProgress();
    const lease = this.requireLease();
    const requested = lease.handoffToAutomation(this.requireToken(), generation);
    this.clearExpiryTimer();
    this.validationInProgress = true;
    this.validationCommand = 'resume';
    this.publish('validating');
    this.enqueue({
      kind: 'resume',
      interventionId: this.requireRequest().interventionId,
      leaseGeneration: requested.generation,
    });
    this.record('resume_requested', 'Resume validation requested', requested);
    return { lease: requested, message: 'Resume validation requested' };
  }

  private async submitComplete(
    generation: number,
  ): Promise<{ lease: ControlLease; message?: string }> {
    this.assertNoValidationInProgress();
    const lease = this.requireLease();
    const requested = lease.beginResume(this.requireToken(), generation);
    this.clearExpiryTimer();
    this.validationInProgress = true;
    this.validationCommand = 'complete';
    this.publish('validating');
    this.enqueue({
      kind: 'complete',
      interventionId: this.requireRequest().interventionId,
      leaseGeneration: requested.generation,
    });
    this.record('completion_requested', 'Completion validation requested', requested);
    return {
      lease: requested,
      message: 'Completion validation requested',
    };
  }

  private async submitAbort(generation: number): Promise<ControlLease> {
    this.assertNoValidationInProgress();
    const lease = this.requireLease();
    const aborted = lease.abort(this.requireToken(), generation);
    this.clearExpiryTimer();
    this.enqueue({
      kind: 'abort',
      interventionId: this.requireRequest().interventionId,
      leaseGeneration: generation,
    });
    this.record('human_abort', 'Human abort accepted', aborted);
    return aborted;
  }

  private claim(): ControlLease {
    const claimed = this.requireLease().claim(this.requireToken(), 'local-operator', this.ttlMs);
    this.lastCommandResult = 'claim_accepted';
    this.armExpiryTimer(claimed);
    this.record('human_claim_accepted', 'Human control claimed', claimed);
    this.publish(this.validationState);
    return claimed;
  }

  private heartbeat(generation: number): ControlLease {
    const renewed = this.requireLease().heartbeat(this.requireToken(), generation, this.ttlMs);
    this.lastCommandResult = 'heartbeat_accepted';
    this.armExpiryTimer(renewed);
    this.record('human_heartbeat', 'Human lease heartbeat accepted', renewed);
    this.publish(this.validationState);
    return renewed;
  }

  private reclaim(): ControlLease {
    const lease = this.observeLease();
    if (lease.state !== 'LEASE_EXPIRED')
      throw new LeaseError('LEASE_NOT_EXPIRED', 'Human control may be reclaimed only after expiry');
    const reclaimed = this.requireLease().claim(this.requireToken(), 'local-operator', this.ttlMs);
    this.lastCommandResult = 'lease_reclaimed';
    this.armExpiryTimer(reclaimed);
    this.record('lease_reclaimed', 'Expired human lease reclaimed', reclaimed);
    this.publish(this.validationState);
    return reclaimed;
  }

  private armExpiryTimer(lease: ControlLease): void {
    this.clearExpiryTimer();
    if (lease.owner !== 'human' || !lease.expiresAt) return;
    const delay = Math.max(0, new Date(lease.expiresAt).getTime() - this.scheduler.now());
    this.expiryTimer = this.scheduler.setTimeout(() => {
      this.expiryTimer = undefined;
      this.observeLease();
    }, delay);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== undefined) this.scheduler.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private observeLease(): ControlLease {
    const lease = this.requireLease().snapshot();
    if (lease.state === 'LEASE_EXPIRED' && this.expiryGeneration !== lease.generation) {
      this.expiryGeneration = lease.generation;
      this.lastCommandResult = 'lease_expired';
      this.clearExpiryTimer();
      this.record('lease_expired', 'Human lease expired; automation remains paused', lease);
      this.publish(this.validationState);
    }
    return lease;
  }

  private record(eventType: string, reason: string, lease = this.requireLease().snapshot()): void {
    this.lifecycleEvents.push({
      timestamp: new Date(this.scheduler.now()).toISOString(),
      ...(this.request
        ? { runId: this.request.runId, interventionId: this.request.interventionId }
        : {}),
      generation: lease.generation,
      coordinatorRevision: this.revision,
      eventType,
      action: 'operator',
      reason: `${reason}; generation=${lease.generation}; owner=${lease.owner}`,
      ok: !eventType.includes('rejected') && !eventType.includes('expired'),
    });
  }

  private requireLease(): ControlLeaseManager {
    if (!this.lease) throw new LeaseError('LEASE_NOT_BOUND', 'Coordinator has no replay lease');
    return this.lease;
  }

  private requireToken(): string {
    if (!this.token)
      throw new LeaseError('OPERATOR_TOKEN_INVALID', 'Operator token is unavailable');
    return this.token;
  }

  private requireRequest(): ReplayInterventionRequest {
    if (!this.request)
      throw new LeaseError('INTERVENTION_NOT_PENDING', 'No intervention is awaiting a decision');
    return this.request;
  }

  private enqueue(decision: ReplayInterventionDecision): void {
    try {
      this.decisions.enqueue(decision);
      this.publish(this.validationState);
    } catch {
      throw new LeaseError(
        'INTERVENTION_DECISION_UNAVAILABLE',
        'Intervention decision cannot be accepted',
      );
    }
  }

  private assertNoValidationInProgress(): void {
    if (this.validationInProgress)
      throw new LeaseError(
        'VALIDATION_IN_PROGRESS',
        'Another validation command is already active',
      );
  }

  private publish(state: CoordinatorSnapshot['validationState']): void {
    this.validationState = state;
    if (state !== 'validating') this.validationCommand = undefined;
    this.revision += 1;
    for (const wake of this.waiters) wake();
  }
}
