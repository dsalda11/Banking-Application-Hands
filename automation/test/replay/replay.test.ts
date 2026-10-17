import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityAction, type CapabilityActionType } from '../../src/domain/index.js';
import { CapabilityArtifact } from '../../src/domain/artifact.js';
import { loadArtifact } from '../../src/replay/artifact-loader.js';
import { ArtifactRegistry, ArtifactRegistryError } from '../../src/replay/artifact-registry.js';
import { validateRuntimeBindings, RuntimeBindingError } from '../../src/replay/runtime-bindings.js';
import { ReplayEngine } from '../../src/replay/replay-engine.js';
import {
  loadPolicy,
  PolicyLoadError,
  PolicyRegistry,
  PolicyRegistryError,
} from '../../src/policy/policy-loader.js';
import { PolicyDecisionError, PolicyEngine } from '../../src/policy/policy-engine.js';
import type { SurfaceAdapter, SurfaceEvent } from '../../src/surfaces/surface-types.js';
import { SurfaceError } from '../../src/surfaces/surface-errors.js';

const examplePath = path.resolve(
  process.cwd(),
  '../artifacts/lookup-customer-account.v1.example.json',
);

describe('artifact loading and registry', () => {
  it('loads a validated artifact and computes a stable content hash', async () => {
    const first = await loadArtifact(examplePath);
    const second = await loadArtifact(examplePath);
    expect(first.artifact.id).toBe('banking.lookup-customer-account');
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('rejects malformed and unsupported artifacts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'replay-artifact-'));
    const malformed = path.join(directory, 'malformed.json');
    await writeFile(malformed, '{', 'utf8');
    await expect(loadArtifact(malformed)).rejects.toMatchObject({
      code: 'ARTIFACT_MALFORMED_JSON',
    });
    const raw = JSON.parse(await readFile(examplePath, 'utf8')) as Record<string, unknown>;
    raw.schemaVersion = '9.0.0';
    const unsupported = path.join(directory, 'unsupported.json');
    await writeFile(unsupported, JSON.stringify(raw), 'utf8');
    await expect(loadArtifact(unsupported)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ARTIFACT_VERSION',
    });
  });

  it('rejects schema and semantic defects through the production artifact loader', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'replay-invalid-artifact-'));
    const original = JSON.parse(await readFile(examplePath, 'utf8')) as Record<string, unknown>;
    const cases: Array<{
      name: string;
      mutate(value: Record<string, unknown>): void;
      code: string;
    }> = [
      {
        name: 'missing-contract',
        mutate: (value) => void delete value.contract,
        code: 'ARTIFACT_SCHEMA_INVALID',
      },
      {
        name: 'invalid-checkpoint',
        mutate: (value) => {
          (value.steps as Array<Record<string, unknown>>)[0]!.checkpoint = {
            kind: 'unknownCheckpoint',
            description: 'invalid',
          };
        },
        code: 'ARTIFACT_SCHEMA_INVALID',
      },
      {
        name: 'malformed-locator',
        mutate: (value) => {
          const step = (value.steps as Array<Record<string, unknown>>)[1]!;
          const action = step.action as Record<string, unknown>;
          const target = action.target as Record<string, unknown>;
          target.candidates = [];
        },
        code: 'ARTIFACT_SCHEMA_INVALID',
      },
      {
        name: 'invalid-business-outcome',
        mutate: (value) => {
          const contract = value.contract as Record<string, unknown>;
          const outcome = (contract.businessOutcomes as Array<Record<string, unknown>>)[0]!;
          outcome.result = 'infrastructureFailure';
        },
        code: 'ARTIFACT_SCHEMA_INVALID',
      },
      {
        name: 'undeclared-output',
        mutate: (value) => {
          const steps = value.steps as Array<Record<string, unknown>>;
          const extract = steps.find(
            (step) => (step.action as Record<string, unknown>).kind === 'extract',
          )!;
          (extract.action as Record<string, unknown>).output = 'undeclaredOutput';
        },
        code: 'ARTIFACT_SEMANTIC_INVALID',
      },
    ];
    for (const testCase of cases) {
      const value = structuredClone(original);
      testCase.mutate(value);
      const file = path.join(directory, `${testCase.name}.json`);
      await writeFile(file, JSON.stringify(value), 'utf8');
      await expect(loadArtifact(file), testCase.name).rejects.toMatchObject({
        code: testCase.code,
      });
    }
  });

  it('rejects duplicate registry identity', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'replay-registry-'));
    const raw = await readFile(examplePath, 'utf8');
    await writeFile(path.join(directory, 'a.json'), raw, 'utf8');
    await writeFile(path.join(directory, 'b.json'), raw, 'utf8');
    const registry = new ArtifactRegistry(directory);
    await expect(registry.discover()).rejects.toBeInstanceOf(ArtifactRegistryError);
  });
});

