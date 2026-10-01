import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import type { CapabilityActionType } from '../../src/domain/actions.js';
import type { ExecutionContext } from '../../src/execution/execution-context.js';
import { OperatorInterventionCoordinator } from '../../src/intervention/intervention-coordinator.js';
import { loadPolicy } from '../../src/policy/policy-loader.js';
import { loadArtifact } from '../../src/replay/artifact-loader.js';
import { ReplayEngine } from '../../src/replay/replay-engine.js';
import { PlaywrightWebAdapter } from '../../src/surfaces/web/playwright-web-adapter.js';

const confidential = {
  cookie: 'takeover-cookie-sentinel-c11f',
  session: 'takeover-session-sentinel-a82d',
  password: 'unused-password-sentinel-e41b',
};

class InstrumentedAdapter extends PlaywrightWebAdapter {
  readonly actions: string[] = [];

  override async execute(action: CapabilityActionType, context: ExecutionContext) {
    this.actions.push(action.kind);
    return super.execute(action, context);
  }

  targetPage(): Page {
    return this.session.requirePage();
  }
}

interface Harness {
  adapter: InstrumentedAdapter;
  coordinator: OperatorInterventionCoordinator;
  operatorPage: Page;
  operatorBrowser: Browser;
  replay: ReturnType<ReplayEngine['run']>;
  scratch: string;
  targetServer: Server;
  operatorPort: number;
  token: string;
  serverSession: string;
}

function artifact(baseUrl: string) {
  const visible = (text: string, description: string) => ({
    kind: 'textPresent',
    text,
    description,
  });
  return {
    schemaVersion: '1.0.0',
    id: 'fixture.human-takeover',
    version: '1.0.0',
    lifecycle: 'draft',
    name: 'Human takeover fixture',
    description: 'Real Chromium same-session takeover fixture',
    target: {
      surface: 'web',
      product: 'takeover-fixture',
      entryPoint: { kind: 'absoluteUrl', url: `${baseUrl}/establish` },
      fingerprints: [{ kind: 'requiredText', id: 'ready', text: 'Workflow ready' }],
    },
    contract: {
      inputs: {},
      requiredSecrets: [],
      outputs: {
        answer: {
          description: 'Fixture answer',
          shape: { kind: 'string', minLength: 1, maxLength: 64 },
        },
      },
      businessOutcomes: [],
    },
    policyRef: 'takeover-fixture-policy',
    preconditions: [],
    steps: [
      {
        id: 'establish-session',
        description: 'Establish fixture session',
        action: { kind: 'navigate', destination: { kind: 'relativeRoute', route: '/establish' } },
        risk: 'read',
        timeoutMs: 5000,
        checkpoint: visible('Workflow ready', 'Workflow page is ready'),
        recovery: { kind: 'none' },
      },
      {
        id: 'human-step',
        description: 'Open details',
        action: {
          kind: 'activate',
          target: {
            description: 'Open details control',
            candidates: [
              { strategy: 'role', role: 'link', name: { kind: 'literal', value: 'Open details' } },
            ],
            match: 'exactlyOne',
          },
        },
        risk: 'read',
        timeoutMs: 5000,
        checkpoint: visible('Human details complete', 'Human details page is visible'),
        recovery: { kind: 'none' },
      },
      {
        id: 'extract-answer',
        description: 'Extract fixture answer',
        action: {
          kind: 'extract',
          output: 'answer',
          target: {
            description: 'Fixture answer',
            candidates: [{ strategy: 'css', selector: '#answer' }],
            match: 'exactlyOne',
          },
          transform: { kind: 'trim' },
        },
        risk: 'read',
        timeoutMs: 5000,
        checkpoint: { kind: 'outputPresent', description: 'Answer extracted', output: 'answer' },
        recovery: { kind: 'none' },
      },
    ],
    success: { kind: 'outputPresent', description: 'Answer is present', output: 'answer' },
    metadata: {
      createdAt: '2026-09-30T00:00:00Z',
      provenance: { kind: 'authoredFixture', reason: 'Step 8C real-browser acceptance fixture' },
    },
  };
}

