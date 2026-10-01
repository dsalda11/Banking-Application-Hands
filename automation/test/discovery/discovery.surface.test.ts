import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscoveryObservationType } from '../../src/domain/discovery.js';
import { DiscoveryOrchestrator } from '../../src/discovery/discovery-orchestrator.js';
import { loadDiscoveryGoal } from '../../src/discovery/goal-loader.js';
import { ScriptedPlannerClient } from '../../src/discovery/planner-client.js';
import { OperatorInterventionCoordinator } from '../../src/intervention/intervention-coordinator.js';
import { loadPolicy } from '../../src/policy/policy-loader.js';
import { PlaywrightWebAdapter } from '../../src/surfaces/web/playwright-web-adapter.js';
import { DiscoveryTraceLoader } from '../../src/compiler/trace-loader.js';
import { ArtifactCompiler } from '../../src/compiler/artifact-compiler.js';
import {
  reviewArtifact,
  storeDraft,
  verifyArtifact,
} from '../../src/compiler/artifact-lifecycle.js';

interface Fixture {
  server: Server;
  origin: string;
  directory: string;
  goalPath: string;
  policyPath: string;
  evidence: string;
  close(): Promise<void>;
}
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()?.();
});

async function startFixture(): Promise<Fixture> {
  const sessionCookie = 'session-' + crypto.randomUUID();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'discovery-browser-'));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const authenticated = request.headers.cookie?.includes(sessionCookie) ?? false;
    const send = (body: string, status = 200, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      response.end(body);
    };
    if (request.method === 'GET' && url.pathname === '/start')
      return send(
        '<!doctype html><title>Staff login</title><h1>Staff login</h1>' +
          '<form method="post" action="/login">' +
          '<label>Staff username<input name="username" aria-label="Staff username"></label>' +
          '<label>Password<input name="password" aria-label="Password" type="password"></label>' +
          '<button>Login</button></form>',
      );
    if (request.method === 'GET' && url.pathname === '/frame')
      return send(
        '<title>Frame fixture</title><h1>Frame fixture</h1>' +
          '<iframe name="test-frame" title="Test frame" src="/frame-content"></iframe>',
      );
    if (request.method === 'GET' && url.pathname === '/frame-content')
      return send(
        '<title>Frame content</title><button aria-label="Frame action" ' +
          'onclick="this.textContent=\'Clicked\'">Frame action</button>',
      );
    if (request.method === 'POST' && url.pathname === '/login') {
      request.resume();
      request.on('end', () => {
        response.writeHead(303, {
          location: '/customers',
          'set-cookie': sessionCookie + '; Path=/; HttpOnly; SameSite=Strict',
        });
        response.end();
      });
      return;
    }
    if (!authenticated) return send('<h1>Session expired</h1>', 401);
    if (request.method === 'GET' && url.pathname === '/customers')
      return send(
        '<!doctype html><title>Customers</title><h1>Customers</h1>' +
          '<form method="get" action="/details">' +
          '<label>Customer username<input name="customerUsername" aria-label="Customer username"></label>' +
          '<button>Find customer</button></form>',
      );
    if (request.method === 'GET' && url.pathname === '/details') {
      if (url.searchParams.get('customerUsername') === 'missing-user')
        return send('<title>Customer search</title><h1>Customer not found</h1><p>Not found</p>');
      return send(
        '<title>Customer details</title><h1>Customer details</h1>' +
          '<label>Answer<input aria-label="Answer" value="verified" readonly></label>',
      );
    }
    return send('<h1>Not found</h1>', 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const origin = 'http://127.0.0.1:' + address.port;
  const goalPath = path.join(directory, 'goal.json');
  const policyPath = path.join(directory, 'policy.json');
  const evidence = path.join(directory, 'evidence');
  await writeFile(
    goalPath,
    JSON.stringify({
      schemaVersion: '1.0.0',
      id: 'browser-discovery',
      version: '1.0.0',
      objective: 'Authenticate, find the declared customer, and extract the answer.',
      startUrl: origin + '/start',
      inputs: {
        customerUsername: {
          description: 'Customer username',
          shape: { kind: 'string', minLength: 1, maxLength: 128 },
        },
      },
      secretReferences: ['TEST_USERNAME', 'TEST_PASSWORD'],
      outputs: {
        answer: {
          description: 'Fixture answer',
          shape: { kind: 'string', minLength: 1, maxLength: 32 },
        },
      },
      successCriteria: [
        { kind: 'outputMatchesShape', description: 'Answer is typed', output: 'answer' },
      ],
      businessOutcomes: [
        {
          code: 'CUSTOMER_NOT_FOUND',
          result: 'businessOutcome',
          description: 'Missing customer',
          detection: { kind: 'textPresent', description: 'Missing text', text: 'Not found' },
        },
      ],
      applicationScope: {
        allowedOrigins: [origin],
        allowedRoutePatterns: [
          '^/start$',
          '^/login$',
          '^/customers$',
          '^/details$',
          '^/frame$',
          '^/frame-content$',
        ],
      },
      budgets: {
        maxModelCalls: 16,
        maxActions: 16,
        timeoutMs: 30000,
        maxRepeatedStates: 4,
        maxConsecutiveFailures: 3,
        maxNavigations: 8,
      },
      allowHumanIntervention: true,
      screenshotPolicy: 'disabled',
      policyRef: 'browser-discovery-policy',
    }),
  );
  await writeFile(
    policyPath,
    JSON.stringify({
      schemaVersion: '1.0.0',
      id: 'browser-discovery-policy',
      version: '1.0.0',
      description: 'Browser discovery fixture policy',
      allowedOrigins: [origin],
      allowedRoutes: [
        { id: 'fixture', pattern: '^/(start|login|customers|details|frame|frame-content)$' },
      ],
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
      allowedSecretReferences: ['TEST_USERNAME', 'TEST_PASSWORD'],
      allowedSecretStepIds: ['discovery-enterSecret', 'step-002-enter-text', 'step-003-enter-text'],
      screenshotRules: { enabled: false, forbidWhileSecretFieldPopulated: true },
      traceRules: { enabled: false, startAfterAuthentication: true },
      navigation: { allowExternal: false, maxNavigations: 8 },
      downloads: 'deny',
      uploads: 'deny',
      maxReplayDurationMs: 30000,
      maxActionAttempts: 1,
      authenticationRecovery: { allowed: false, maxAttempts: 1 },
      interventionActions: [],
      interventionStepIds: [],
      defaultDecision: 'deny',
      metadata: { createdAt: '2026-09-30T00:00:00Z' },
    }),
  );
  const fixture: Fixture = {
    server,
    origin,
    directory,
    goalPath,
    policyPath,
    evidence,
    close: async () => {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
  disposers.push(fixture.close);
  return fixture;
}

function element(observation: DiscoveryObservationType, name: string) {
  const match = observation.elements.find(
    (candidate) => candidate.name === name || candidate.text === name,
  );
  if (!match) throw new Error('Missing observed element ' + name);
  return match.reference;
}
function proposal(
  request: { observation: DiscoveryObservationType },
  call: number,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    proposalId: 'proposal-' + (call + 1),
    observationId: request.observation.observationId,
    stateFingerprint: request.observation.stateFingerprint,
    rationale: 'Deterministic browser fixture action.',
    expectedPostcondition: 'The rendered fixture advances.',
    ...extra,
  };
}
function successfulPlanner(offset = 0) {
  return new ScriptedPlannerClient((request, rawCall) => {
    const call = rawCall - offset;
    if (call === 0)
      return proposal(request, rawCall, 'enterSecret', {
        elementReference: element(request.observation, 'Staff username'),
        secretName: 'TEST_USERNAME',
      });
    if (call === 1)
      return proposal(request, rawCall, 'enterSecret', {
        elementReference: element(request.observation, 'Password'),
        secretName: 'TEST_PASSWORD',
      });
    if (call === 2)
      return proposal(request, rawCall, 'click', {
        elementReference: element(request.observation, 'Login'),
      });
    if (call === 3)
      return proposal(request, rawCall, 'enterInput', {
        elementReference: element(request.observation, 'Customer username'),
        inputName: 'customerUsername',
      });
    if (call === 4)
      return proposal(request, rawCall, 'click', {
        elementReference: element(request.observation, 'Find customer'),
      });
    if (call === 5)
      return proposal(request, rawCall, 'extract', {
        elementReference: element(request.observation, 'Answer'),
        outputName: 'answer',
        transform: 'trim',
      });
    return proposal(request, rawCall, 'finish');
  });
}
async function runOptions(
  fixture: Fixture,
  planner: ScriptedPlannerClient,
  coordinator?: OperatorInterventionCoordinator,
) {
  return {
    loadedGoal: await loadDiscoveryGoal(fixture.goalPath),
    loadedPolicy: await loadPolicy(fixture.policyPath),
    inputs: { customerUsername: 'customer' },
    secrets: {
      TEST_USERNAME: 'username-' + crypto.randomUUID(),
      TEST_PASSWORD: 'password-' + crypto.randomUUID(),
    },
    adapter: new PlaywrightWebAdapter(),
    planner,
    evidenceDirectory: fixture.evidence,
    headless: true,
    ...(coordinator ? { interventionCoordinator: coordinator } : {}),
  };
}
async function post(url: string, token: string, route: string, body?: unknown) {
  return fetch(new URL('/api/' + route, url), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      origin: new URL(url).origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function retainedFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const item = path.join(directory, entry.name);
        return entry.isDirectory() ? retainedFiles(item) : [item];
      }),
    )
  ).flat();
}

