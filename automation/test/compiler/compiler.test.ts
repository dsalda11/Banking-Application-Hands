import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscoveryTraceEventType, DiscoveryGoalType } from '../../src/domain/discovery.js';
import type { LoadedDiscoveryGoal } from '../../src/discovery/goal-loader.js';
import { contentHash } from '../../src/compiler/canonical-json.js';
import { DiscoveryTraceLoader } from '../../src/compiler/trace-loader.js';
import { ArtifactCompiler } from '../../src/compiler/artifact-compiler.js';
import {
  promoteArtifact,
  reviewArtifact,
  storeDraft,
} from '../../src/compiler/artifact-lifecycle.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

const goal: DiscoveryGoalType = {
  schemaVersion: '1.0.0',
  id: 'compiler-fixture',
  version: '1.0.0',
  objective: 'Authenticate, find a customer, and return the account number.',
  startUrl: 'http://127.0.0.1:8080/start',
  inputs: {
    customerUsername: {
      description: 'Customer username',
      shape: { kind: 'string', minLength: 1, maxLength: 128 },
    },
  },
  secretReferences: ['STAFF_USER', 'STAFF_PASSWORD'],
  outputs: {
    accountNumber: {
      description: 'Account number',
      shape: { kind: 'string', minLength: 1, maxLength: 64 },
    },
  },
  successCriteria: [
    {
      kind: 'outputMatchesShape',
      description: 'Account number is typed',
      output: 'accountNumber',
    },
  ],
  businessOutcomes: [
    {
      code: 'CUSTOMER_NOT_FOUND',
      result: 'businessOutcome',
      description: 'Customer is absent',
      detection: {
        kind: 'textPresent',
        description: 'Not found is visible',
        text: 'Not found',
      } as DiscoveryGoalType['businessOutcomes'][number]['detection'],
    },
  ],
  applicationScope: {
    allowedOrigins: ['http://127.0.0.1:8080'],
    allowedRoutePatterns: ['^/(start|home|details)$'],
  },
  budgets: {
    maxModelCalls: 20,
    maxActions: 20,
    timeoutMs: 30_000,
    maxRepeatedStates: 4,
    maxConsecutiveFailures: 3,
    maxNavigations: 4,
  },
  allowHumanIntervention: false,
  screenshotPolicy: 'disabled',
  policyRef: 'fixture-policy',
};
const loadedGoal: LoadedDiscoveryGoal = {
  goal,
  contentHash: contentHash(goal),
  path: '/fixture/goal.json',
};

const budgets = { modelCalls: 10, actions: 10, timeMs: 20_000 };
function observation(id: string, url: string) {
  const definitions = [
    ['user', 'Staff user'],
    ['password', 'Staff password'],
    ['login', 'Login'],
    ['customer', 'Customer username'],
    ['find', 'Find'],
    ['account', 'Account number'],
  ] as const;
  return {
    observationId: id,
    capturedAt: '2026-09-30T00:00:00.000Z',
    url,
    title: url.endsWith('/start') ? 'Login' : 'Customers',
    headings: ['Fixture'],
    visibleText: ['Fixture'],
    elements: definitions.map(([reference, name]) => ({
      reference,
      role: 'textbox',
      name,
      framePath: [],
      frameId: 'main',
      visible: true,
      enabled: true,
      editable: true,
      locatorCandidates: target(name).candidates,
    })),
    frames: [{ id: 'main', url }],
    scroll: { x: 0, y: 0 },
    stateFingerprint: contentHash({ id, url }),
    evidence: [],
  };
}
const target = (description: string) => ({
  description,
  candidates: [
    {
      strategy: 'role' as const,
      role: 'textbox',
      name: { kind: 'literal' as const, value: description },
      exact: true,
    },
    {
      strategy: 'css' as const,
      selector: `[data-stable="${description.toLowerCase().replaceAll(' ', '-')}"]`,
    },
  ],
  match: 'exactlyOne' as const,
});

