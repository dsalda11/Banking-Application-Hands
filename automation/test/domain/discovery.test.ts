import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DiscoveryGoal,
  DiscoveryProposal,
  type DiscoveryGoalType,
  type DiscoveryObservationType,
  type DiscoveryTraceEventType,
} from '../../src/domain/discovery.js';
import { ReplayPolicy, type ReplayPolicyType } from '../../src/domain/policy.js';
import { DiscoveryOrchestrator } from '../../src/discovery/discovery-orchestrator.js';
import { loadDiscoveryGoal } from '../../src/discovery/goal-loader.js';
import { PlannerFailure, ScriptedPlannerClient } from '../../src/discovery/planner-client.js';
import { sanitizeObservation } from '../../src/surfaces/web/observation-collector.js';
import type { SurfaceAdapter } from '../../src/surfaces/surface-types.js';

const baseUrl = 'http://127.0.0.1:4173';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function goal(overrides: Partial<DiscoveryGoalType> = {}): DiscoveryGoalType {
  return DiscoveryGoal.parse({
    schemaVersion: '1.0.0',
    id: 'fixture-discovery',
    version: '1.0.0',
    objective: 'Find a customer and return a typed answer.',
    startUrl: `${baseUrl}/start`,
    inputs: {
      customerUsername: { description: 'customer', shape: { kind: 'string', minLength: 1 } },
    },
    secretReferences: ['TEST_PASSWORD'],
    outputs: { answer: { description: 'answer', shape: { kind: 'string', minLength: 1 } } },
    successCriteria: [
      { kind: 'outputMatchesShape', description: 'typed answer', output: 'answer' },
    ],
    businessOutcomes: [
      {
        code: 'CUSTOMER_NOT_FOUND',
        result: 'businessOutcome',
        description: 'missing customer',
        detection: { kind: 'textPresent', description: 'missing', text: 'Not found' },
      },
    ],
    applicationScope: { allowedOrigins: [baseUrl], allowedRoutePatterns: ['^/.*$'] },
    budgets: {
      maxModelCalls: 12,
      maxActions: 12,
      timeoutMs: 10_000,
      maxRepeatedStates: 3,
      maxConsecutiveFailures: 2,
      maxNavigations: 4,
    },
    allowHumanIntervention: true,
    screenshotPolicy: 'disabled',
    policyRef: 'fixture-discovery-policy',
    ...overrides,
  });
}

function policy(): ReplayPolicyType {
  return ReplayPolicy.parse({
    schemaVersion: '1.0.0',
    id: 'fixture-discovery-policy',
    version: '1.0.0',
    description: 'fixture discovery policy',
    allowedOrigins: [baseUrl],
    allowedRoutes: [{ id: 'fixture', pattern: '^/.*$' }],
    allowedActions: ['navigate', 'activate', 'enterText', 'pressKey', 'scroll', 'extract'],
    deniedActions: [],
    riskByAction: {
      navigate: 'navigation',
      activate: 'read',
      enterText: 'input',
      selectOption: 'prohibited',
      pressKey: 'input',
      scroll: 'read',
      wait: 'prohibited',
      extract: 'read',
    },
    allowedSecretReferences: ['TEST_PASSWORD'],
    allowedSecretStepIds: ['discovery-enterSecret'],
    screenshotRules: { enabled: false, forbidWhileSecretFieldPopulated: true },
    traceRules: { enabled: false, startAfterAuthentication: true },
    navigation: { allowExternal: false, maxNavigations: 4 },
    downloads: 'deny',
    uploads: 'deny',
    maxReplayDurationMs: 10_000,
    maxActionAttempts: 1,
    authenticationRecovery: { allowed: false, maxAttempts: 1 },
    interventionActions: [],
    interventionStepIds: [],
    defaultDecision: 'deny',
    metadata: { createdAt: '2026-09-30T00:00:00Z' },
  });
}

