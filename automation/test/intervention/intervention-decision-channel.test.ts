import { describe, expect, it } from 'vitest';

import {
  InterventionDecisionChannel,
  InterventionDecisionChannelError,
} from '../../src/intervention/intervention-decision-channel.js';
import type { ReplayInterventionDecision } from '../../src/intervention/intervention-coordinator.js';

const decision = (kind: ReplayInterventionDecision['kind']): ReplayInterventionDecision => ({
  kind,
  interventionId: 'intervention-test',
  leaseGeneration: 7,
});

describe('InterventionDecisionChannel', () => {
  it('durably consumes an enqueue made before receive', async () => {
    const channel = new InterventionDecisionChannel();
    const queued = decision('complete');
    channel.enqueue(queued);
    expect(channel.snapshot()).toMatchObject({ state: 'queued', queuedKind: 'complete' });
    await expect(channel.receive()).resolves.toEqual(queued);
    expect(channel.snapshot().state).toBe('idle');
  });

  it('resolves an active receiver exactly once', async () => {
    const channel = new InterventionDecisionChannel();
    const receiver = channel.receive();
    expect(channel.snapshot().state).toBe('waiting');
    const queued = decision('resume');
    channel.enqueue(queued);
    await expect(receiver).resolves.toEqual(queued);
    expect(channel.snapshot().state).toBe('idle');
  });

  it('does not lose decisions across repeated enqueue and receive cycles', async () => {
    const channel = new InterventionDecisionChannel();
    const first = channel.receive();
    channel.enqueue(decision('resume'));
    await expect(first).resolves.toMatchObject({ kind: 'resume' });

    channel.enqueue(decision('complete'));
    await expect(channel.receive()).resolves.toMatchObject({ kind: 'complete' });

    const third = channel.receive();
    channel.enqueue(decision('abort'));
    await expect(third).resolves.toMatchObject({ kind: 'abort' });
    expect(channel.snapshot().state).toBe('idle');
  });

  it('rejects a second queued decision without replacing the first', async () => {
    const channel = new InterventionDecisionChannel();
    const first = decision('complete');
    channel.enqueue(first);
    expect(() => channel.enqueue(decision('abort'))).toThrow(InterventionDecisionChannelError);
    await expect(channel.receive()).resolves.toEqual(first);
  });

  it('settles receivers and rejects future work after idempotent close', async () => {
    const channel = new InterventionDecisionChannel();
    const receiver = channel.receive();
    channel.close();
    channel.close();
    await expect(receiver).rejects.toMatchObject({ code: 'CHANNEL_CLOSED' });
    expect(() => channel.enqueue(decision('abort'))).toThrow(InterventionDecisionChannelError);
    await expect(channel.receive()).rejects.toMatchObject({ code: 'CHANNEL_CLOSED' });
    expect(channel.snapshot().state).toBe('closed');
  });
});
