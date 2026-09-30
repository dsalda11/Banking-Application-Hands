import { describe, expect, it } from 'vitest';
import { ControlLeaseManager, LeaseError } from '../../src/intervention/control-lease.js';
import { AutomationActionGuard } from '../../src/intervention/intervention-coordinator.js';

describe('ControlLeaseManager', () => {
  it('enforces exclusive ownership, fencing, heartbeat, expiry, and explicit reclaim', () => {
    let now = 1_000;
    const manager = new ControlLeaseManager('run', 'intervention', 'test', () => now);
    const token = manager.issueOperatorToken();
    const paused = manager.pause(manager.requestPause(1).generation);
    const human = manager.claim(token, 'operator', 100);
    expect(human.owner).toBe('human');
    expect(() => manager.assertAutomation(paused.generation)).toThrow(LeaseError);
    expect(() => manager.claim(token, 'other', 100)).toThrow(LeaseError);
    expect(manager.heartbeat(token, human.generation, 100).owner).toBe('human');
    now = 2_000;
    expect(manager.snapshot().state).toBe('LEASE_EXPIRED');
    expect(() => manager.beginResume(token, human.generation)).toThrow(LeaseError);
    expect(manager.claim(token, 'operator', 100).owner).toBe('human');
  });

  it('rejects stale tokens and aborts terminally', () => {
    const manager = new ControlLeaseManager('run', 'intervention', 'test');
    const token = manager.issueOperatorToken();
    manager.pause(manager.requestPause(1).generation);
    const human = manager.claim(token, 'operator', 1000);
    expect(() => manager.heartbeat('wrong', human.generation, 1000)).toThrow(LeaseError);
    expect(manager.abort(token, human.generation).state).toBe('ABORTED');
  });

  it('blocks automation before a surface call while human ownership or a stale generation exists', () => {
    const manager = new ControlLeaseManager('run', 'intervention', 'test');
    const guard = new AutomationActionGuard(manager);
    const token = manager.issueOperatorToken();
    const pausedGeneration = guard.requestPause();
    manager.claim(token, 'operator', 1000);
    expect(() => guard.assertCanAct()).toThrow(LeaseError);
    expect(() => guard.resume(pausedGeneration)).toThrow(LeaseError);
  });
});
