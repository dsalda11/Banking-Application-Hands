import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapabilityAction, type CapabilityActionType } from '../../src/domain/index.js';
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
import { PolicyEngine } from '../../src/policy/policy-engine.js';
import type { SurfaceAdapter } from '../../src/surfaces/surface-types.js';

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
  it('does not run banking-specific workflow code and returns declared outcomes', async () => {
    const loaded = await loadArtifact(examplePath);
    const loadedPolicy = await loadPolicy(
      path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json'),
    );
    const adapter = fakeAdapter();
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
  });
});