function policy(baseUrl: string) {
  return {
    schemaVersion: '1.0.0',
    id: 'takeover-fixture-policy',
    version: '1.0.0',
    description: 'Loopback-only takeover fixture policy',
    allowedOrigins: [baseUrl],
    allowedRoutes: [
      { id: 'establish', pattern: '^/establish$' },
      { id: 'workflow', pattern: '^/workflow$' },
      { id: 'details', pattern: '^/details$' },
    ],
    allowedActions: ['navigate', 'activate', 'extract'],
    deniedActions: [],
    riskByAction: {
      navigate: 'navigation',
      activate: 'read',
      enterText: 'input',
      selectOption: 'input',
      pressKey: 'input',
      scroll: 'read',
      wait: 'read',
      extract: 'read',
    },
    allowedSecretReferences: [],
    allowedSecretStepIds: [],
    screenshotRules: { enabled: true, forbidWhileSecretFieldPopulated: true },
    traceRules: { enabled: false, startAfterAuthentication: true },
    navigation: { allowExternal: false, maxNavigations: 4 },
    downloads: 'deny',
    uploads: 'deny',
    maxReplayDurationMs: 30000,
    maxActionAttempts: 2,
    authenticationRecovery: { allowed: false, maxAttempts: 1 },
    interventionActions: [],
    interventionStepIds: ['human-step'],
    defaultDecision: 'deny',
    metadata: { createdAt: '2026-09-30T00:00:00Z' },
  };
}

async function startHarness(): Promise<Harness> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'human-takeover-'));
  const serverSession = confidential.session;
  const targetServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const authenticated = (request.headers.cookie ?? '').includes(
      `fixture-session=${serverSession}`,
    );
    if (url.pathname === '/establish') {
      response.statusCode = 302;
      response.setHeader('Location', '/workflow');
      response.setHeader('Set-Cookie', [
        `fixture-session=${serverSession}; HttpOnly; SameSite=Strict; Path=/`,
        `authorization=${confidential.cookie}; HttpOnly; SameSite=Strict; Path=/`,
      ]);
      response.end();
      return;
    }
    if (!authenticated) {
      response.statusCode = 401;
      response.end('<h1>Session required</h1>');
      return;
    }
    response.setHeader('content-type', 'text/html');
    if (url.pathname === '/workflow') {
      response.end(
        '<!doctype html><h1>Workflow ready</h1><a id="open-details" href="/details">Open details</a>',
      );
      return;
    }
    if (url.pathname === '/details') {
      response.end('<!doctype html><h1>Human details complete</h1><div id="answer">verified</div>');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const address = targetServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const artifactPath = path.join(scratch, 'artifact.json');
  const policyPath = path.join(scratch, 'policy.json');
  await writeFile(artifactPath, JSON.stringify(artifact(baseUrl)));
  await writeFile(policyPath, JSON.stringify(policy(baseUrl)));
  let resolveOperatorUrl!: (url: string) => void;
  const operatorUrlReady = new Promise<string>((resolve) => (resolveOperatorUrl = resolve));
  const coordinator = new OperatorInterventionCoordinator(resolveOperatorUrl);
  const adapter = new InstrumentedAdapter();
  const replay = new ReplayEngine().run({
    loadedArtifact: await loadArtifact(artifactPath),
    loadedPolicy: await loadPolicy(policyPath),
    inputs: {},
    secrets: {},
    baseUrl,
    evidenceDirectory: scratch,
    headless: true,
    adapter,
    executionMode: 'interactive',
    interventionCoordinator: coordinator,
  });
  const operatorUrl = await operatorUrlReady;
  const parsed = new URL(operatorUrl);
  const token = parsed.hash.slice(1);
  const operatorPort = Number(parsed.port);
  const operatorBrowser = await chromium.launch({ headless: true });
  const operatorPage = await operatorBrowser.newPage();
  await operatorPage.goto(operatorUrl);
  return {
    adapter,
    coordinator,
    operatorPage,
    operatorBrowser,
    replay,
    scratch,
    targetServer,
    operatorPort,
    token,
    serverSession,
  };
}

async function claim(harness: Harness): Promise<void> {
  await expect.poll(() => harness.operatorPage.locator('#claim').isEnabled()).toBe(true);
  await harness.operatorPage.getByRole('button', { name: 'Claim Control' }).click();
  await expect.poll(() => harness.coordinator.snapshot().owner).toBe('human');
}