describe('real-browser bounded discovery', () => {
  it('completes a multi-step flow with no secret retention', async () => {
    const fixture = await startFixture();
    const options = await runOptions(fixture, successfulPlanner());
    const result = await new DiscoveryOrchestrator().run(options);
    expect(result).toMatchObject({ status: 'success', outputs: { answer: 'verified' } });
    const files = await retainedFiles(fixture.evidence);
    const retained = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
    for (const secret of Object.values(options.secrets))
      expect(retained.includes(Buffer.from(secret))).toBe(false);
    expect(files.some((file) => file.endsWith('.zip'))).toBe(false);
  });

  it('rejects a stale observation deterministically', async () => {
    const fixture = await startFixture();
    const stale = new ScriptedPlannerClient((request, call) => ({
      ...proposal(request, call, 'click', {
        elementReference: element(request.observation, 'Login'),
      }),
      observationId: 'obsolete-observation',
    }));
    const result = await new DiscoveryOrchestrator().run(await runOptions(fixture, stale));
    expect(result).toMatchObject({ status: 'stopped', code: 'STALE_OBSERVATION' });
  });

  it('terminates a repeated real-browser state without executing another action', async () => {
    const fixture = await startFixture();
    const planner = new ScriptedPlannerClient((request, call) =>
      proposal(request, call, 'assertCheckpoint', {
        checkpoint: {
          kind: 'textPresent',
          description: 'Login remains visible',
          text: 'Staff login',
        },
      }),
    );
    const result = await new DiscoveryOrchestrator().run(await runOptions(fixture, planner));
    expect(result).toMatchObject({ status: 'stopped', code: 'REPEATED_STATE' });
  });

  it('uses observation-issued frame locators rather than invented selectors', async () => {
    const fixture = await startFixture();
    const rawGoal = JSON.parse(await readFile(fixture.goalPath, 'utf8')) as Record<string, unknown>;
    rawGoal.startUrl = fixture.origin + '/frame';
    await writeFile(fixture.goalPath, JSON.stringify(rawGoal));
    const planner = new ScriptedPlannerClient((request, call) =>
      call === 0
        ? proposal(request, call, 'click', {
            elementReference: element(request.observation, 'Frame action'),
          })
        : proposal(request, call, 'stopSafely', { reason: 'Frame action was exercised.' }),
    );
    const result = await new DiscoveryOrchestrator().run(await runOptions(fixture, planner));
    expect(result).toMatchObject({ status: 'stopped', code: 'STOPPED_SAFELY', actions: 2 });
  });

  it('recognizes CUSTOMER_NOT_FOUND from rendered UI', async () => {
    const fixture = await startFixture();
    const normal = successfulPlanner();
    const planner = new ScriptedPlannerClient(async (request, call) => {
      if (call < 5) return (await normal.propose(request)).proposal;
      return proposal(request, call, 'reportBusinessOutcome', {
        outcomeCode: 'CUSTOMER_NOT_FOUND',
      });
    });
    const configured = await runOptions(fixture, planner);
    configured.inputs.customerUsername = 'missing-user';
    const result = await new DiscoveryOrchestrator().run(configured);
    expect(result).toMatchObject({
      status: 'businessOutcome',
      outcome: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('runs discovery -> compile -> review -> fresh replay three consecutive times', async () => {
    const fixture = await startFixture();
    const loadedGoal = await loadDiscoveryGoal(fixture.goalPath);
    const loadedPolicy = await loadPolicy(fixture.policyPath);
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const successOptions = await runOptions(fixture, successfulPlanner());
      const success = await new DiscoveryOrchestrator().run(successOptions);
      expect(success.status).toBe('success');

      const normal = successfulPlanner();
      const outcomePlanner = new ScriptedPlannerClient(async (request, call) => {
        if (call < 5) return (await normal.propose(request)).proposal;
        return proposal(request, call, 'reportBusinessOutcome', {
          outcomeCode: 'CUSTOMER_NOT_FOUND',
        });
      });
      const outcomeOptions = await runOptions(fixture, outcomePlanner);
      outcomeOptions.inputs.customerUsername = 'missing-user';
      const outcome = await new DiscoveryOrchestrator().run(outcomeOptions);
      expect(outcome).toMatchObject({ status: 'businessOutcome', outcome: 'CUSTOMER_NOT_FOUND' });
      if (success.status !== 'success' || outcome.status !== 'businessOutcome')
        throw new Error('Fixture discovery did not terminate as expected');

      const tracePaths = [success.runId, outcome.runId].map((runId) =>
        path.join(fixture.evidence, 'runs', runId, 'discovery-events.jsonl'),
      );
      const traces = await new DiscoveryTraceLoader().loadSet(tracePaths);
      const compilation = new ArtifactCompiler().compile(
        loadedGoal,
        traces,
        { id: `fixture.compiled-${iteration}`, version: '1.0.0' },
        { compilationTime: '2026-09-30T00:00:00.000Z' },
      );
      const secondCompilation = new ArtifactCompiler().compile(
        loadedGoal,
        traces,
        { id: `fixture.compiled-${iteration}`, version: '1.0.0' },
        { compilationTime: '2026-09-30T00:00:00.000Z' },
      );
      expect(secondCompilation.artifactBytes).toBe(compilation.artifactBytes);
      expect(compilation.artifactBytes).not.toContain('username-');
      expect(compilation.artifactBytes).not.toContain('password-');
      expect(compilation.artifact.contract.inputs).toHaveProperty('customerUsername');
      expect(compilation.artifact.contract.requiredSecrets).toEqual([
        'TEST_USERNAME',
        'TEST_PASSWORD',
      ]);

      const drafts = path.join(fixture.directory, `drafts-${iteration}`);
      const stored = await storeDraft(drafts, compilation);
      const reviewPath = path.join(drafts, 'review.json');
      await reviewArtifact({
        artifactPath: stored.artifactPath,
        compilationManifestPath: stored.manifestPath,
        reviewPath,
        decision: 'approved',
        reviewer: 'automated-explicit-test-review',
        now: () => new Date('2026-09-30T00:00:00.000Z'),
      });
      const verificationPath = path.join(drafts, 'verification.json');
      const verification = await verifyArtifact({
        artifactPath: stored.artifactPath,
        reviewPath,
        verificationPath,
        loadedPolicy,
        secrets: successOptions.secrets,
        cases: [
          {
            name: 'typed-success',
            inputs: { customerUsername: 'customer' },
            expected: 'success',
            expectedOutputs: { answer: 'verified' },
          },
          {
            name: 'declared-not-found',
            inputs: { customerUsername: 'missing-user' },
            expected: 'CUSTOMER_NOT_FOUND',
          },
        ],
        baseUrl: fixture.origin,
        evidenceDirectory: fixture.evidence,
        headless: true,
        adapterFactory: () => new PlaywrightWebAdapter(),
        now: () => new Date('2026-09-30T00:00:00.000Z'),
      });
      expect(verification.result).toBe('promotionEligible');
      expect(new Set(verification.cases.map((testCase) => testCase.runId)).size).toBe(2);
    }
  }, 120_000);

  it('resumes through the existing Step 8 coordinator with a fresh observation', async () => {
    const fixture = await startFixture();
    let operatorUrl = '';
    let resolveUrl!: () => void;
    const ready = new Promise<void>((resolve) => (resolveUrl = resolve));
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
      resolveUrl();
    });
    const observed: string[] = [];
    const normal = successfulPlanner();
    const planner = new ScriptedPlannerClient(async (request, call) => {
      observed.push(request.observation.observationId);
      if (call === 0)
        return proposal(request, call, 'requestHuman', {
          reason: 'Confirm the fixture session.',
        });
      return (await normal.propose(request)).proposal;
    });
    const run = new DiscoveryOrchestrator().run(await runOptions(fixture, planner, coordinator));
    await ready;
    const parsed = new URL(operatorUrl);
    const token = parsed.hash.slice(1);
    const claim = await post(operatorUrl, token, 'claim');
    const claimed = (await claim.json()) as { lease: { generation: number } };
    expect(
      (await post(operatorUrl, token, 'resume', { generation: claimed.lease.generation })).ok,
    ).toBe(true);
    const result = await run;
    if (result.status === 'stopped')
      throw new Error(`resume discovery stopped: ${result.code}: ${result.reason}`);
    expect(result).toMatchObject({ status: 'success', outputs: { answer: 'verified' } });
    expect(observed[1]).not.toBe(observed[0]);
    const traceFile = (await retainedFiles(fixture.evidence)).find((file) =>
      file.endsWith('discovery-events.jsonl'),
    );
    expect(traceFile).toBeDefined();
    const events = (await readFile(traceFile!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string; data: Record<string, unknown> });
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: 'intervention',
        data: expect.objectContaining({
          phase: 'resumed',
          sameBrowserSession: true,
          sameContext: true,
          samePage: true,
          applicationSessionPreserved: true,
        }),
      }),
    );
  });

  it('aborts discovery through the existing operator coordinator', async () => {
    const fixture = await startFixture();
    let operatorUrl = '';
    let resolveUrl!: () => void;
    const ready = new Promise<void>((resolve) => (resolveUrl = resolve));
    const coordinator = new OperatorInterventionCoordinator((url) => {
      operatorUrl = url;
      resolveUrl();
    });
    const planner = new ScriptedPlannerClient((request, call) =>
      proposal(request, call, 'requestHuman', { reason: 'Abort fixture.' }),
    );
    const run = new DiscoveryOrchestrator().run(await runOptions(fixture, planner, coordinator));
    await ready;
    const parsed = new URL(operatorUrl);
    const token = parsed.hash.slice(1);
    const claim = await post(operatorUrl, token, 'claim');
    const claimed = (await claim.json()) as { lease: { generation: number } };
    expect(
      (await post(operatorUrl, token, 'abort', { generation: claimed.lease.generation })).ok,
    ).toBe(true);
    await expect(run).resolves.toMatchObject({
      status: 'stopped',
      code: 'ABORTED_BY_HUMAN',
    });
  });
});