function observation(state = 0): DiscoveryObservationType {
  return {
    observationId: `obs-${state + 1}`,
    capturedAt: '2026-09-30T00:00:00.000Z',
    url: `${baseUrl}/state-${state}`,
    title: 'Fixture',
    headings: ['Fixture'],
    visibleText: ['Safe visible text'],
    elements: [
      {
        reference: 'field',
        role: 'textbox',
        name: 'Value',
        framePath: [],
        frameId: 'main',
        tagName: 'input',
        inputType: 'text',
        visible: true,
        enabled: true,
        editable: true,
        locatorCandidates: [
          {
            strategy: 'role',
            role: 'textbox',
            name: { kind: 'literal', value: 'Value' },
            exact: true,
          },
        ],
      },
    ],
    frames: [{ id: 'main', url: `${baseUrl}/state-${state}` }],
    scroll: { x: 0, y: 0 },
    stateFingerprint: hash(`state-${state}`),
    evidence: [],
  };
}

class FakeDiscoverySurface implements SurfaceAdapter {
  state = 0;
  closed = false;
  actions = 0;
  traces: DiscoveryTraceEventType[] = [];
  staticObservation = false;
  checkpointPass = true;
  failActions = false;
  observationSequence: number[] = [];
  async start() {}
  async observe() {
    return observation(
      this.observationSequence.length
        ? this.observationSequence.shift()!
        : this.staticObservation
          ? 0
          : this.state,
    );
  }
  async execute(
    action: Parameters<SurfaceAdapter['execute']>[0],
    context: Parameters<SurfaceAdapter['execute']>[1],
  ) {
    this.actions += 1;
    if (this.failActions)
      return {
        ok: false,
        action: action.kind,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        url: `${baseUrl}/state-${this.state}`,
        error: { code: 'ACTION_TIMEOUT', message: 'fixture failure', retryable: true } as never,
      };
    if (!this.staticObservation) this.state += 1;
    if (action.kind === 'extract') {
      context.outputs[action.output] = 'verified';
      return {
        ok: true,
        action: action.kind,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        url: `${baseUrl}/state-${this.state}`,
        output: { name: action.output, value: 'verified' },
      };
    }
    return {
      ok: true,
      action: action.kind,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      url: `${baseUrl}/state-${this.state}`,
    };
  }
  async evaluateCheckpoint(
    _checkpoint: Parameters<SurfaceAdapter['evaluateCheckpoint']>[0],
    context: Parameters<SurfaceAdapter['evaluateCheckpoint']>[1],
  ) {
    return {
      passed: this.checkpointPass && Boolean(context.outputs.answer ?? true),
      kind: 'fixture',
      description: 'fixture checkpoint',
      observedState: { passed: this.checkpointPass },
      durationMs: 0,
    };
  }
  async captureScreenshot(): Promise<never> {
    throw new Error('screenshots disabled');
  }
  async startTrace(): Promise<never> {
    throw new Error('traces disabled');
  }
  async stopTrace() {
    return undefined;
  }
  async writeObservation(): Promise<never> {
    throw new Error('not used');
  }
  async writeResult() {
    return {
      evidenceId: 'result',
      kind: 'result' as const,
      path: 'result.json',
      sanitization: 'sanitized' as const,
    };
  }
  async writeEventLog(): Promise<never> {
    throw new Error('not used');
  }
  async writeDiscoveryTrace(events: readonly DiscoveryTraceEventType[]) {
    this.traces = [...events];
    return {
      evidenceId: 'trace',
      kind: 'eventLog' as const,
      path: 'events.jsonl',
      sanitization: 'sanitized' as const,
    };
  }
  async close() {
    this.closed = true;
  }
}

function proposal(
  request: { observation: DiscoveryObservationType },
  kind: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    proposalId: `proposal-${kind}`,
    observationId: request.observation.observationId,
    stateFingerprint: request.observation.stateFingerprint,
    rationale: 'Bounded deterministic test proposal.',
    expectedPostcondition: 'The fixture changes state.',
    ...extra,
  };
}

function options(
  surface: FakeDiscoverySurface,
  planner: ScriptedPlannerClient,
  goalValue = goal(),
) {
  const policyValue = policy();
  return {
    loadedGoal: { goal: goalValue, contentHash: hash(goalValue), path: 'fixture-goal.json' },
    loadedPolicy: {
      policy: policyValue,
      contentHash: hash(policyValue),
      path: 'fixture-policy.json',
    },
    inputs: { customerUsername: 'customer' },
    secrets: { TEST_PASSWORD: 'confidential-sentinel' },
    adapter: surface,
    planner,
    evidenceDirectory: '/tmp/discovery-unit',
    headless: true,
  } as const;
}