function makeTrace(runId = 'run-success', terminal: 'success' | 'outcome' = 'success') {
  const events: DiscoveryTraceEventType[] = [];
  const add = (
    eventType: DiscoveryTraceEventType['eventType'],
    data: Record<string, unknown>,
    proposalId?: string,
  ) => {
    events.push({
      schemaVersion: '1.0.0',
      eventId: `event-${events.length + 1}`,
      runId,
      goalId: goal.id,
      goalVersion: goal.version,
      policyId: 'fixture-policy',
      policyVersion: '1.0.0',
      policyHash: 'a'.repeat(64),
      sequence: events.length + 1,
      timestamp: '2026-09-30T00:00:00.000Z',
      step: events.length,
      eventType,
      ...(proposalId ? { proposalId } : {}),
      budgetsRemaining: budgets,
      data,
    });
  };
  const action = (proposalId: string | undefined, value: unknown, resolved = false) => {
    add('action_executed', { actionJson: JSON.stringify(value) }, proposalId);
    add(
      'action_result',
      {
        ok: true,
        action: (value as { kind: string }).kind,
        errorCode: null,
        locatorStrategy: resolved ? 'role' : null,
        locatorCandidateIndex: resolved ? 0 : null,
        resolvedFramePath: null,
      },
      proposalId,
    );
  };
  const proposalAction = (id: string, proposal: Record<string, unknown>, value: unknown) => {
    add('planner_proposal', { proposalJson: JSON.stringify(proposal) }, id);
    add('proposal_validated', { valid: true, kind: proposal.kind }, id);
    add(
      'policy_decision',
      { decision: 'allow', risk: proposal.kind === 'enterSecret' ? 'input' : 'read' },
      id,
    );
    action(id, value, 'target' in (value as object));
  };
  add('run_started', { goalHash: loadedGoal.contentHash, providerBoundary: 'one-action' });
  add('policy_decision', { decision: 'allow', risk: 'navigation', actionType: 'navigate' });
  action(undefined, { kind: 'navigate', destination: { kind: 'absoluteUrl', url: goal.startUrl } });
  add('observation', { observationJson: JSON.stringify(observation('obs-login', goal.startUrl)) });
  const base = (id: string, kind: string) => ({
    kind,
    proposalId: id,
    observationId: 'obs-login',
    stateFingerprint: observation('obs-login', goal.startUrl).stateFingerprint,
    rationale: 'Fixture action',
    expectedPostcondition: 'Fixture advances',
  });
  proposalAction(
    'p-user',
    { ...base('p-user', 'enterSecret'), elementReference: 'user', secretName: 'STAFF_USER' },
    {
      kind: 'enterText',
      target: target('Staff user'),
      value: { kind: 'secret', name: 'STAFF_USER' },
      clear: true,
    },
  );
  add('observation', {
    observationJson: JSON.stringify(observation('obs-password', goal.startUrl)),
  });
  proposalAction(
    'p-password',
    {
      ...base('p-password', 'enterSecret'),
      observationId: 'obs-password',
      elementReference: 'password',
      secretName: 'STAFF_PASSWORD',
    },
    {
      kind: 'enterText',
      target: target('Staff password'),
      value: { kind: 'secret', name: 'STAFF_PASSWORD' },
      clear: true,
    },
  );
  add('observation', { observationJson: JSON.stringify(observation('obs-submit', goal.startUrl)) });
  proposalAction(
    'p-login',
    { ...base('p-login', 'click'), observationId: 'obs-submit', elementReference: 'login' },
    { kind: 'activate', target: target('Login') },
  );
  add('observation', {
    observationJson: JSON.stringify(observation('obs-home', 'http://127.0.0.1:8080/home')),
  });
  proposalAction(
    'p-input',
    {
      ...base('p-input', 'enterInput'),
      observationId: 'obs-home',
      elementReference: 'customer',
      inputName: 'customerUsername',
    },
    {
      kind: 'enterText',
      target: target('Customer username'),
      value: { kind: 'input', name: 'customerUsername' },
      clear: true,
    },
  );
  add('observation', {
    observationJson: JSON.stringify(observation('obs-find', 'http://127.0.0.1:8080/home')),
  });
  proposalAction(
    'p-find',
    { ...base('p-find', 'click'), observationId: 'obs-find', elementReference: 'find' },
    { kind: 'activate', target: target('Find') },
  );
  add('observation', {
    observationJson: JSON.stringify(observation('obs-details', 'http://127.0.0.1:8080/details')),
  });
  if (terminal === 'success') {
    proposalAction(
      'p-extract',
      {
        ...base('p-extract', 'extract'),
        observationId: 'obs-details',
        elementReference: 'account',
        outputName: 'accountNumber',
        transform: 'trim',
      },
      {
        kind: 'extract',
        output: 'accountNumber',
        target: target('Account number'),
        transform: { kind: 'trim' },
      },
    );
    add('output_candidate', { outputName: 'accountNumber', valid: true }, 'p-extract');
    add('observation', {
      observationJson: JSON.stringify(observation('obs-finish', 'http://127.0.0.1:8080/details')),
    });
    const finish = { ...base('p-finish', 'finish'), observationId: 'obs-finish' };
    add('planner_proposal', { proposalJson: JSON.stringify(finish) }, 'p-finish');
    add('proposal_validated', { valid: true, kind: 'finish' }, 'p-finish');
    add('policy_decision', { decision: 'allow' }, 'p-finish');
    add(
      'checkpoint_candidate',
      {
        checkpointJson: JSON.stringify(goal.successCriteria[0]),
        passed: true,
        kind: 'outputMatchesShape',
        final: true,
      },
      'p-finish',
    );
    add(
      'run_completed',
      { status: 'success', outputNames: ['accountNumber'], traceHash: contentHash(events) },
      'p-finish',
    );
  } else {
    add(
      'business_outcome',
      {
        code: 'CUSTOMER_NOT_FOUND',
        checkpointJson: JSON.stringify(goal.businessOutcomes[0]!.detection),
      },
      'p-outcome',
    );
    add(
      'run_completed',
      { status: 'businessOutcome', code: 'CUSTOMER_NOT_FOUND', traceHash: contentHash(events) },
      'p-outcome',
    );
  }
  return events;
}

