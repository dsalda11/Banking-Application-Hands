import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadArtifact } from '../../src/replay/artifact-loader.js';
import { ReplayEngine } from '../../src/replay/replay-engine.js';
import { loadPolicy } from '../../src/policy/policy-loader.js';
import { PlaywrightWebAdapter } from '../../src/surfaces/web/playwright-web-adapter.js';

type Mode = 'recover' | 'second-expiration' | 'permission';
const sentinels = {
  password: 'fixture-password-sentinel-3b7d',
  token: 'fixture-session-token-sentinel-8ca1',
  cookie: 'fixture-cookie-sentinel-c901',
};
let server: Server | undefined;
let scratch: string | undefined;

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

async function startFixture(mode: Mode): Promise<{ baseUrl: string }> {
  let logins = 0;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const cookie = request.headers.cookie ?? '';
    const guest = cookie.includes('role=guest');
    const authenticated = cookie.includes('fixture-session=');
    if (url.pathname === '/login' && request.method === 'GET') {
      response.end(
        page(
          '<h1>Login</h1><form method="post"><label>Username <input name="username"></label><label>Password <input type="password" name="password"></label><button type="submit">Submit</button></form>',
        ),
      );
      return;
    }
    if (url.pathname === '/login' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        logins += 1;
        const isGuest = body.includes('username=guest-user');
        response.statusCode = 302;
        response.setHeader('Location', '/landing');
        response.setHeader('Set-Cookie', [
          `fixture-session=${sentinels.token}; HttpOnly; Path=/`,
          `role=${isGuest ? 'guest' : 'staff'}; HttpOnly; Path=/`,
          `authorization=${sentinels.cookie}; HttpOnly; Path=/`,
        ]);
        response.end();
      });
      return;
    }
    if (url.pathname === '/landing') {
      if (!authenticated) {
        response.statusCode = 302;
        response.setHeader('Location', '/login');
        response.end();
        return;
      }
      response.end(page('<h1>Authenticated</h1>'));
      return;
    }
    if (url.pathname === '/protected') {
      if (
        !authenticated ||
        (mode !== 'permission' && logins === 1) ||
        (mode === 'second-expiration' && logins === 2)
      ) {
        response.statusCode = 302;
        response.setHeader('Location', '/login');
        response.end();
        return;
      }
      if (guest) {
        response.statusCode = 403;
        response.end(page('<h1>Permission denied</h1>'));
        return;
      }
      response.end(page('<h1>Protected</h1><div id="value">RECOVERED_OUTPUT</div>'));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function artifact(baseUrl: string, id: string): object {
  const target = (name: string) => ({
    description: `${name} field`,
    candidates: [{ strategy: 'attribute', name: 'name', value: { kind: 'literal', value: name } }],
    match: 'exactlyOne',
  });
  const visible = (text: string, description: string) => ({
    kind: 'textPresent',
    text,
    description,
  });
  const loginSteps = [
    {
      id: 'open-login',
      description: 'Open login',
      action: { kind: 'navigate', destination: { kind: 'relativeRoute', route: '/login' } },
      risk: 'read',
      timeoutMs: 5000,
      checkpoint: visible('Login', 'Login visible'),
      recovery: { kind: 'none' },
    },
    {
      id: 'enter-username',
      description: 'Enter username',
      action: {
        kind: 'enterText',
        target: target('username'),
        value: { kind: 'secret', name: 'FIXTURE_USERNAME' },
        clear: true,
      },
      risk: 'reversibleWrite',
      timeoutMs: 5000,
      checkpoint: {
        kind: 'elementVisible',
        description: 'Password visible',
        target: target('password'),
      },
      recovery: { kind: 'none' },
    },
    {
      id: 'enter-password',
      description: 'Enter password',
      action: {
        kind: 'enterText',
        target: target('password'),
        value: { kind: 'secret', name: 'FIXTURE_PASSWORD' },
        clear: true,
      },
      risk: 'reversibleWrite',
      timeoutMs: 5000,
      checkpoint: {
        kind: 'elementVisible',
        description: 'Submit visible',
        target: {
          description: 'Submit',
          candidates: [
            { strategy: 'role', role: 'button', name: { kind: 'literal', value: 'Submit' } },
          ],
          match: 'exactlyOne',
        },
      },
      recovery: { kind: 'none' },
    },
    {
      id: 'submit-login',
      description: 'Submit login',
      action: {
        kind: 'activate',
        target: {
          description: 'Submit',
          candidates: [
            { strategy: 'role', role: 'button', name: { kind: 'literal', value: 'Submit' } },
          ],
          match: 'exactlyOne',
        },
      },
      risk: 'reversibleWrite',
      timeoutMs: 5000,
      checkpoint: { kind: 'urlMatches', description: 'Landing page', pattern: '/landing' },
      recovery: { kind: 'none' },
    },
  ];
  const recovery = {
    kind: 'reauthenticate',
    maxAttempts: 1,
    sessionExpired: visible('Login', 'Login returned after expiration'),
    steps: loginSteps.slice(1).map((step) => ({
      id: `recovery-${step.id}`,
      description: `Recovery ${step.description}`,
      action: step.action,
      timeoutMs: step.timeoutMs,
      checkpoint:
        step.id === 'submit-login'
          ? { kind: 'urlMatches', description: 'Recovery landing', pattern: '/landing' }
          : step.checkpoint,
    })),
    checkpoint: { kind: 'urlMatches', description: 'Recovery authenticated', pattern: '/landing' },
  };
  return {
    schemaVersion: '1.0.0',
    id,
    version: '1.0.0',
    lifecycle: 'draft',
    name: 'Loopback recovery fixture',
    description: 'Loopback recovery fixture',
    target: {
      surface: 'web',
      product: 'loopback-fixture',
      entryPoint: { kind: 'absoluteUrl', url: `${baseUrl}/login` },
      fingerprints: [{ kind: 'requiredText', id: 'login-text', text: 'Login' }],
    },
    contract: {
      inputs: {},
      requiredSecrets: ['FIXTURE_USERNAME', 'FIXTURE_PASSWORD'],
      outputs: {
        recoveredValue: {
          description: 'Protected fixture output',
          shape: { kind: 'string', minLength: 1 },
        },
      },
      businessOutcomes: [
        {
          code: 'PERMISSION_DENIED',
          result: 'permissionDenied',
          description: 'Fixture denial',
          detection: visible('Permission denied', 'Fixture permission denial'),
        },
      ],
    },
    policyRef: 'fixture-policy',
    preconditions: [],
    steps: [
      ...loginSteps,
      {
        id: 'open-protected',
        description: 'Open protected page',
        action: { kind: 'navigate', destination: { kind: 'relativeRoute', route: '/protected' } },
        risk: 'read',
        timeoutMs: 5000,
        checkpoint: visible('Protected', 'Protected page visible'),
        recovery,
      },
      {
        id: 'extract-value',
        description: 'Extract recovered value',
        action: {
          kind: 'extract',
          output: 'recoveredValue',
          target: {
            description: 'Protected output',
            candidates: [{ strategy: 'css', selector: '#value' }],
            match: 'exactlyOne',
          },
          transform: { kind: 'trim' },
        },
        risk: 'read',
        timeoutMs: 5000,
        checkpoint: {
          kind: 'outputPresent',
          description: 'Output present',
          output: 'recoveredValue',
        },
        recovery: { kind: 'none' },
      },
    ],
    success: {
      kind: 'outputPresent',
      description: 'Recovered output present',
      output: 'recoveredValue',
    },
    metadata: {
      createdAt: '2026-09-30T00:00:00Z',
      provenance: { kind: 'authoredFixture', reason: 'Deterministic recovery browser test' },
    },
  };
}

function policy(baseUrl: string): object {
  return {
    schemaVersion: '1.0.0',
    id: 'fixture-policy',
    version: '1.0.0',
    description: 'Fixture policy',
    allowedOrigins: [baseUrl],
    allowedRoutes: [
      { id: 'login', pattern: '^/login$' },
      { id: 'landing', pattern: '^/landing$' },
      { id: 'protected', pattern: '^/protected$' },
    ],
    allowedActions: ['navigate', 'activate', 'enterText', 'extract'],
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
    allowedSecretReferences: ['FIXTURE_USERNAME', 'FIXTURE_PASSWORD'],
    allowedSecretStepIds: [
      'enter-username',
      'enter-password',
      'recovery-enter-username',
      'recovery-enter-password',
    ],
    screenshotRules: { enabled: true, forbidWhileSecretFieldPopulated: true },
    traceRules: { enabled: false, startAfterAuthentication: true },
    navigation: { allowExternal: false, maxNavigations: 12 },
    downloads: 'deny',
    uploads: 'deny',
    maxReplayDurationMs: 30000,
    maxActionAttempts: 2,
    authenticationRecovery: { allowed: true, maxAttempts: 1 },
    interventionActions: [],
    defaultDecision: 'deny',
    metadata: { createdAt: '2026-09-30T00:00:00Z' },
  };
}

async function run(mode: Mode) {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'recovery-fixture-'));
  const { baseUrl } = await startFixture(mode);
  const artifactPath = path.join(scratch, 'artifact.json');
  const policyPath = path.join(scratch, 'policy.json');
  await writeFile(artifactPath, JSON.stringify(artifact(baseUrl, `fixture-${mode}`)));
  await writeFile(policyPath, JSON.stringify(policy(baseUrl)));
  const result = await new ReplayEngine().run({
    loadedArtifact: await loadArtifact(artifactPath),
    loadedPolicy: await loadPolicy(policyPath),
    inputs: {},
    secrets: {
      FIXTURE_USERNAME: mode === 'permission' ? 'guest-user' : 'fixture-user',
      FIXTURE_PASSWORD: sentinels.password,
    },
    baseUrl,
    evidenceDirectory: scratch,
    headless: true,
    adapter: new PlaywrightWebAdapter(),
  });
  const runDirectory = path.join(scratch, 'runs', result.runId);
  const events = (await readFile(path.join(runDirectory, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return { result, events, runDirectory };
}

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('Replay recovery browser fixture', () => {
  it('recovers once, resumes only the interrupted safe step, and retains no confidential sentinels', async () => {
    const { result, events, runDirectory } = await run('recover');
    expect(result.status).toBe('success');
    expect(result.status === 'success' && result.outputs.recoveredValue).toBe('RECOVERED_OUTPUT');
    expect(events.filter((event) => event.eventType === 'recovery_started')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'recovery_succeeded')).toHaveLength(1);
    expect(
      events.filter(
        (event) => !event.eventType && event.stepId === 'open-login' && event.action === 'navigate',
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          !event.eventType && event.stepId === 'open-protected' && event.action === 'navigate',
      ),
    ).toHaveLength(2);
    expect(events.some((event) => event.eventType === 'trace_omitted')).toBe(true);
    const recovery = events.find((event) => event.eventType === 'recovery_started')!;
    const startedAt = events.indexOf(recovery);
    const succeededAt = events.findIndex((event) => event.eventType === 'recovery_succeeded');
    const resumedAt = events.findIndex(
      (event, index) =>
        index > succeededAt && !event.eventType && event.stepId === 'open-protected',
    );
    expect(recovery.recoveryId).toBeTruthy();
    expect(startedAt).toBeLessThan(succeededAt);
    expect(succeededAt).toBeLessThan(resumedAt);
    const retainedFiles = await readdir(runDirectory);
    for (const name of retainedFiles) {
      const bytes = await readFile(path.join(runDirectory, name));
      for (const secret of Object.values(sentinels)) expect(bytes.includes(secret)).toBe(false);
    }
    expect(retainedFiles.some((name) => name.endsWith('.zip'))).toBe(false);
  });

  it('fails terminally when a second expiration follows recovery', async () => {
    const { result, events } = await run('second-expiration');
    expect(result.status).toBe('failure');
    expect(result.status === 'failure' && result.error.code).toBe('SESSION_EXPIRED');
    expect(events.filter((event) => event.eventType === 'recovery_started')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'session_expired')).toHaveLength(2);
  });

  it('returns permission denied without attempting recovery', async () => {
    const { result, events } = await run('permission');
    expect(result.status).toBe('permissionDenied');
    expect(events.filter((event) => event.eventType === 'recovery_started')).toHaveLength(0);
  });
});