describe('fail-closed policy', () => {
  it('loads the strict policy and denies external navigation and unapproved secrets', async () => {
    const loaded = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );
    const engine = new PolicyEngine(loaded.policy, loaded.contentHash);
    const external = CapabilityAction.parse({
      kind: 'navigate',
      destination: { kind: 'absoluteUrl', url: 'https://example.com' },
    });
    expect(engine.decide(external, { id: 'step' }, 'run', 1, 0, 0).decision).toBe('deny');
    const secretAction = CapabilityAction.parse({
      kind: 'enterText',
      target: {
        description: 'field',
        candidates: [
          { strategy: 'attribute', name: 'name', value: { kind: 'literal', value: 'x' } },
        ],
        match: 'exactlyOne',
      },
      value: { kind: 'secret', name: 'UNAPPROVED_SECRET' },
      clear: true,
    });
    expect(engine.decide(secretAction, { id: 'step' }, 'run', 1, 0, 0).decision).toBe('deny');
  });

  it('blocks disallowed routes, actions, risks, attempts, and navigation counts', async () => {
    const loadedPolicy = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );
    const engine = new PolicyEngine(loadedPolicy.policy, loadedPolicy.contentHash);
    const disallowedRoute = CapabilityAction.parse({
      kind: 'navigate',
      destination: { kind: 'relativeRoute', route: '/admin/delete' },
    });
    expect(engine.decide(disallowedRoute, { id: 'route' }, 'run', 1, 0, 0).decision).toBe('deny');

    const activate = CapabilityAction.parse({
      kind: 'activate',
      target: {
        description: 'control',
        candidates: [{ strategy: 'css', selector: 'button' }],
        match: 'exactlyOne',
      },
    });
    const deniedActionEngine = new PolicyEngine(
      { ...loadedPolicy.policy, deniedActions: [...loadedPolicy.policy.deniedActions, 'activate'] },
      loadedPolicy.contentHash,
    );
    expect(deniedActionEngine.decide(activate, { id: 'action' }, 'run', 1, 0, 0).decision).toBe(
      'deny',
    );
    expect(
      engine.decide(
        activate,
        { id: 'attempt' },
        'run',
        loadedPolicy.policy.maxActionAttempts + 1,
        0,
        0,
      ).decision,
    ).toBe('deny');
    expect(
      engine.decide(
        CapabilityAction.parse({
          kind: 'navigate',
          destination: { kind: 'relativeRoute', route: '/index' },
        }),
        { id: 'navigation' },
        'run',
        1,
        loadedPolicy.policy.navigation.maxNavigations,
        0,
      ).decision,
    ).toBe('deny');
    expect(
      engine.decide(activate, { id: 'risky', risk: 'irreversibleWrite' } as never, 'run', 1, 0, 0)
        .decision,
    ).toBe('deny');
  });

  it('rejects irreversible actions during preflight instead of waiting for runtime', async () => {
    const loadedPolicy = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );
    const loadedArtifact = await loadArtifact(examplePath);
    const raw = structuredClone(loadedArtifact.artifact) as unknown as Record<string, unknown>;
    const steps = raw.steps as Array<Record<string, unknown>>;
    steps[1]!.risk = 'irreversibleWrite';
    const artifact = CapabilityArtifact.parse(raw);
    const engine = new PolicyEngine(loadedPolicy.policy, loadedPolicy.contentHash);
    expect(() => engine.preflight(artifact)).toThrowError(PolicyDecisionError);
    try {
      engine.preflight(artifact);
      throw new Error('expected policy preflight to reject irreversible action');
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: 'POLICY_DENIED',
        decision: expect.objectContaining({ risk: 'prohibited', stepId: steps[1]!.id }),
      });
    }
  });

  it('rejects unsupported policies and duplicate policy identities', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'replay-policy-'));
    const raw = JSON.parse(
      await readFile(
        path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    raw.schemaVersion = '9.0.0';
    const unsupported = path.join(directory, 'unsupported.json');
    await writeFile(unsupported, JSON.stringify(raw), 'utf8');
    await expect(loadPolicy(unsupported)).rejects.toBeInstanceOf(PolicyLoadError);
    const valid = await readFile(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
      'utf8',
    );
    await writeFile(path.join(directory, 'a.json'), valid, 'utf8');
    await writeFile(path.join(directory, 'b.json'), valid, 'utf8');
    await expect(new PolicyRegistry(directory).discover()).rejects.toBeInstanceOf(
      PolicyRegistryError,
    );
    const invalidPattern = JSON.parse(valid) as { allowedRoutes: Array<{ pattern: string }> };
    invalidPattern.allowedRoutes[0]!.pattern = '[';
    const invalidPatternPath = path.join(directory, 'invalid-pattern.json');
    await writeFile(invalidPatternPath, JSON.stringify(invalidPattern), 'utf8');
    await expect(loadPolicy(invalidPatternPath)).rejects.toMatchObject({
      code: 'POLICY_PATTERN_INVALID',
    });
  });
});

