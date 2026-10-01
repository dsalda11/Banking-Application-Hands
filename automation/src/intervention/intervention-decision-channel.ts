import type { ReplayInterventionDecision } from './intervention-coordinator.js';

export class InterventionDecisionChannelError extends Error {
  constructor(readonly code: 'CHANNEL_CLOSED' | 'CHANNEL_OCCUPIED' | 'RECEIVER_EXISTS') {
    super(code);
  }
}

export type DecisionChannelState = 'idle' | 'waiting' | 'queued' | 'closed';

export class InterventionDecisionChannel {
  private queued: ReplayInterventionDecision | undefined;
  private waiter:
    | {
        resolve: (decision: ReplayInterventionDecision) => void;
        reject: (error: InterventionDecisionChannelError) => void;
      }
    | undefined;
  private isClosed = false;
  private revision = 0;

  snapshot(): {
    epoch: number;
    state: DecisionChannelState;
    queuedKind?: ReplayInterventionDecision['kind'];
  } {
    return {
      epoch: this.revision,
      state: this.isClosed ? 'closed' : this.waiter ? 'waiting' : this.queued ? 'queued' : 'idle',
      ...(this.queued ? { queuedKind: this.queued.kind } : {}),
    };
  }

  enqueue(decision: ReplayInterventionDecision): void {
    if (this.isClosed) throw new InterventionDecisionChannelError('CHANNEL_CLOSED');
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      this.revision += 1;
      waiter.resolve(decision);
      return;
    }
    if (this.queued) throw new InterventionDecisionChannelError('CHANNEL_OCCUPIED');
    this.queued = decision;
    this.revision += 1;
  }

  async receive(): Promise<ReplayInterventionDecision> {
    if (this.queued) {
      const decision = this.queued;
      this.queued = undefined;
      this.revision += 1;
      return decision;
    }
    if (this.isClosed) throw new InterventionDecisionChannelError('CHANNEL_CLOSED');
    if (this.waiter) throw new InterventionDecisionChannelError('RECEIVER_EXISTS');
    this.revision += 1;
    return new Promise<ReplayInterventionDecision>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  close(finalDecision?: ReplayInterventionDecision): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (finalDecision) {
      if (waiter) waiter.resolve(finalDecision);
      else if (!this.queued) this.queued = finalDecision;
    } else {
      this.queued = undefined;
      waiter?.reject(new InterventionDecisionChannelError('CHANNEL_CLOSED'));
    }
    this.revision += 1;
  }
}