async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'compiler-test-'));
  cleanups.push(directory);
  return directory;
}
async function writeTrace(
  directory: string,
  name: string,
  events: readonly unknown[],
  newline = true,
) {
  const file = path.join(directory, name);
  await writeFile(
    file,
    events.map((event) => JSON.stringify(event)).join('\n') + (newline ? '\n' : ''),
  );
  return file;
}

describe('DiscoveryTraceLoader and deterministic ArtifactCompiler', () => {
  it('accepts complete successful and declared business-outcome traces', async () => {
    const directory = await temp();
    const success = await writeTrace(directory, 'success.jsonl', makeTrace());
    const outcome = await writeTrace(
      directory,
      'outcome.jsonl',
      makeTrace('run-outcome', 'outcome'),
    );
    const traces = await new DiscoveryTraceLoader().loadSet([success, outcome]);
    expect(traces.map((trace) => trace.terminal.kind)).toEqual(['success', 'businessOutcome']);
  });

  it.each([
    ['malformed JSONL', async () => ({ text: '{bad}\n' }), 'TRACE_MALFORMED_JSONL'],
    [
      'truncated trace',
      async (events: DiscoveryTraceEventType[]) => ({ events, newline: false }),
      'TRACE_TRUNCATED',
    ],
    [
      'sequence gap',
      async (events: DiscoveryTraceEventType[]) => {
        events[2]!.sequence = 99;
        return { events };
      },
      'TRACE_SEQUENCE_INVALID',
    ],
    [
      'duplicate event',
      async (events: DiscoveryTraceEventType[]) => {
        events[2]!.eventId = events[1]!.eventId;
        return { events };
      },
      'TRACE_SEQUENCE_INVALID',
    ],
    [
      'mixed run identity',
      async (events: DiscoveryTraceEventType[]) => {
        events[2]!.runId = 'other-run';
        return { events };
      },
      'TRACE_IDENTITY_MISMATCH',
    ],
    [
      'unsupported version',
      async (events: DiscoveryTraceEventType[]) => {
        (events[0] as { schemaVersion: string }).schemaVersion = '9.0.0';
        return { events };
      },
      'UNSUPPORTED_TRACE_VERSION',
    ],
    [
      'tampered content',
      async (events: DiscoveryTraceEventType[]) => {
        events[1]!.data.extra = true;
        return { events };
      },
      'TRACE_HASH_MISMATCH',
    ],
  ])('rejects %s', async (_name, mutate, code) => {
    const directory = await temp();
    const events = structuredClone(makeTrace());
    const changed = await mutate(events);
    const file = path.join(directory, 'trace.jsonl');
    if ('text' in changed) await writeFile(file, changed.text!);
    else
      await writeFile(
        file,
        changed.events!.map((event) => JSON.stringify(event)).join('\n') +
          ('newline' in changed && changed.newline === false ? '' : '\n'),
      );
    await expect(new DiscoveryTraceLoader().load(file)).rejects.toMatchObject({ code });
  });

  it('rejects stopped, incomplete-success, secret-material, and invalid-locator traces', async () => {
    const directory = await temp();
    for (const [name, mutate, code] of [
      [
        'stopped',
        (events: DiscoveryTraceEventType[]) => {
          events.pop();
          const last = events.at(-1)!;
          events.push({
            ...last,
            eventId: `event-${events.length + 1}`,
            sequence: events.length + 1,
            eventType: 'stopping_condition',
            proposalId: undefined,
            data: { code: 'POLICY_DENIED', reason: 'denied', traceHash: contentHash(events) },
          });
        },
        'TRACE_POLICY_DENIED',
      ],
      [
        'incomplete',
        (events: DiscoveryTraceEventType[]) => {
          const output = events.find((event) => event.eventType === 'output_candidate')!;
          output.data.valid = false;
          events.at(-1)!.data.traceHash = contentHash(events.slice(0, -1));
        },
        'TRACE_OUTPUTS_MISSING',
      ],
      [
        'secret',
        (events: DiscoveryTraceEventType[]) => {
          events[1]!.data.cookies = 'secret';
          events.at(-1)!.data.traceHash = contentHash(events.slice(0, -1));
        },
        'TRACE_SECRET_MATERIAL',
      ],
      [
        'locator',
        (events: DiscoveryTraceEventType[]) => {
          const result = events.find(
            (event) =>
              event.eventType === 'action_result' && event.data.locatorCandidateIndex === 0,
          )!;
          result.data.locatorStrategy = 'css';
          events.at(-1)!.data.traceHash = contentHash(events.slice(0, -1));
        },
        'TRACE_LOCATOR_PROVENANCE_INVALID',
      ],
    ] as const) {
      const events = structuredClone(makeTrace());
      mutate(events);
      const file = await writeTrace(directory, `${name}.jsonl`, events);
      await expect(new DiscoveryTraceLoader().load(file)).rejects.toMatchObject({ code });
    }
  });

  it('rejects incompatible trace merges', async () => {
    const directory = await temp();
    const one = await writeTrace(directory, 'one.jsonl', makeTrace());
    const incompatible = makeTrace('run-other');
    incompatible.forEach((event) => {
      event.policyHash = 'b'.repeat(64);
    });
    incompatible.at(-1)!.data.traceHash = contentHash(incompatible.slice(0, -1));
    const two = await writeTrace(directory, 'two.jsonl', incompatible);
    await expect(new DiscoveryTraceLoader().loadSet([one, two])).rejects.toMatchObject({
      code: 'TRACE_SET_INCOMPATIBLE',
    });
  });

  it('parameterizes inputs and secrets, strips temporary IDs, ranks locators, and is byte deterministic', async () => {
    const directory = await temp();
    const tracePath = await writeTrace(directory, 'trace.jsonl', makeTrace());
    const traces = await new DiscoveryTraceLoader().loadSet([tracePath]);
    const compile = () =>
      new ArtifactCompiler().compile(
        loadedGoal,
        traces,
        { id: 'compiled.fixture', version: '1.0.0' },
        { compilationTime: '2026-09-30T00:00:00.000Z' },
      );
    const first = compile();
    const second = compile();
    expect(first.artifactBytes).toBe(second.artifactBytes);
    expect(first.artifactHash).toBe(second.artifactHash);
    expect(first.artifactBytes).not.toContain('elementReference');
    expect(first.artifact.steps[1]!.action).toMatchObject({
      value: { kind: 'secret', name: 'STAFF_USER' },
    });
    expect(first.artifact.steps[4]!.action).toMatchObject({
      value: { kind: 'input', name: 'customerUsername' },
    });
    const targeted = first.artifact.steps.filter((step) => 'target' in step.action);
    expect(
      targeted.every(
        (step) =>
          (step.action as { target: { candidates: unknown[] } }).target.candidates.length === 1,
      ),
    ).toBe(true);
    expect(first.artifact.steps.map((step) => step.id)).toEqual(
      first.artifact.steps.map((step) => step.id).sort(),
    );
    expect(first.artifact.steps[0]!.recovery.kind).toBe('none');
    expect(first.artifact.success.kind).toBe('all');
  });

  it('records failed exploration as discarded instead of executable', async () => {
    const directory = await temp();
    const events = makeTrace();
    const terminal = events.pop()!;
    const sequence = events.length + 1;
    events.push({
      ...events[1]!,
      eventId: `event-${sequence}`,
      sequence,
      eventType: 'planner_proposal',
      proposalId: 'p-dead',
      data: {
        proposalJson: JSON.stringify({
          kind: 'scroll',
          proposalId: 'p-dead',
          observationId: 'obs-finish',
          stateFingerprint: observation('obs-finish', 'http://127.0.0.1:8080/details')
            .stateFingerprint,
          rationale: 'Explore',
          expectedPostcondition: 'Maybe progress',
          direction: 'down',
          amount: 100,
        }),
      },
    });
    events.push({
      ...events[1]!,
      eventId: `event-${sequence + 1}`,
      sequence: sequence + 1,
      eventType: 'action_result',
      proposalId: 'p-dead',
      data: { ok: false, action: 'scroll', errorCode: 'ACTION_TIMEOUT' },
    });
    events.push({
      ...terminal,
      eventId: `event-${sequence + 2}`,
      sequence: sequence + 2,
      data: { ...terminal.data, traceHash: contentHash(events) },
    });
    const file = await writeTrace(directory, 'dead.jsonl', events);
    const trace = await new DiscoveryTraceLoader().load(file);
    const result = new ArtifactCompiler().compile(loadedGoal, [trace], {
      id: 'compiled.dead-end',
      version: '1.0.0',
    });
    expect(result.artifact.steps.some((step) => step.action.kind === 'scroll')).toBe(false);
    expect(result.manifest.discardedEvents.some((event) => event.reason.includes('failed'))).toBe(
      true,
    );
  });

  it('binds review and promotion to exact hashes and rejects conflicts', async () => {
    const directory = await temp();
    const trace = await new DiscoveryTraceLoader().load(
      await writeTrace(directory, 'trace.jsonl', makeTrace()),
    );
    const compilation = new ArtifactCompiler().compile(
      loadedGoal,
      [trace],
      { id: 'compiled.lifecycle', version: '1.0.0' },
      { compilationTime: '2026-09-30T00:00:00.000Z' },
    );
    const stored = await storeDraft(path.join(directory, 'drafts'), compilation);
    const reviewPath = path.join(directory, 'review.json');
    const review = await reviewArtifact({
      artifactPath: stored.artifactPath,
      compilationManifestPath: stored.manifestPath,
      reviewPath,
      decision: 'approved',
      reviewer: 'test-reviewer',
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(review.artifactHash).toBe(compilation.artifactHash);
    const verificationPath = path.join(directory, 'verification.json');
    const verification = {
      schemaVersion: '1.0.0',
      artifactId: compilation.artifact.id,
      artifactVersion: compilation.artifact.version,
      artifactHash: compilation.artifactHash,
      policyId: 'fixture-policy',
      policyVersion: '1.0.0',
      policyHash: 'a'.repeat(64),
      reviewHash: contentHash(review),
      verifiedAt: '2026-09-30T00:00:00.000Z',
      freshSessions: 2,
      cases: [
        {
          name: 'success',
          expected: 'success',
          actual: 'success',
          runId: 'replay-one',
          passed: true,
        },
        {
          name: 'not-found',
          expected: 'CUSTOMER_NOT_FOUND',
          actual: 'CUSTOMER_NOT_FOUND',
          runId: 'replay-two',
          passed: true,
        },
      ],
      result: 'promotionEligible',
    };
    await writeFile(verificationPath, JSON.stringify(verification));
    const registry = path.join(directory, 'registry');
    await expect(
      promoteArtifact({
        artifactPath: stored.artifactPath,
        reviewPath,
        verificationPath,
        registryDirectory: registry,
      }),
    ).resolves.toContain('compiled.lifecycle');
    await expect(
      promoteArtifact({
        artifactPath: stored.artifactPath,
        reviewPath,
        verificationPath,
        registryDirectory: registry,
      }),
    ).rejects.toMatchObject({ code: 'PROMOTION_CONFLICT' });
    const changed = JSON.parse(await readFile(stored.artifactPath, 'utf8')) as Record<
      string,
      unknown
    >;
    changed.description = 'Changed after review';
    await writeFile(stored.artifactPath, JSON.stringify(changed));
    await expect(
      promoteArtifact({
        artifactPath: stored.artifactPath,
        reviewPath,
        verificationPath,
        registryDirectory: path.join(directory, 'other'),
      }),
    ).rejects.toMatchObject({ code: 'PROMOTION_NOT_ELIGIBLE' });
  });
});
