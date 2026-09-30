import { randomBytes, timingSafeEqual } from 'node:crypto';

export type ControlOwner = 'automation' | 'human' | 'none';
export type TakeoverState =
  | 'AUTOMATION_OWNED'
  | 'PAUSE_REQUESTED'
  | 'PAUSED'
  | 'HUMAN_OWNED'
  | 'RESUME_REQUESTED'
  | 'RESUME_VALIDATION'
  | 'COMPLETION_VALIDATION'
  | 'COMPLETED_BY_HUMAN'
  | 'ABORTED'
  | 'LEASE_EXPIRED';

export interface ControlLease {
  readonly runId: string;
  readonly interventionId: string;
  readonly owner: ControlOwner;
  readonly ownerId?: string | undefined;
  readonly generation: number;
  readonly issuedAt: string;
  readonly expiresAt?: string | undefined;
  readonly lastHeartbeat?: string | undefined;
  readonly state: TakeoverState;
  readonly reason: string;
}

export class LeaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LeaseError';
  }
}

export class ControlLeaseManager {
  private lease: ControlLease;
  private token: Buffer | undefined;

  constructor(
    runId: string,
    interventionId: string,
    reason: string,
    private readonly now = () => Date.now(),
  ) {
    const timestamp = new Date(this.now()).toISOString();
    this.lease = {
      runId,
      interventionId,
      owner: 'automation',
      ownerId: 'automation',
      generation: 1,
      issuedAt: timestamp,
      state: 'AUTOMATION_OWNED',
      reason,
    };
  }

  snapshot(): ControlLease {
    this.expireIfNeeded();
    return this.lease;
  }

  requestPause(generation: number): ControlLease {
    this.requireAutomation(generation);
    return this.transition('PAUSE_REQUESTED', 'automation');
  }

  pause(generation: number): ControlLease {
    if (this.lease.generation !== generation || this.lease.state !== 'PAUSE_REQUESTED')
      throw new LeaseError('INVALID_TRANSITION', 'Automation cannot pause from the current state');
    return this.transition('PAUSED', 'none');
  }

  claim(token: string, ownerId: string, ttlMs: number): ControlLease {
    this.expireIfNeeded();
    if (this.lease.state !== 'PAUSED' && this.lease.state !== 'LEASE_EXPIRED')
      throw new LeaseError('LEASE_UNAVAILABLE', 'Human control is not available');
    this.requireToken(token);
    const timestamp = new Date(this.now()).toISOString();
    this.lease = {
      ...this.lease,
      owner: 'human',
      ownerId,
      generation: this.lease.generation + 1,
      issuedAt: timestamp,
      lastHeartbeat: timestamp,
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
      state: 'HUMAN_OWNED',
    };
    return this.lease;
  }

  heartbeat(token: string, generation: number, ttlMs: number): ControlLease {
    this.requireHuman(token, generation);
    const timestamp = new Date(this.now()).toISOString();
    this.lease = {
      ...this.lease,
      lastHeartbeat: timestamp,
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
    };
    return this.lease;
  }

  beginResume(token: string, generation: number): ControlLease {
    this.requireHuman(token, generation);
    return this.transition('RESUME_REQUESTED', 'none');
  }

  handoffToAutomation(token: string, generation: number): ControlLease {
    this.requireHuman(token, generation);
    return this.transition('AUTOMATION_OWNED', 'automation');
  }

  resumeAutomation(generation: number): ControlLease {
    if (this.lease.generation !== generation || this.lease.state !== 'RESUME_REQUESTED')
      throw new LeaseError('INVALID_TRANSITION', 'Automation cannot resume from the current state');
    return this.transition('AUTOMATION_OWNED', 'automation');
  }

  /** Step 8A coordinator-only resume from a safe paused boundary. */
  resumeFromPaused(generation: number): ControlLease {
    if (this.lease.generation !== generation || this.lease.state !== 'PAUSED')
      throw new LeaseError('INVALID_TRANSITION', 'Automation cannot resume from the current state');
    return this.transition('AUTOMATION_OWNED', 'automation');
  }

  rejectResume(generation: number): ControlLease {
    if (this.lease.generation !== generation || this.lease.state !== 'RESUME_REQUESTED')
      throw new LeaseError(
        'INVALID_TRANSITION',
        'Automation cannot reject the current resume request',
      );
    return this.transition('PAUSED', 'none');
  }

  abort(token: string, generation: number): ControlLease {
    this.requireHuman(token, generation);
    this.token = undefined;
    return this.transition('ABORTED', 'none');
  }

  issueOperatorToken(): string {
    const raw = randomBytes(32);
    const token = raw.toString('base64url');
    this.token = Buffer.from(token);
    return token;
  }

  assertAutomation(generation: number): void {
    this.requireAutomation(generation);
  }

  private expireIfNeeded(): void {
    if (
      this.lease.owner === 'human' &&
      this.lease.expiresAt &&
      new Date(this.lease.expiresAt).getTime() <= this.now()
    ) {
      this.lease = {
        ...this.lease,
        owner: 'none',
        generation: this.lease.generation + 1,
        state: 'LEASE_EXPIRED',
      };
    }
  }

  private requireAutomation(generation: number): void {
    this.expireIfNeeded();
    if (
      this.lease.owner !== 'automation' ||
      this.lease.state !== 'AUTOMATION_OWNED' ||
      this.lease.generation !== generation
    )
      throw new LeaseError('AUTOMATION_NOT_OWNER', 'Automation does not own the active lease');
  }

  private requireHuman(token: string, generation: number): void {
    this.expireIfNeeded();
    if (this.lease.owner !== 'human' || this.lease.state !== 'HUMAN_OWNED')
      throw new LeaseError('HUMAN_NOT_OWNER', 'Human does not own the active lease');
    if (this.lease.generation !== generation)
      throw new LeaseError('STALE_LEASE_GENERATION', 'Lease generation is stale');
    this.requireToken(token);
  }

  private requireToken(token: string): void {
    if (!this.token) throw new LeaseError('OPERATOR_TOKEN_INVALID', 'Operator token is invalid');
    const candidate = Buffer.from(token);
    if (candidate.length !== this.token.length || !timingSafeEqual(candidate, this.token))
      throw new LeaseError('OPERATOR_TOKEN_INVALID', 'Operator token is invalid');
  }

  private transition(state: TakeoverState, owner: ControlOwner): ControlLease {
    this.lease = {
      ...this.lease,
      owner,
      ownerId: owner === 'automation' ? 'automation' : undefined,
      generation: this.lease.generation + 1,
      issuedAt: new Date(this.now()).toISOString(),
      expiresAt: undefined,
      lastHeartbeat: undefined,
      state,
    };
    return this.lease;
  }
}