describe('bounded discovery contracts and orchestration', () => {
  it('loads and hashes the checked-in banking discovery goal', async () => {
    const loaded = await loadDiscoveryGoal(
      new URL('../../../artifacts/goals/lookup-customer-account.goal.json', import.meta.url)
        .pathname,
    );
    expect(loaded.goal.id).toBe('banking.discover-customer-account');
    expect(loaded.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates strict goals and proposals and rejects executable or unknown fields', () => {
    expect(goal().id).toBe('fixture-discovery');
    expect(DiscoveryProposal.safeParse({ kind: 'shell', command: 'id' }).success).toBe(false);
    const valid = proposal({ observation: observation() }, 'click', {
      elementReference: 'field',
    });
    expect(DiscoveryProposal.safeParse(valid).success).toBe(true);
    expect(DiscoveryProposal.safeParse({ ...valid, javascript: 'alert(1)' }).success).toBe(false);
  });

  it('redacts confidential values and keeps observations bounded', () => {
    const raw = { ...observation(), visibleText: ['password=confidential-sentinel'] };
    const sanitized = sanitizeObservation(raw, ['confidential-sentinel']);
    expect(JSON.stringify(sanitized)).not.toContain('confidential-sentinel');
    expect(JSON.stringify(sanitized).length).toBeLessThan(131_072);
  });

  it('executes one validated proposal at a time and completes with typed output', async () => {
    const surface = new FakeDiscoverySurface();
    const planner = new ScriptedPlannerClient((request, call) =>
      call === 0
        ? proposal(request, 'enterSecret', {
            elementReference: 'field',
            secretName: 'TEST_PASSWORD',
          })
        : call === 1
          ? proposal(request, 'extract', {
              elementReference: 'field',
              outputName: 'answer',
              transform: 'trim',
            })
          : proposal(request, 'finish'),
    );
    const result = await new DiscoveryOrchestrator().run(options(surface, planner));
    expect(result).toMatchObject({ status: 'success', outputs: { answer: 'verified' } });
    expect(surface.closed).toBe(true);
    expect(surface.traces.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'planner_proposal',
        'policy_decision',
        'action_executed',
        'action_result',
        'run_completed',
      ]),
    );
    expect(JSON.stringify(surface.traces)).not.toContain('confidential-sentinel');
  });

  it('fails closed for stale observations and off-origin navigation', async () => {
    for (const raw of [
      (request: { observation: DiscoveryObservationType }) => ({
        ...proposal(request, 'click', { elementReference: 'field' }),
        stateFingerprint: '0'.repeat(64),
      }),
      (request: { observation: DiscoveryObservationType }) =>
        proposal(request, 'navigate', { url: 'https://example.com/' }),
    ]) {
      const result = await new DiscoveryOrchestrator().run(
        options(new FakeDiscoverySurface(), new ScriptedPlannerClient(raw)),
      );
      expect(result.status).toBe('stopped');
      if (result.status === 'stopped')
        expect(['STALE_OBSERVATION', 'POLICY_DENIED']).toContain(result.code);
    }
  });

  it('recognizes a declared business outcome only after local checkpoint evaluation', async () => {
    const result = await new DiscoveryOrchestrator().run(
      options(
        new FakeDiscoverySurface(),
        new ScriptedPlannerClient((request) =>
          proposal(request, 'reportBusinessOutcome', { outcomeCode: 'CUSTOMER_NOT_FOUND' }),
        ),
      ),
    );
    expect(result).toMatchObject({
      status: 'businessOutcome',
      outcome: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('terminates on repeated state, action budget, provider failure, and cancellation', async () => {
    const repeated = new FakeDiscoverySurface();
    repeated.staticObservation = true;
    const repeatedResult = await new DiscoveryOrchestrator().run(
      options(
        repeated,
        new ScriptedPlannerClient((request, call) =>
          proposal(request, 'assertCheckpoint', {
            proposalId: `repeat-${call}`,
            checkpoint: { kind: 'textPresent', description: 'fixture', text: 'fixture' },
          }),
        ),
      ),
    );
    expect(repeatedResult).toMatchObject({ status: 'stopped', code: 'REPEATED_STATE' });

    const limitedGoal = goal({ budgets: { ...goal().budgets, maxActions: 1 } });
    const limited = await new DiscoveryOrchestrator().run(
      options(new FakeDiscoverySurface(), new ScriptedPlannerClient([]), limitedGoal),
    );
    expect(limited).toMatchObject({
      status: 'stopped',
      code: 'ACTION_BUDGET_EXHAUSTED',
    });

    const provider = await new DiscoveryOrchestrator().run(
      options(
        new FakeDiscoverySurface(),
        new ScriptedPlannerClient(() => new PlannerFailure('REFUSAL', 'refused', false)),
      ),
    );
    expect(provider).toMatchObject({ status: 'stopped', code: 'PROVIDER_FAILURE' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await new DiscoveryOrchestrator().run({
      ...options(new FakeDiscoverySurface(), new ScriptedPlannerClient([])),
      cancellationSignal: controller.signal,
    });
    expect(cancelled).toMatchObject({ status: 'stopped', code: 'CANCELLED' });
  });

  it('bounds provider retries, model calls, wall time, failures, and alternating loops', async () => {
    let providerCalls = 0;
    const provider = await new DiscoveryOrchestrator().run(
      options(
        new FakeDiscoverySurface(),
        new ScriptedPlannerClient(() => {
          providerCalls += 1;
          return new PlannerFailure('TIMEOUT', 'provider timeout', true);
        }),
      ),
    );
    expect(providerCalls).toBe(2);
    expect(provider).toMatchObject({ status: 'stopped', code: 'CONSECUTIVE_FAILURES' });

    const oneCallGoal = goal({ budgets: { ...goal().budgets, maxModelCalls: 1 } });
    const oneCall = await new DiscoveryOrchestrator().run(
      options(
        new FakeDiscoverySurface(),
        new ScriptedPlannerClient((request) =>
          proposal(request, 'assertCheckpoint', {
            checkpoint: { kind: 'textPresent', description: 'fixture', text: 'Fixture' },
          }),
        ),
        oneCallGoal,
      ),
    );
    expect(oneCall).toMatchObject({ status: 'stopped', code: 'MODEL_CALL_BUDGET_EXHAUSTED' });

    let clock = 0;
    const timed = await new DiscoveryOrchestrator().run({
      ...options(
        new FakeDiscoverySurface(),
        new ScriptedPlannerClient((request) => {
          clock = 20_000;
          return proposal(request, 'assertCheckpoint', {
            checkpoint: { kind: 'textPresent', description: 'fixture', text: 'Fixture' },
          });
        }),
      ),
      now: () => clock,
    });
    expect(timed).toMatchObject({ status: 'stopped', code: 'DISCOVERY_TIMEOUT' });

    const failedSurface = new FakeDiscoverySurface();
    failedSurface.failActions = true;
    const failed = await new DiscoveryOrchestrator().run(
      options(
        failedSurface,
        new ScriptedPlannerClient((request, call) =>
          proposal(request, 'click', {
            proposalId: `failed-${call}`,
            elementReference: 'field',
          }),
        ),
      ),
    );
    expect(failed).toMatchObject({ status: 'stopped', code: 'CONSECUTIVE_FAILURES' });

    const alternatingSurface = new FakeDiscoverySurface();
    alternatingSurface.observationSequence = [0, 1, 0, 1];
    const alternating = await new DiscoveryOrchestrator().run(
      options(
        alternatingSurface,
        new ScriptedPlannerClient((request, call) =>
          proposal(request, 'assertCheckpoint', {
            proposalId: `alternating-${call}`,
            checkpoint: { kind: 'textPresent', description: 'fixture', text: 'Fixture' },
          }),
        ),
      ),
    );
    expect(alternating).toMatchObject({ status: 'stopped', code: 'REPEATED_STATE' });
  });
});