describe('runtime bindings', () => {
  it('validates declared inputs and keeps secrets separate', async () => {
    const loaded = await loadArtifact(examplePath);
    const bindings = validateRuntimeBindings(
      loaded.artifact,
      { customerUsername: 'customer' },
      { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
    );
    expect(bindings.inputs).toEqual({ customerUsername: 'customer' });
    expect(bindings.secretNames).not.toContain('admin');
    expect(() => validateRuntimeBindings(loaded.artifact, {}, bindings.secrets)).toThrowError(
      RuntimeBindingError,
    );
    try {
      validateRuntimeBindings(loaded.artifact, { customerUsername: 123 }, bindings.secrets);
      throw new Error('expected an input type mismatch');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'INPUT_TYPE_MISMATCH' });
    }
    try {
      validateRuntimeBindings(
        loaded.artifact,
        { customerUsername: 'customer' },
        { ...bindings.secrets, EXTRA_SECRET: 'fake-only' },
      );
      throw new Error('expected an undeclared secret rejection');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'UNDECLARED_SECRET' });
    }
  });
});

function fakeAdapter(): SurfaceAdapter & { actions: string[] } {
  const actions: string[] = [];
  let outputs: Record<string, unknown> = {};
  return {
    actions,
    async start() {},
    async observe() {
      return {
        observationId: 'obs-1',
        url: 'http://bank.test',
        title: 'Test',
        elements: [],
      } as never;
    },
    async execute(action: CapabilityActionType, context) {
      actions.push(action.kind);
      if (action.kind === 'extract') {
        outputs = { ...outputs, [action.output]: action.output === 'answer' ? 'ok' : undefined };
        context.outputs[action.output] = outputs[action.output];
      }
      return {
        ok: true,
        action: action.kind,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        url: 'http://bank.test',
      };
    },
    async evaluateCheckpoint(checkpoint) {
      const passed =
        checkpoint.kind !== 'textPresent' ||
        !checkpoint.description.includes('no matching') ||
        actions.length > 6;
      return {
        passed,
        kind: checkpoint.kind,
        description: checkpoint.description,
        observedState: {},
        durationMs: 0,
      };
    },
    async captureScreenshot() {
      return {
        evidenceId: 'shot',
        kind: 'screenshot',
        path: 'runs/test/shot.png',
        sanitization: 'sanitized',
        mediaType: 'image/png',
      };
    },
    async startTrace() {},
    async stopTrace() {
      return undefined;
    },
    async writeObservation() {
      return {
        evidenceId: 'obs',
        kind: 'semanticSnapshot',
        path: 'runs/test/obs.json',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async writeResult() {
      return {
        evidenceId: 'result',
        kind: 'result',
        path: 'runs/test/result.json',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async writeEventLog() {
      return {
        evidenceId: 'events',
        kind: 'eventLog',
        path: 'runs/test/events.json',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async close() {},
  };
}

describe('generic replay', () => {
  it.each(['LOCATOR_NOT_FOUND', 'LOCATOR_AMBIGUOUS'] as const)(
    'classifies %s as a typed target failure',
    async (code) => {
      const loaded = await loadArtifact(examplePath);
      const adapter = fakeAdapter();
      const execute = adapter.execute.bind(adapter);
      adapter.execute = async (action, context) => {
        if (action.kind === 'enterText')
          return {
            ok: false,
            action: action.kind,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            url: 'http://bank.test',
            error: new SurfaceError(code, 'fake locator rejection'),
          };
        return execute(action, context);
      };
      const evaluate = adapter.evaluateCheckpoint.bind(adapter);
      adapter.evaluateCheckpoint = async (checkpoint, context) => {
        if (
          checkpoint.description.includes('no customer was found') ||
          checkpoint.description.includes('staff-access error page')
        )
          return {
            passed: false,
            kind: checkpoint.kind,
            description: checkpoint.description,
            observedState: { present: false },
            durationMs: 0,
          };
        return evaluate(checkpoint, context);
      };
      const result = await new ReplayEngine().run({
        loadedArtifact: loaded,
        inputs: { customerUsername: 'customer' },
        secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
        baseUrl: 'http://bank.test',
        evidenceDirectory: '/tmp/evidence',
        headless: true,
        adapter,
        loadedPolicy: await loadPolicy(
          path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
        ),
      });
      expect(result).toMatchObject({
        status: 'failure',
        error: { category: 'target', code, stepId: 'enter-staff-username' },
      });
    },
  );

  it('retries transient failures only within the artifact bound and stops when exhausted', async () => {
    const loaded = await loadArtifact(examplePath);
    const raw = structuredClone(loaded.artifact) as unknown as Record<string, unknown>;
    const firstStep = (raw.steps as Array<Record<string, unknown>>)[0]!;
    const recovery = firstStep.recovery as Record<string, unknown>;
    recovery.backoff = { kind: 'fixed', delayMs: 0 };
    const bounded = { ...loaded, artifact: CapabilityArtifact.parse(raw) };
    const loadedPolicy = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );

    const transient = fakeAdapter();
    const transientExecute = transient.execute.bind(transient);
    const transientEvaluate = transient.evaluateCheckpoint.bind(transient);
    let transientAttempts = 0;
    transient.execute = async (action, context) => {
      if (action.kind === 'navigate' && ++transientAttempts === 1)
        return {
          ok: false,
          action: action.kind,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          url: 'http://bank.test',
          error: new SurfaceError('NAVIGATION_TIMEOUT', 'fake transient timeout', true),
        };
      return transientExecute(action, context);
    };
    transient.evaluateCheckpoint = async (checkpoint, context) => {
      if (
        checkpoint.description.includes('no customer was found') ||
        checkpoint.description.includes('staff-access error page')
      )
        return {
          passed: false,
          kind: checkpoint.kind,
          description: checkpoint.description,
          observedState: { present: false },
          durationMs: 0,
        };
      return transientEvaluate(checkpoint, context);
    };
    await new ReplayEngine().run({
      loadedArtifact: bounded,
      inputs: { customerUsername: 'customer' },
      secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
      baseUrl: 'http://bank.test',
      evidenceDirectory: '/tmp/evidence',
      headless: true,
      adapter: transient,
      loadedPolicy,
    });
    expect(transientAttempts).toBe(2);

    const exhausted = fakeAdapter();
    let exhaustedAttempts = 0;
    exhausted.execute = async (action) => {
      if (action.kind === 'navigate') exhaustedAttempts += 1;
      return {
        ok: false,
        action: action.kind,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        url: 'http://bank.test',
        error: new SurfaceError('NAVIGATION_TIMEOUT', 'fake persistent timeout', true),
      };
    };
    exhausted.evaluateCheckpoint = async (checkpoint) => ({
      passed: false,
      kind: checkpoint.kind,
      description: checkpoint.description,
      observedState: { present: false },
      durationMs: 0,
    });
    const exhaustedResult = await new ReplayEngine().run({
      loadedArtifact: bounded,
      inputs: { customerUsername: 'customer' },
      secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
      baseUrl: 'http://bank.test',
      evidenceDirectory: '/tmp/evidence',
      headless: true,
      adapter: exhausted,
      loadedPolicy,
    });
    expect(exhaustedAttempts).toBe(2);
    expect(exhaustedResult).toMatchObject({
      status: 'failure',
      error: { category: 'timeout', code: 'NAVIGATION_TIMEOUT' },
    });
  });

  it('enforces the policy replay-duration bound between deterministic actions', async () => {
    const loaded = await loadArtifact(examplePath);
    const loadedPolicy = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );
    const boundedPolicy = {
      ...loadedPolicy,
      policy: { ...loadedPolicy.policy, maxReplayDurationMs: 1000 },
    };
    const adapter = fakeAdapter();
    const execute = adapter.execute.bind(adapter);
    let clock = 10_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    adapter.execute = async (action, context) => {
      const result = await execute(action, context);
      clock += 1001;
      return result;
    };
    try {
      const result = await new ReplayEngine().run({
        loadedArtifact: loaded,
        inputs: { customerUsername: 'customer' },
        secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
        baseUrl: 'http://bank.test',
        evidenceDirectory: '/tmp/evidence',
        headless: true,
        adapter,
        loadedPolicy: boundedPolicy,
      });
      expect(result).toMatchObject({
        status: 'failure',
        error: { category: 'timeout', code: 'REPLAY_TIMEOUT' },
      });
      expect(adapter.actions).toEqual(['navigate']);
    } finally {
      now.mockRestore();
    }
  });

  it('fails closed when the live page does not match the artifact target fingerprint', async () => {
    const loaded = await loadArtifact(examplePath);
    const raw = structuredClone(loaded.artifact) as unknown as Record<string, unknown>;
    const target = raw.target as Record<string, unknown>;
    target.fingerprints = [
      { kind: 'urlPathPattern', id: 'expected-start', pattern: '^/expected$' },
    ];
    const adapter = fakeAdapter();
    const result = await new ReplayEngine().run({
      loadedArtifact: { ...loaded, artifact: CapabilityArtifact.parse(raw) },
      inputs: { customerUsername: 'customer' },
      secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
      baseUrl: 'http://bank.test',
      evidenceDirectory: '/tmp/evidence',
      headless: true,
      adapter,
      loadedPolicy: await loadPolicy(
        path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
      ),
    });
    expect(result).toMatchObject({
      status: 'failure',
      error: { category: 'checkpoint', code: 'CHECKPOINT_TARGET_FINGERPRINT_MISMATCH' },
    });
    expect(adapter.actions).toEqual(['navigate']);
  });

  it('records the failed step checkpoint expectation and observed state', async () => {
    const loaded = await loadArtifact(examplePath);
    const adapter = fakeAdapter();
    const originalEvaluate = adapter.evaluateCheckpoint.bind(adapter);
    let writtenEvents: readonly SurfaceEvent[] = [];
    adapter.evaluateCheckpoint = async (checkpoint, context) => {
      if (checkpoint.description === 'The username field remains available after entry.')
        return {
          passed: false,
          kind: checkpoint.kind,
          description: checkpoint.description,
          observedState: { visible: false, page: 'unexpected-login-state' },
          durationMs: 1,
        };
      if (
        checkpoint.description.includes('no customer was found') ||
        checkpoint.description.includes('staff-access error page')
      )
        return {
          passed: false,
          kind: checkpoint.kind,
          description: checkpoint.description,
          observedState: { present: false },
          durationMs: 0,
        };
      return originalEvaluate(checkpoint, context);
    };
    adapter.writeEventLog = async (events) => {
      writtenEvents = events;
      return {
        evidenceId: 'events',
        kind: 'eventLog',
        path: 'runs/test/events.json',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    };
    const result = await new ReplayEngine().run({
      loadedArtifact: loaded,
      inputs: { customerUsername: 'customer' },
      secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
      baseUrl: 'http://bank.test',
      evidenceDirectory: '/tmp/evidence',
      headless: true,
      adapter,
      loadedPolicy: await loadPolicy(
        path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
      ),
    });
    expect(result).toMatchObject({
      status: 'failure',
      error: { category: 'checkpoint', code: 'CHECKPOINT_FAILED' },
    });
    expect(writtenEvents).toContainEqual(
      expect.objectContaining({
        stepId: 'enter-staff-username',
        expected: 'The username field remains available after entry.',
        observed: { visible: false, page: 'unexpected-login-state' },
        ok: false,
      }),
    );
  });

  it('executes only the artifact and adapter with zero network or model calls', async () => {
    const loaded = await loadArtifact(examplePath);
    const loadedPolicy = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );
    const adapter = fakeAdapter();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    try {
      const result = await new ReplayEngine().run({
        loadedArtifact: loaded,
        inputs: { customerUsername: 'customer' },
        secrets: { BANK_STAFF_USERNAME: 'admin', BANK_STAFF_PASSWORD: 'admin' },
        baseUrl: 'http://bank.test',
        evidenceDirectory: '/tmp/evidence',
        headless: true,
        adapter,
        loadedPolicy,
      });
      expect(result.status).toBe('businessOutcome');
      expect(adapter.actions.length).toBeGreaterThan(0);
      expect(adapter.actions).not.toContain('login');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('keeps deterministic replay and lifecycle code free of discovery/provider dependencies', async () => {
    for (const relativePath of [
      '../../src/replay/replay-engine.ts',
      '../../src/compiler/artifact-lifecycle.ts',
    ]) {
      const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).not.toMatch(
        /PlannerClient|OpenAIResponsesPlanner|DiscoveryOrchestrator|openai-planner/,
      );
    }
  });
});
