import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { CapabilityActionType } from '../../src/domain/actions.js';
import type { SurfaceAdapter, SurfaceEvent } from '../../src/surfaces/surface-types.js';
import { BlockingInterventionCoordinator } from '../../src/intervention/intervention-coordinator.js';
import { OperatorInterventionCoordinator } from '../../src/intervention/intervention-coordinator.js';
import { ManualInterventionScheduler } from '../../src/intervention/intervention-scheduler.js';
import { loadPolicy, type LoadedPolicy } from '../../src/policy/policy-loader.js';
import { loadArtifact } from '../../src/replay/artifact-loader.js';
import { ReplayEngine } from '../../src/replay/replay-engine.js';
import { writeJsonLines } from '../../src/surfaces/web/safe-artifacts.js';
import {
  InteractiveReplayLifecycle,
  type ShutdownSignal,
  type SignalSource,
} from '../../src/intervention/interactive-replay-lifecycle.js';

const artifactPath = path.resolve(
  process.cwd(),
  '../artifacts/lookup-customer-account.v1.example.json',
);
const policyPath = path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json');

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function bindReleasedPort(port: number): Promise<net.Server> {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function interventionPolicy(policy: LoadedPolicy): LoadedPolicy {
  return {
    ...policy,
    policy: { ...policy.policy, interventionActions: ['navigate'] },
  };
}

function adapter(evidenceDirectory?: string) {
  const actions: string[] = [];
  const events: SurfaceEvent[][] = [];
  let closes = 0;
  let checkpointsPass = true;
  let completionOutputs: Record<string, unknown> = {};
  let validationBarrier:
    { entered: Deferred<void>; release: Deferred<void>; calls: number } | undefined;
  const surface: SurfaceAdapter = {
    async start() {},
    async observe() {
      return {
        observationId: 'o',
        url: 'http://bank.test/index',
        title: 'bank',
        elements: [],
      } as never;
    },
    async execute(action: CapabilityActionType, context) {
      actions.push(action.kind);
      if (action.kind === 'extract') context.outputs[action.output] = 'value';
      return {
        ok: true,
        action: action.kind,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        url: 'http://bank.test/index',
      };
    },
    async evaluateCheckpoint(checkpoint, context) {
      if (validationBarrier) {
        const currentBarrier = validationBarrier;
        validationBarrier = undefined;
        currentBarrier.calls += 1;
        currentBarrier.entered.resolve();
        await currentBarrier.release.promise;
      }
      Object.assign(context.outputs, completionOutputs);
      return {
        passed: checkpointsPass,
        kind: checkpoint.kind,
        description: checkpoint.description,
        observedState: {},
        durationMs: 0,
      };
    },
    async captureScreenshot() {
      return {
        evidenceId: 's',
        kind: 'screenshot',
        path: 's.png',
        sanitization: 'sanitized',
        mediaType: 'image/png',
      };
    },
    async startTrace() {},
    async stopTrace() {
      return undefined;
    },
    async writeObservation(observation) {
      if (evidenceDirectory)
        await writeFile(
          path.join(evidenceDirectory, 'observation.json'),
          JSON.stringify(observation),
        );
      return {
        evidenceId: 'o',
        kind: 'semanticSnapshot',
        path: 'o.json',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async writeResult(result) {
      if (evidenceDirectory)
        await writeFile(path.join(evidenceDirectory, 'result.json'), JSON.stringify(result));
      return {
        evidenceId: 'r',
        kind: 'result',
        path: 'r.json',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async writeEventLog(value) {
      events.push([...value]);
      if (evidenceDirectory)
        await writeJsonLines(path.join(evidenceDirectory, 'events.jsonl'), value);
      return {
        evidenceId: 'e',
        kind: 'eventLog',
        path: 'e.jsonl',
        sanitization: 'sanitized',
        mediaType: 'application/x-ndjson',
      };
    },
    async close() {
      closes += 1;
    },
  };
  return {
    surface,
    actions,
    events,
    get closes() {
      return closes;
    },
    get eventPath() {
      return evidenceDirectory ? path.join(evidenceDirectory, 'events.jsonl') : undefined;
    },
    set checkpointsPass(value: boolean) {
      checkpointsPass = value;
    },
    set completionOutputs(value: Record<string, unknown>) {
      completionOutputs = value;
    },
    set validationBarrier(
      value: { entered: Deferred<void>; release: Deferred<void>; calls: number } | undefined,
    ) {
      validationBarrier = value;
    },
  };
}

async function runOptions(surface: SurfaceAdapter, loadedPolicy: LoadedPolicy) {
  return {
    loadedArtifact: await loadArtifact(artifactPath),
    loadedPolicy,
    inputs: { customerUsername: 'customer' },
    secrets: { BANK_STAFF_USERNAME: 'secret-user', BANK_STAFF_PASSWORD: 'secret-password' },
    baseUrl: 'http://bank.test',
    evidenceDirectory: '/tmp/intervention-evidence',
    headless: true,
    adapter: surface,
  } as const;
}

describe('ReplayEngine intervention control', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('interrupts an interactive replay safely on %s', async (signal, exitCode) => {
    const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'signal-evidence-'));
    const target = adapter(evidenceDirectory);
    const listeners = new Map<ShutdownSignal, Set<() => void>>();
    const signalSource: SignalSource = {
      on: (name, listener) => {
        const set = listeners.get(name) ?? new Set();
        set.add(listener);
        listeners.set(name, set);
      },
      off: (name, listener) => listeners.get(name)?.delete(listener),
    };
    const ready = deferred<void>();
    let coordinator: OperatorInterventionCoordinator | undefined;
    let observedExitCode = -1;
    const lifecycle = new InteractiveReplayLifecycle({
      signalSource,
      createCoordinator: (onUrl) => {
        coordinator = new OperatorInterventionCoordinator((url) => {
          expect(url.startsWith('http://127.0.0.1:')).toBe(true);
          onUrl(url);
        });
        return coordinator;
      },
      runReplay: async (value, cancellationSignal, interruptionSource) =>
        new ReplayEngine().run({
          ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
          executionMode: 'interactive',
          interventionCoordinator: value,
          cancellationSignal,
          interruptionSource,
        }),
      outputOperatorUrl: () => ready.resolve(),
      setExitCode: (code) => {
        observedExitCode = code;
      },
    });
    const replay = lifecycle.run();
    await ready.promise;
    expect(target.closes).toBe(0);
    for (const listener of listeners.get(signal) ?? []) listener();
    for (const listener of listeners.get(signal) ?? []) listener();
    const result = await replay;
    expect(result).toMatchObject({
      status: 'interrupted',
      code: 'INTERRUPTED_BY_SIGNAL',
      signal,
    });
    expect(observedExitCode).toBe(exitCode);
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
    expect(coordinator?.snapshot().decisionChannelState).toBe('closed');
    expect(coordinator?.pendingScheduledWork).toBe(0);
    expect(listeners.get('SIGINT')?.size ?? 0).toBe(0);
    expect(listeners.get('SIGTERM')?.size ?? 0).toBe(0);
    const kinds = target.events.flat().map((event) => event.eventType);
    expect(kinds.filter((kind) => kind === 'shutdown_signal_received')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'operator_server_stopped')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'run_interrupted')).toHaveLength(1);
    const evidence = await readFile(target.eventPath!);
    for (const confidential of [
      'secret-password',
      'Bearer sentinel-authorization',
      'sentinel-cookie',
      'sentinel-session-token',
    ])
      expect(evidence.includes(Buffer.from(confidential))).toBe(false);
    await expect(lifecycle.cleanup()).resolves.toBeUndefined();
    await rm(evidenceDirectory, { recursive: true, force: true });
  });

  it('defers signal cancellation until blocked validation reaches a safe boundary', async () => {
    const target = adapter();
    target.checkpointsPass = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    const barrier = { entered, release, calls: 0 };
    target.validationBarrier = barrier;
    const listeners = new Map<ShutdownSignal, Set<() => void>>();
    const signalSource: SignalSource = {
      on: (name, listener) => {
        const set = listeners.get(name) ?? new Set();
        set.add(listener);
        listeners.set(name, set);
      },
      off: (name, listener) => listeners.get(name)?.delete(listener),
    };
    const ready = deferred<string>();
    const lifecycle = new InteractiveReplayLifecycle({
      signalSource,
      createCoordinator: (onUrl) => new OperatorInterventionCoordinator(onUrl),
      runReplay: async (coordinator, cancellationSignal, interruptionSource) =>
        new ReplayEngine().run({
          ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
          executionMode: 'interactive',
          interventionCoordinator: coordinator,
          cancellationSignal,
          interruptionSource,
        }),
      outputOperatorUrl: ready.resolve,
      setExitCode: () => {},
    });
    const replay = lifecycle.run();
    const operatorUrl = await ready.promise;
    const parsed = new URL(operatorUrl);
    const token = parsed.hash.slice(1);
    parsed.hash = '';
    const headers = {
      authorization: `Bearer ${token}`,
      origin: parsed.origin,
      'content-type': 'application/json',
    };
    const claim = (await (
      await fetch(new URL('/api/claim', parsed), {
        method: 'POST',
        headers: { authorization: headers.authorization, origin: headers.origin },
      })
    ).json()) as { lease: { generation: number } };
    const completion = fetch(new URL('/api/complete', parsed), {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: claim.lease.generation }),
    });
    await entered.promise;
    for (const listener of listeners.get('SIGINT') ?? []) listener();
    expect(target.closes).toBe(0);
    release.resolve();
    await completion.catch(() => undefined);
    await expect(replay).resolves.toMatchObject({
      status: 'interrupted',
      signal: 'SIGINT',
    });
    expect(barrier.calls).toBe(1);
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
  });

  it('returns immediately without executing an intervention action in non-interactive mode', async () => {
    const target = adapter();
    const result = await new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
    });
    expect(result.status).toBe('needsHuman');
    if (result.status === 'needsHuman') expect(result.reasonCode).toBe('INTERVENTION_REQUIRED');
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
  });

  it('keeps the surface open at a safe boundary, rejects stale resume, and resumes in one invocation', async () => {
    const target = adapter();
    const coordinator = new BlockingInterventionCoordinator();
    const promise = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = coordinator.request;
    expect(request).toBeDefined();
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(0);
    coordinator.decide({
      kind: 'resume',
      interventionId: request!.interventionId,
      leaseGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.request).toBeDefined();
    coordinator.decide({
      kind: 'resume',
      interventionId: request!.interventionId,
      leaseGeneration: request!.boundary.leaseGeneration,
    });
    const result = await promise;
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
    expect(result.status).toBe('businessOutcome');
    expect(target.events.flat().map((event) => event.eventType)).toContain('stale_resume_rejected');
  });

  it.each([
    ['abort', 'aborted'],
    ['timeout', 'failure'],
    ['browserSessionLost', 'failure'],
  ] as const)('terminates %s without executing the pending action', async (kind, status) => {
    const target = adapter();
    const coordinator = new BlockingInterventionCoordinator();
    const promise = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = coordinator.request!;
    coordinator.decide({
      kind,
      interventionId: request.interventionId,
      leaseGeneration: request.boundary.leaseGeneration,
    });
    const result = await promise;
    expect(result.status).toBe(status);
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
  });

  it('accepts authenticated Claim, Heartbeat, and Resume through the real loopback operator server', async () => {
    const target = adapter();
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const replay = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(operatorUrl).not.toBe('');
    const [baseUrl, token] = operatorUrl.split('#');
    const headers = { authorization: `Bearer ${token}`, origin: new URL(baseUrl!).origin };
    const unauthorized = await fetch(`${baseUrl}api/state`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(unauthorized.status).toBe(401);
    const claim = await fetch(`${baseUrl}api/claim`, {
      method: 'POST',
      headers: { authorization: headers.authorization, origin: headers.origin },
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as { lease: { generation: number; owner: string } };
    expect(claimed.lease.owner).toBe('human');
    const heartbeat = await fetch(`${baseUrl}api/heartbeat`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ generation: claimed.lease.generation }),
    });
    expect(heartbeat.status).toBe(200);
    const duplicate = await fetch(`${baseUrl}api/claim`, { method: 'POST', headers });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    const resumed = await fetch(`${baseUrl}api/resume`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ generation: claimed.lease.generation }),
    });
    expect(resumed.status).toBe(200);
    const replayResult = await replay;
    expect(replayResult.status).toBe('businessOutcome');
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
  });

  it('accepts verified human completion through the real loopback operator server', async () => {
    const target = adapter();
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const options = await runOptions(
      target.surface,
      interventionPolicy(await loadPolicy(policyPath)),
    );
    const replay = new ReplayEngine().run({
      ...options,
      loadedArtifact: {
        ...options.loadedArtifact,
        artifact: {
          ...options.loadedArtifact.artifact,
          contract: { ...options.loadedArtifact.artifact.contract, outputs: {} },
        },
      },
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [baseUrl, token] = operatorUrl.split('#');
    const headers = {
      authorization: `Bearer ${token}`,
      origin: new URL(baseUrl!).origin,
      'content-type': 'application/json',
    };
    const claim = await fetch(`${baseUrl}api/claim`, {
      method: 'POST',
      headers: { authorization: headers.authorization, origin: headers.origin },
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as { lease: { generation: number } };
    const complete = await fetch(`${baseUrl}api/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: claimed.lease.generation }),
    });
    expect(complete.status).toBe(200);
    const result = await replay;
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.completionMode).toBe('human');
    expect(target.actions).toEqual([]);
  });

  it('rejects Resume, restores a fenced human lease, then accepts a later Resume', async () => {
    const target = adapter();
    target.checkpointsPass = false;
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const replay = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [baseUrl, token] = operatorUrl.split('#');
    const auth = { authorization: `Bearer ${token}`, origin: new URL(baseUrl!).origin };
    const claim = await fetch(`${baseUrl}api/claim`, { method: 'POST', headers: auth });
    const first = (await claim.json()) as { lease: { generation: number } };
    const beforeRejection = coordinator.snapshot().revision;
    await fetch(`${baseUrl}api/resume`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ generation: first.lease.generation }),
    });
    await coordinator.waitForRevisionAfter(
      beforeRejection,
      (snapshot) =>
        snapshot.validationState === 'rejected' &&
        snapshot.owner === 'human' &&
        snapshot.decisionChannelState === 'waiting',
    );
    const state = await fetch(`${baseUrl}api/state`, { headers: auth });
    const rejected = (await state.json()) as { lease: { owner: string; generation: number } };
    expect(rejected.lease.owner).toBe('human');
    expect(rejected.lease.generation).toBeGreaterThan(first.lease.generation);
    expect(target.actions).toEqual([]);
    target.checkpointsPass = true;
    await fetch(`${baseUrl}api/resume`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ generation: rejected.lease.generation }),
    });
    expect((await replay).status).toBe('businessOutcome');
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
  });

  it('rejects Complete, restores human ownership, then accepts a typed completed result', async () => {
    const target = adapter();
    target.checkpointsPass = false;
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const options = await runOptions(
      target.surface,
      interventionPolicy(await loadPolicy(policyPath)),
    );
    const replay = new ReplayEngine().run({
      ...options,
      loadedArtifact: {
        ...options.loadedArtifact,
        artifact: {
          ...options.loadedArtifact.artifact,
          contract: {
            ...options.loadedArtifact.artifact.contract,
            outputs: {
              answer: { description: 'Fixture answer', shape: { kind: 'string', minLength: 1 } },
            },
          },
        },
      },
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [baseUrl, token] = operatorUrl.split('#');
    const headers = {
      authorization: `Bearer ${token}`,
      origin: new URL(baseUrl!).origin,
      'content-type': 'application/json',
    };
    const claim = await fetch(`${baseUrl}api/claim`, {
      method: 'POST',
      headers: { authorization: headers.authorization, origin: headers.origin },
    });
    const initial = (await claim.json()) as { lease: { generation: number } };
    const beforeRejection = coordinator.snapshot().revision;
    await fetch(`${baseUrl}api/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: initial.lease.generation }),
    });
    await coordinator.waitForRevisionAfter(
      beforeRejection,
      (snapshot) =>
        snapshot.validationState === 'rejected' &&
        snapshot.owner === 'human' &&
        snapshot.decisionChannelState === 'waiting',
    );
    const state = await fetch(`${baseUrl}api/state`, { headers });
    const rejected = (await state.json()) as { lease: { owner: string; generation: number } };
    expect(rejected.lease.owner).toBe('human');
    expect(rejected.lease.generation).toBeGreaterThan(initial.lease.generation);
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(0);
    const stale = await fetch(`${baseUrl}api/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: initial.lease.generation }),
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    target.checkpointsPass = true;
    target.completionOutputs = { answer: 'verified' };
    const beforeAcceptance = coordinator.snapshot().revision;
    void fetch(`${baseUrl}api/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: rejected.lease.generation }),
    }).catch(() => undefined);
    await coordinator.waitForRevisionAfter(
      beforeAcceptance,
      (snapshot) => snapshot.validationState === 'accepted' && snapshot.terminal,
    );
    const result = await replay;
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.completionMode).toBe('human');
      expect(result.outputs).toEqual({ answer: 'verified' });
    }
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
  });

  it('rejects Complete, then accepts Abort using the restored fenced generation', async () => {
    const target = adapter();
    target.checkpointsPass = false;
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const replay = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [baseUrl, token] = operatorUrl.split('#');
    const headers = {
      authorization: `Bearer ${token}`,
      origin: new URL(baseUrl!).origin,
      'content-type': 'application/json',
    };
    const claim = await fetch(`${baseUrl}api/claim`, {
      method: 'POST',
      headers: { authorization: headers.authorization, origin: headers.origin },
    });
    const initial = (await claim.json()) as { lease: { generation: number } };
    const beforeRejection = coordinator.snapshot().revision;
    await fetch(`${baseUrl}api/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: initial.lease.generation }),
    });
    await coordinator.waitForRevisionAfter(
      beforeRejection,
      (snapshot) =>
        snapshot.validationState === 'rejected' &&
        snapshot.owner === 'human' &&
        snapshot.decisionChannelState === 'waiting',
    );
    const state = await fetch(`${baseUrl}api/state`, { headers });
    const restored = (await state.json()) as { lease: { owner: string; generation: number } };
    expect(restored.lease.owner).toBe('human');
    expect(restored.lease.generation).toBeGreaterThan(initial.lease.generation);
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(0);
    const stale = await fetch(`${baseUrl}api/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: initial.lease.generation }),
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    const abort = await fetch(`${baseUrl}api/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: restored.lease.generation }),
    });
    expect(abort.status).toBe(200);
    const result = await replay;
    expect(result.status).toBe('aborted');
    if (result.status === 'aborted') expect(result.code).toBe('ABORTED_BY_HUMAN');
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(1);
    await expect(fetch(`${baseUrl}api/state`, { headers })).rejects.toThrow();
  });

  it('rejects concurrent Resume, Complete, and Abort while one Complete validation is blocked', async () => {
    const target = adapter();
    target.checkpointsPass = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    const barrier = { entered, release, calls: 0 };
    target.validationBarrier = barrier;
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const replay = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    try {
      for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const [baseUrl, token] = operatorUrl.split('#');
      const headers = {
        authorization: `Bearer ${token}`,
        origin: new URL(baseUrl!).origin,
        'content-type': 'application/json',
      };
      const claim = await fetch(`${baseUrl}api/claim`, {
        method: 'POST',
        headers: { authorization: headers.authorization, origin: headers.origin },
      });
      const { lease } = (await claim.json()) as { lease: { generation: number } };
      const original = fetch(`${baseUrl}api/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generation: lease.generation }),
      });
      await entered.promise;
      const conflictRequests = ['resume', 'complete', 'abort'].map((command) =>
        fetch(`${baseUrl}api/${command}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ generation: lease.generation }),
        }),
      );
      const conflicts = await Promise.all(conflictRequests);
      for (const response of conflicts) {
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_IN_PROGRESS' });
      }
      expect(barrier.calls).toBe(1);
      expect(target.actions).toEqual([]);
      expect(target.closes).toBe(0);
      const beforeRejection = coordinator.snapshot().revision;
      release.resolve();
      expect((await original).status).toBe(200);
      await coordinator.waitForRevisionAfter(
        beforeRejection,
        (snapshot) =>
          snapshot.validationState === 'rejected' &&
          snapshot.owner === 'human' &&
          snapshot.decisionChannelState === 'waiting',
      );
      const state = await fetch(`${baseUrl}api/state`, { headers });
      const restored = (await state.json()) as { lease: { generation: number; owner: string } };
      expect(restored.lease.owner).toBe('human');
      expect(restored.lease.generation).toBeGreaterThan(lease.generation);
      const abort = await fetch(`${baseUrl}api/abort`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generation: restored.lease.generation }),
      });
      expect(abort.status).toBe(200);
      expect((await replay).status).toBe('aborted');
      expect(target.closes).toBe(1);
    } finally {
      release.resolve();
    }
  });

  it('expires a human lease, rejects stale commands, then reclaims and aborts through HTTP', async () => {
    const target = adapter();
    const scheduler = new ManualInterventionScheduler(Date.UTC(2026, 0, 1));
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator(
      (url) => {
        operatorUrl = url;
      },
      100,
      scheduler,
    );
    const replay = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
      leaseNow: () => scheduler.now(),
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [baseUrl, token] = operatorUrl.split('#');
    const headers = {
      authorization: `Bearer ${token}`,
      origin: new URL(baseUrl!).origin,
      'content-type': 'application/json',
    };
    const claim = await fetch(`${baseUrl}api/claim`, {
      method: 'POST',
      headers: { authorization: headers.authorization, origin: headers.origin },
    });
    const initial = (await claim.json()) as { lease: { generation: number } };
    const port = Number(new URL(baseUrl!).port);
    scheduler.advanceBy(101);
    const expired = coordinator.snapshot();
    expect(expired.leaseState).toBe('LEASE_EXPIRED');
    expect(expired.owner).toBe('none');
    expect(coordinator.pendingScheduledWork).toBe(0);
    expect(target.actions).toEqual([]);
    expect(target.closes).toBe(0);

    for (const command of ['resume', 'complete', 'abort', 'heartbeat']) {
      const response = await fetch(`${baseUrl}api/${command}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generation: initial.lease.generation }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'HUMAN_NOT_OWNER' });
    }
    expect(coordinator.snapshot().validationState).not.toBe('validating');
    expect(target.actions).toEqual([]);

    const reclaimHeaders = { authorization: headers.authorization, origin: headers.origin };
    const reclaimedResponse = await fetch(`${baseUrl}api/reclaim`, {
      method: 'POST',
      headers: reclaimHeaders,
    });
    const reclaimedBody = (await reclaimedResponse.json()) as {
      code?: string;
      lease: { generation: number; owner: string };
    };
    expect(reclaimedResponse.status, reclaimedBody.code).toBe(200);
    const reclaimed = reclaimedBody;
    expect(reclaimed.lease.owner).toBe('human');
    expect(reclaimed.lease.generation).toBeGreaterThan(expired.generation);
    expect(coordinator.pendingScheduledWork).toBe(1);
    const duplicateReclaim = await fetch(`${baseUrl}api/reclaim`, {
      method: 'POST',
      headers: reclaimHeaders,
    });
    expect(duplicateReclaim.status).toBe(400);
    await expect(duplicateReclaim.json()).resolves.toMatchObject({ code: 'LEASE_NOT_EXPIRED' });
    const heartbeat = await fetch(`${baseUrl}api/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: reclaimed.lease.generation }),
    });
    expect(heartbeat.status).toBe(200);
    const abort = await fetch(`${baseUrl}api/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation: reclaimed.lease.generation }),
    });
    expect(abort.status).toBe(200);
    const result = await replay;
    expect(result.status).toBe('aborted');
    expect(target.closes).toBe(1);
    expect(coordinator.pendingScheduledWork).toBe(0);
    expect(target.events.flat().map((event) => event.eventType)).toContain('lease_expired');
    expect(target.events.flat().map((event) => event.eventType)).toContain('lease_reclaimed');
    const portProbe = await bindReleasedPort(port);
    await new Promise<void>((resolve, reject) =>
      portProbe.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('rejects unauthenticated, malformed, and cross-origin operator commands', async () => {
    const target = adapter();
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
    });
    const replay = new ReplayEngine().run({
      ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
      executionMode: 'interactive',
      interventionCoordinator: coordinator,
    });
    for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [baseUrl, token] = operatorUrl.split('#');
    const allowedOrigin = new URL(baseUrl!).origin;
    expect((await fetch(`${baseUrl}api/state`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}api/state`, { headers: { authorization: 'Token malformed' } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}api/claim`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1.example.com' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}api/claim`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, origin: 'https://127.0.0.1:1' },
        })
      ).status,
    ).toBe(403);
    const claim = await fetch(`${baseUrl}api/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: allowedOrigin },
    });
    const { lease } = (await claim.json()) as { lease: { generation: number } };
    for (const body of [
      undefined,
      {},
      { generation: 0 },
      { generation: 'bad' },
      { generation: 1, extra: true },
    ]) {
      const response = await fetch(`${baseUrl}api/heartbeat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          origin: allowedOrigin,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: expect.any(String) });
    }
    expect((await fetch(`${baseUrl}api/claim`, { method: 'GET' })).status).toBe(404);
    expect((await fetch(`${baseUrl}api/no-such-route`)).status).toBe(404);
    const abort = await fetch(`${baseUrl}api/abort`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: allowedOrigin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ generation: lease.generation }),
    });
    expect(abort.status).toBe(200);
    expect((await replay).status).toBe('aborted');
    await expect(
      fetch(`${baseUrl}api/state`, { headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toThrow();
  });

  it('writes a complete sanitized expiry, reclaim, and abort lifecycle to JSONL evidence', async () => {
    const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), 'operator-evidence-'));
    const target = adapter(evidenceDirectory);
    const scheduler = new ManualInterventionScheduler(Date.UTC(2026, 0, 1));
    let operatorUrl = '';
    const coordinator = new OperatorInterventionCoordinator(
      (url) => {
        operatorUrl = url;
      },
      100,
      scheduler,
    );
    try {
      const replay = new ReplayEngine().run({
        ...(await runOptions(target.surface, interventionPolicy(await loadPolicy(policyPath)))),
        evidenceDirectory,
        executionMode: 'interactive',
        interventionCoordinator: coordinator,
        leaseNow: () => scheduler.now(),
      });
      for (let attempt = 0; attempt < 20 && !operatorUrl; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const [baseUrl, token] = operatorUrl.split('#');
      const headers = {
        authorization: `Bearer ${token}`,
        origin: new URL(baseUrl!).origin,
        'content-type': 'application/json',
      };
      const claim = await fetch(`${baseUrl}api/claim`, {
        method: 'POST',
        headers: { authorization: headers.authorization, origin: headers.origin },
      });
      const initial = (await claim.json()) as { lease: { generation: number } };
      const firstHeartbeat = await fetch(`${baseUrl}api/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generation: initial.lease.generation }),
      });
      expect(firstHeartbeat.status).toBe(200);
      scheduler.advanceBy(101);
      for (const command of ['resume', 'complete', 'abort', 'heartbeat']) {
        const response = await fetch(`${baseUrl}api/${command}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ generation: initial.lease.generation }),
        });
        expect(response.status).toBe(400);
      }
      const reclaimHeaders = { authorization: headers.authorization, origin: headers.origin };
      const reclaimedResponse = await fetch(`${baseUrl}api/reclaim`, {
        method: 'POST',
        headers: reclaimHeaders,
      });
      const reclaimed = (await reclaimedResponse.json()) as { lease: { generation: number } };
      const secondHeartbeat = await fetch(`${baseUrl}api/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generation: reclaimed.lease.generation }),
      });
      expect(secondHeartbeat.status).toBe(200);
      const abort = await fetch(`${baseUrl}api/abort`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generation: reclaimed.lease.generation }),
      });
      expect(abort.status).toBe(200);
      expect((await replay).status).toBe('aborted');
      expect(target.closes).toBe(1);

      const eventPath = target.eventPath!;
      const content = await readFile(eventPath, 'utf8');
      expect(content.endsWith('\n')).toBe(true);
      const lines = content.trimEnd().split('\n');
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).not.toHaveLength(0);
      expect(events.every((event) => typeof event.timestamp === 'string')).toBe(true);
      const kinds = events.map((event) => event.eventType);
      const index = (kind: string) => kinds.indexOf(kind);
      for (const kind of [
        'intervention_requested',
        'safe_boundary_reached',
        'automation_paused',
        'operator_server_started',
        'human_claim_accepted',
        'human_heartbeat',
        'lease_expired',
        'operator_resume_rejected',
        'operator_complete_rejected',
        'operator_abort_rejected',
        'operator_heartbeat_rejected',
        'lease_reclaimed',
        'human_abort',
        'operator_server_stopped',
        'run_aborted',
      ])
        expect(index(kind), `missing ${kind}`).toBeGreaterThanOrEqual(0);
      expect(index('operator_server_started')).toBeLessThan(index('human_claim_accepted'));
      expect(index('human_claim_accepted')).toBeLessThan(index('human_heartbeat'));
      expect(index('human_heartbeat')).toBeLessThan(index('lease_expired'));
      expect(index('lease_expired')).toBeLessThan(index('operator_resume_rejected'));
      expect(index('operator_heartbeat_rejected')).toBeLessThan(index('lease_reclaimed'));
      expect(index('lease_reclaimed')).toBeLessThan(kinds.lastIndexOf('human_heartbeat'));
      expect(kinds.lastIndexOf('human_heartbeat')).toBeLessThan(kinds.lastIndexOf('human_abort'));
      expect(kinds.lastIndexOf('human_abort')).toBeLessThan(index('operator_server_stopped'));
      expect(index('operator_server_stopped')).toBeLessThan(index('run_aborted'));
      expect(kinds.filter((kind) => kind === 'lease_expired')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'operator_server_stopped')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'run_aborted')).toHaveLength(1);
      const lifecycle = events.filter((event) => typeof event.interventionId === 'string');
      expect(new Set(lifecycle.map((event) => event.runId)).size).toBe(1);
      expect(new Set(lifecycle.map((event) => event.interventionId)).size).toBe(1);
      const generations = lifecycle
        .map((event) => event.generation)
        .filter((generation): generation is number => typeof generation === 'number');
      expect(Math.max(...generations)).toBeGreaterThan(initial.lease.generation);
      const revisions = lifecycle
        .map((event) => event.coordinatorRevision)
        .filter((revision): revision is number => typeof revision === 'number');
      expect(
        revisions.every((revision, index) => index === 0 || revision >= revisions[index - 1]!),
      ).toBe(true);
      const bytes = await readFile(eventPath);
      for (const confidential of [
        token!,
        headers.authorization,
        'secret-password',
        'session-token',
      ])
        expect(bytes.includes(Buffer.from(confidential))).toBe(false);
    } finally {
      await coordinator.close();
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
  });
});