async function humanOpenDetails(harness: Harness): Promise<void> {
  expect(harness.coordinator.snapshot().owner).toBe('human');
  await harness.adapter.targetPage().getByRole('link', { name: 'Open details' }).click();
  await expect
    .poll(() => harness.adapter.targetPage().getByText('Human details complete').isVisible())
    .toBe(true);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function assertPortReleased(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

async function dispose(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  if (harness.coordinator.snapshot().owner === 'human')
    await harness.operatorPage
      .getByRole('button', { name: 'Abort Run' })
      .click()
      .catch(() => undefined);
  await harness.replay.catch(() => undefined);
  await harness.operatorBrowser.close();
  await harness.coordinator.close();
  await closeServer(harness.targetServer);
  await rm(harness.scratch, { recursive: true, force: true });
}

let active: Harness | undefined;
afterEach(async () => {
  await dispose(active);
  active = undefined;
});

describe('real target Chromium human takeover', () => {
  it('rejects unchanged state then resumes in the same browser session after direct human action', async () => {
    active = await startHarness();
    const targetPage = active.adapter.targetPage();
    const browser = active.adapter.session.browser;
    const context = active.adapter.session.context;
    const cookiesBefore = await context!.cookies();
    const actionsAtPause = active.adapter.actions.length;
    await claim(active);

    await active.operatorPage.getByRole('button', { name: 'Resume Automation' }).click();
    await expect.poll(() => active!.coordinator.snapshot().validationState).toBe('rejected');
    expect(active.adapter.targetPage()).toBe(targetPage);
    expect(active.adapter.session.browser).toBe(browser);
    expect(active.adapter.session.context).toBe(context);
    expect(active.adapter.actions).toHaveLength(actionsAtPause);

    await humanOpenDetails(active);
    expect(active.adapter.actions).toHaveLength(actionsAtPause);
    expect(active.adapter.targetPage()).toBe(targetPage);
    expect(active.adapter.session.browser).toBe(browser);
    expect(active.adapter.session.context).toBe(context);
    expect(await context!.cookies()).toEqual(cookiesBefore);
    await active.operatorPage.getByRole('button', { name: 'Resume Automation' }).click();
    const result = await active.replay;
    expect(result).toMatchObject({ status: 'success', outputs: { answer: 'verified' } });
    expect(active.adapter.actions.filter((kind) => kind === 'activate')).toHaveLength(0);
    expect(active.adapter.session.state).toBe('closed');

    const events = await readFile(
      path.join(active.scratch, 'runs', result.runId, 'events.jsonl'),
      'utf8',
    );
    expect(events).toContain('resume_rejected');
    expect(events).toContain('automation_resumed');
    expect(events).toContain('session_continuity_verified');
    expect(events).toContain('run_succeeded');
    expect(events).toContain('"sameBrowserSession":true');
    expect(events).not.toContain(confidential.session);
    expect(events).not.toContain(confidential.cookie);
  });

  it('rejects early Complete then verifies typed output from the human-finished real page', async () => {
    active = await startHarness();
    const page = active.adapter.targetPage();
    const actionsAtPause = active.adapter.actions.length;
    await claim(active);
    await active.operatorPage.getByRole('button', { name: 'Complete Task' }).click();
    await expect.poll(() => active!.coordinator.snapshot().validationState).toBe('rejected');
    expect(active.adapter.targetPage()).toBe(page);
    expect(active.adapter.session.state).toBe('active');

    await humanOpenDetails(active);
    expect(active.adapter.actions.length).toBeGreaterThanOrEqual(actionsAtPause);
    await active.operatorPage.getByRole('button', { name: 'Complete Task' }).click();
    const result = await active.replay;
    expect(result).toMatchObject({
      status: 'success',
      completionMode: 'human',
      outputs: { answer: 'verified' },
    });
    expect(active.adapter.actions.filter((kind) => kind === 'activate')).toHaveLength(0);
    const events = await readFile(
      path.join(active.scratch, 'runs', result.runId, 'events.jsonl'),
      'utf8',
    );
    expect(events).toContain('completion_accepted');
    expect(events).toContain('run_succeeded');
  });

  it('aborts the real target session and releases the operator port', async () => {
    active = await startHarness();
    const actionsAtPause = active.adapter.actions.length;
    const port = active.operatorPort;
    await claim(active);
    await active.operatorPage.getByRole('button', { name: 'Abort Run' }).click();
    const result = await active.replay;
    expect(result).toMatchObject({ status: 'aborted', code: 'ABORTED_BY_HUMAN' });
    expect(active.adapter.actions).toHaveLength(actionsAtPause);
    expect(active.adapter.session.state).toBe('closed');
    await assertPortReleased(port);
    const files = await readdir(path.join(active.scratch, 'runs', result.runId));
    expect(files.some((file) => file.endsWith('.zip'))).toBe(false);
    for (const file of files) {
      const bytes = await readFile(path.join(active.scratch, 'runs', result.runId, file));
      for (const value of Object.values(confidential))
        expect(bytes.includes(Buffer.from(value))).toBe(false);
      expect(bytes.includes(Buffer.from(active.token))).toBe(false);
    }
  });
});
