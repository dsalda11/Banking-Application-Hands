import { chromium, type Browser, type Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { ControlLeaseManager } from '../../src/intervention/control-lease.js';
import {
  startOperatorServer,
  type OperatorServer,
} from '../../src/intervention/operator-server.js';
import { OperatorInterventionCoordinator } from '../../src/intervention/intervention-coordinator.js';
import { ReplayEngine } from '../../src/replay/replay-engine.js';
import { loadArtifact } from '../../src/replay/artifact-loader.js';
import { loadPolicy } from '../../src/policy/policy-loader.js';
import type { SurfaceAdapter } from '../../src/surfaces/surface-types.js';

let browser: Browser | undefined;
let server: OperatorServer | undefined;
const artifactPath = path.resolve(
  process.cwd(),
  '../artifacts/lookup-customer-account.v1.example.json',
);
const policyPath = path.resolve(process.cwd(), '../policies/local-bank-readonly.v1.json');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function realStackPage() {
  let url = '';
  let open = false;
  let validationCalls = 0;
  let workflowActions = 0;
  let pendingActionExecutions = 0;
  let checkpointsPass = true;
  let pendingPostcondition = false;
  let completionValid = false;
  let barrier:
    { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let latestContext: Parameters<SurfaceAdapter['evaluateCheckpoint']>[1] | undefined;
  const surface: SurfaceAdapter = {
    async start() {
      open = true;
    },
    async close() {
      open = false;
    },
    async observe() {
      return {
        observationId: 'o',
        url: 'http://bank.test',
        title: 'fixture',
        elements: [],
      } as never;
    },
    async execute(action, context) {
      workflowActions += 1;
      if (
        action.kind === 'navigate' &&
        action.destination.kind === 'relativeRoute' &&
        action.destination.route === '/index'
      )
        pendingActionExecutions += 1;
      if (action.kind === 'extract')
        context.outputs[action.output] =
          action.output === 'currentBalance' ? { amount: '31444', currency: 'USD' } : '2023';
      return {
        ok: true,
        action: action.kind,
        startedAt: '',
        completedAt: '',
        url: 'http://bank.test',
      };
    },
    async evaluateCheckpoint(checkpoint, context) {
      latestContext = context;
      if (barrier) {
        const current = barrier;
        barrier = undefined;
        validationCalls += 1;
        current.entered.resolve();
        await current.release.promise;
      }
      const isFinal =
        checkpoint.description === 'The requested account outputs are present and shaped.';
      const isBusinessOutcome =
        checkpoint.description.includes('no customer was found') ||
        checkpoint.description.includes('staff-access error page');
      if (isFinal && completionValid) {
        context.outputs.accountNumber = '2023';
        context.outputs.currentBalance = { amount: '31444', currency: 'USD' };
      }
      return {
        passed: isBusinessOutcome
          ? false
          : isFinal
            ? completionValid
            : pendingPostcondition || checkpointsPass,
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
        path: 's',
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
        evidenceId: 'o',
        kind: 'semanticSnapshot',
        path: 'o',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async writeResult() {
      return {
        evidenceId: 'r',
        kind: 'result',
        path: 'r',
        sanitization: 'sanitized',
        mediaType: 'application/json',
      };
    },
    async writeEventLog() {
      return {
        evidenceId: 'e',
        kind: 'eventLog',
        path: 'e',
        sanitization: 'sanitized',
        mediaType: 'application/x-ndjson',
      };
    },
  };
  const loadedArtifact = await loadArtifact(artifactPath);
  const loaded = await loadPolicy(policyPath);
  const loadedPolicy = {
    ...loaded,
    policy: {
      ...loaded.policy,
      interventionActions: ['navigate'] as typeof loaded.policy.interventionActions,
    },
  };
  const coordinator = new OperatorInterventionCoordinator((value) => {
    url = value;
  });
  const replay = new ReplayEngine().run({
    loadedArtifact,
    loadedPolicy,
    inputs: { customerUsername: 'customer' },
    secrets: { BANK_STAFF_USERNAME: 'u', BANK_STAFF_PASSWORD: 'p' },
    baseUrl: 'http://bank.test',
    evidenceDirectory: '/tmp/operator-page',
    headless: true,
    adapter: surface,
    executionMode: 'interactive',
    interventionCoordinator: coordinator,
  });
  await expect.poll(() => url.length > 0).toBe(true);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url);
  return {
    page,
    coordinator,
    replay,
    armValidation() {
      const next = { entered: deferred(), release: deferred() };
      barrier = next;
      return next;
    },
    setPendingPostcondition(value: boolean) {
      pendingPostcondition = value;
      checkpointsPass = value;
    },
    setCompletionValid(value: boolean) {
      completionValid = value;
      if (value && latestContext) {
        latestContext.outputs.accountNumber = '2023';
        latestContext.outputs.currentBalance = { amount: '31444', currency: 'USD' };
      }
    },
    get validationCalls() {
      return validationCalls;
    },
    get open() {
      return open;
    },
    get workflowActions() {
      return workflowActions;
    },
    get pendingActionExecutions() {
      return pendingActionExecutions;
    },
    releaseBarrier() {
      barrier?.release.resolve();
      barrier = undefined;
    },
  };
}

async function pageForOperator(): Promise<{
  page: Page;
  token: string;
  lease: ControlLeaseManager;
  advance(ms: number): void;
}> {
  let now = Date.UTC(2026, 0, 1);
  const lease = new ControlLeaseManager('run-ui', 'intervention-ui', 'safe fixture', () => now);
  const token = lease.issueOperatorToken();
  lease.pause(lease.requestPause(1).generation);
  server = await startOperatorServer({
    getLease: () => lease.snapshot(),
    token,
    view: {
      runId: 'run-ui',
      interventionId: 'intervention-ui',
      reason: 'Safe fixture intervention',
      stepId: 'safe-step',
      risk: 'read',
      resumeCheckpoint: 'Fixture checkpoint',
    },
    getStatus: () => {
      const snapshot = lease.snapshot();
      return {
        revision: snapshot.generation,
        owner: snapshot.owner,
        generation: snapshot.generation,
        leaseState: snapshot.state,
        ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
        validationState: 'idle',
        decisionChannelState: 'waiting',
        terminal: snapshot.state === 'ABORTED',
      };
    },
    actions: {
      claim: async () => lease.claim(token, 'operator', 100),
      heartbeat: async (generation) => lease.heartbeat(token, generation, 100),
      reclaim: async () => lease.claim(token, 'operator', 100),
      resume: async (generation) => ({ lease: lease.handoffToAutomation(token, generation) }),
      complete: async (generation) => ({ lease: lease.beginResume(token, generation) }),
      abort: async (generation) => lease.abort(token, generation),
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${server.url}#${token}`);
  return { page, token, lease, advance: (ms) => (now += ms) };
}

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await server?.close();
  server = undefined;
});

describe('loopback operator page', () => {
  it('uses real replay policy intervention and claims through the real coordinator', async () => {
    const harness = await realStackPage();
    try {
      await expect.poll(() => harness.page.locator('#claim').isEnabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Claim Control' }).click();
      await expect.poll(() => harness.coordinator.snapshot().owner).toBe('human');
      await expect.poll(() => harness.page.locator('#resume').isEnabled()).toBe(true);
      expect(harness.open).toBe(true);
    } finally {
      harness.releaseBarrier();
      if (harness.coordinator.snapshot().owner === 'human')
        await harness.page.getByRole('button', { name: 'Abort Run' }).click();
      await harness.replay;
    }
  });

  it('locks the real operator page while ReplayEngine completion validation is blocked', async () => {
    const harness = await realStackPage();
    const validation = harness.armValidation();
    try {
      await expect.poll(() => harness.page.locator('#claim').isEnabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Claim Control' }).click();
      await expect.poll(() => harness.page.locator('#complete').isEnabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Complete Task' }).click();
      await validation.entered.promise;
      await expect.poll(() => harness.coordinator.snapshot().validationState).toBe('validating');
      await expect.poll(() => harness.page.locator('#validation').textContent()).toBe('validating');
      for (const id of ['claim', 'reclaim', 'resume', 'complete', 'abort'])
        await expect.poll(() => harness.page.locator(`#${id}`).isDisabled()).toBe(true);
      expect(harness.validationCalls).toBe(1);
      validation.release.resolve();
      await expect.poll(() => harness.coordinator.snapshot().owner).toBe('human');
      await expect.poll(() => harness.page.locator('#complete').isEnabled()).toBe(true);
    } finally {
      validation.release.resolve();
      if (harness.coordinator.snapshot().owner === 'human')
        await harness.page.getByRole('button', { name: 'Abort Run' }).click();
      await harness.replay;
    }
  });

  it('rejects then accepts Resume through the real operator page without duplicating the action', async () => {
    const harness = await realStackPage();
    try {
      await expect.poll(() => harness.page.locator('#claim').isEnabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Claim Control' }).click();
      const originalGeneration = harness.coordinator.snapshot().generation;
      harness.setPendingPostcondition(false);
      const first = harness.armValidation();
      await harness.page.getByRole('button', { name: 'Resume Automation' }).click();
      await first.entered.promise;
      await expect.poll(() => harness.page.locator('#validation').textContent()).toBe('validating');
      first.release.resolve();
      await expect.poll(() => harness.coordinator.snapshot().validationState).toBe('rejected');
      await expect.poll(() => harness.coordinator.snapshot().owner).toBe('human');
      const restoredGeneration = harness.coordinator.snapshot().generation;
      expect(restoredGeneration).toBeGreaterThan(originalGeneration);
      await expect
        .poll(() => harness.page.locator('#generation').textContent())
        .toBe(String(restoredGeneration));
      await expect
        .poll(() => harness.page.locator('#status').textContent())
        .toContain('Validation rejected');
      for (const id of ['resume', 'complete', 'abort'])
        await expect.poll(() => harness.page.locator(`#${id}`).isEnabled()).toBe(true);
      expect(harness.pendingActionExecutions).toBe(0);
      expect(harness.open).toBe(true);

      harness.setPendingPostcondition(true);
      harness.setCompletionValid(true);
      const second = harness.armValidation();
      await harness.page.getByRole('button', { name: 'Resume Automation' }).click();
      await second.entered.promise;
      second.release.resolve();
      const result = await harness.replay;
      expect(result.status).toBe('success');
      expect(harness.pendingActionExecutions).toBe(0);
      expect(harness.open).toBe(false);
    } finally {
      harness.releaseBarrier();
      if (harness.coordinator.snapshot().owner === 'human')
        await harness.page.getByRole('button', { name: 'Abort Run' }).click();
      await harness.replay;
    }
  });

  it('rejects then accepts Complete through the real operator page with typed human output', async () => {
    const harness = await realStackPage();
    let completeRequests = 0;
    harness.page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/complete') completeRequests += 1;
    });
    try {
      await expect.poll(() => harness.page.locator('#claim').isEnabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Claim Control' }).click();
      const originalGeneration = harness.coordinator.snapshot().generation;
      harness.setPendingPostcondition(false);
      harness.setCompletionValid(false);
      const first = harness.armValidation();
      await harness.page.getByRole('button', { name: 'Complete Task' }).click();
      await first.entered.promise;
      await expect.poll(() => harness.page.locator('#validation').textContent()).toBe('validating');
      for (const id of ['claim', 'reclaim', 'resume', 'complete', 'abort'])
        expect(await harness.page.locator(`#${id}`).isDisabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Complete Task' }).press('Enter');
      expect(harness.validationCalls).toBe(1);
      expect(completeRequests).toBe(1);
      first.release.resolve();
      await expect.poll(() => harness.coordinator.snapshot().owner).toBe('human');
      const restoredGeneration = harness.coordinator.snapshot().generation;
      expect(restoredGeneration).toBeGreaterThan(originalGeneration);
      await expect
        .poll(() => harness.page.locator('#generation').textContent())
        .toBe(String(restoredGeneration));
      await expect
        .poll(() => harness.page.locator('#status').textContent())
        .toContain('Validation rejected');
      expect(harness.workflowActions).toBe(0);

      harness.setPendingPostcondition(true);
      harness.setCompletionValid(true);
      const second = harness.armValidation();
      await harness.page.getByRole('button', { name: 'Complete Task' }).click();
      await second.entered.promise;
      second.release.resolve();
      const result = await harness.replay;
      expect(result).toMatchObject({
        status: 'success',
        completionMode: 'human',
        outputs: {
          accountNumber: '2023',
          currentBalance: { amount: '31444', currency: 'USD' },
        },
      });
      expect(harness.workflowActions).toBe(0);
      expect(harness.open).toBe(false);
    } finally {
      harness.releaseBarrier();
      if (harness.coordinator.snapshot().owner === 'human')
        await harness.page.getByRole('button', { name: 'Abort Run' }).click();
      await harness.replay;
    }
  });

  it('ignores a stale coordinator revision without restoring an old generation or controls', async () => {
    const harness = await realStackPage();
    try {
      await expect.poll(() => harness.page.locator('#claim').isEnabled()).toBe(true);
      await harness.page.getByRole('button', { name: 'Claim Control' }).click();
      await expect.poll(() => harness.coordinator.snapshot().owner).toBe('human');
      const current = harness.coordinator.snapshot();
      await expect
        .poll(() => harness.page.locator('#generation').textContent())
        .toBe(String(current.generation));
      await harness.page.evaluate(
        ({ revision, generation }) => {
          (globalThis as typeof globalThis & { render(value: unknown): void }).render({
            status: {
              revision,
              owner: 'none',
              generation,
              leaseState: 'PAUSED',
              validationState: 'idle',
              decisionChannelState: 'waiting',
              terminal: false,
            },
          });
        },
        { revision: current.revision - 1, generation: current.generation - 1 },
      );
      expect(await harness.page.locator('#generation').textContent()).toBe(
        String(current.generation),
      );
      expect(await harness.page.locator('#resume').isEnabled()).toBe(true);
      expect(await harness.page.locator('#claim').isDisabled()).toBe(true);
    } finally {
      harness.releaseBarrier();
      if (harness.coordinator.snapshot().owner === 'human')
        await harness.page.getByRole('button', { name: 'Abort Run' }).click();
      await harness.replay;
    }
  });
  it('removes the fragment token and maps claimable and human-owned controls', async () => {
    const { page, token } = await pageForOperator();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await expect.poll(() => page.url()).toBe(server!.url);
    await expect.poll(() => page.locator('#claim').isEnabled()).toBe(true);
    await expect.poll(() => page.locator('#resume').isDisabled()).toBe(true);
    await expect.poll(() => page.locator('#complete').isDisabled()).toBe(true);
    await expect.poll(() => page.locator('#abort').isDisabled()).toBe(true);
    await expect.poll(() => page.locator('#reclaim').isDisabled()).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.content()).not.toContain(token);
    await page.getByRole('button', { name: 'Claim Control' }).click();
    await expect.poll(() => page.locator('#lease-state').textContent()).toBe('HUMAN_OWNED');
    await expect.poll(() => page.locator('#resume').isEnabled()).toBe(true);
    await expect.poll(() => page.locator('#complete').isEnabled()).toBe(true);
    await expect.poll(() => page.locator('#abort').isEnabled()).toBe(true);
    await expect.poll(() => page.locator('#claim').isDisabled()).toBe(true);
    expect(requests.every((url) => new URL(url).origin === new URL(server!.url).origin)).toBe(true);
  });

  it('keeps controls disabled without a valid fragment token', async () => {
    const { page } = await pageForOperator();
    await page.goto(server!.url);
    await expect
      .poll(() => page.locator('#status').textContent())
      .toContain('authentication is required');
    for (const id of ['claim', 'reclaim', 'resume', 'complete', 'abort'])
      await expect.poll(() => page.locator(`#${id}`).isDisabled()).toBe(true);
  });

  it('removes an invalid fragment without disclosing protected state', async () => {
    const { page, token } = await pageForOperator();
    const consoleMessages: string[] = [];
    page.on('console', (message) => consoleMessages.push(message.text()));
    await page.goto('about:blank');
    await page.goto(`${server!.url}#invalid-fragment-token`);
    await expect.poll(() => page.url()).toBe(server!.url);
    await expect
      .poll(() => page.locator('#status').textContent())
      .toContain('Unable to authenticate');
    for (const id of ['claim', 'reclaim', 'resume', 'complete', 'abort'])
      await expect.poll(() => page.locator(`#${id}`).isDisabled()).toBe(true);
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(token);
    expect(text).not.toContain('run-ui');
    expect(text).not.toContain('intervention-ui');
    expect(await page.content()).not.toContain('invalid-fragment-token');
    expect(consoleMessages.join('\n')).not.toContain('invalid-fragment-token');
    await expect(page.evaluate(() => localStorage.length)).resolves.toBe(0);
    await expect(page.evaluate(() => sessionStorage.length)).resolves.toBe(0);
    expect((await page.context().cookies()).length).toBe(0);
  });

  it('maps expired, reclaimed, and aborted states through visible controls', async () => {
    const { page, advance } = await pageForOperator();
    await expect.poll(() => page.locator('#claim').isEnabled()).toBe(true);
    await page.getByRole('button', { name: 'Claim Control' }).click();
    await expect.poll(() => page.locator('#abort').isEnabled()).toBe(true);
    advance(101);
    await expect.poll(() => page.locator('#lease-state').textContent()).toBe('LEASE_EXPIRED');
    await expect.poll(() => page.locator('#reclaim').isEnabled()).toBe(true);
    for (const id of ['claim', 'resume', 'complete', 'abort'])
      await expect.poll(() => page.locator(`#${id}`).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Reclaim Expired Lease' }).click();
    await expect.poll(() => page.locator('#lease-state').textContent()).toBe('HUMAN_OWNED');
    await expect.poll(() => page.locator('#resume').isEnabled()).toBe(true);
    await page.getByRole('button', { name: 'Abort Run' }).click();
    await expect.poll(() => page.locator('#lease-state').textContent()).toBe('ABORTED');
    for (const id of ['claim', 'reclaim', 'resume', 'complete', 'abort'])
      await expect.poll(() => page.locator(`#${id}`).isDisabled()).toBe(true);
  });
});
