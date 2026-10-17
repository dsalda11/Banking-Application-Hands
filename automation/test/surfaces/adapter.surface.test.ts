import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightWebAdapter } from '../../src/surfaces/web/playwright-web-adapter.js';
import type { ExecutionContext } from '../../src/execution/execution-context.js';
import { SurfaceError } from '../../src/surfaces/surface-errors.js';
import { Checkpoint } from '../../src/domain/checkpoints.js';
import { TargetDescriptor } from '../../src/domain/locators.js';

const context: ExecutionContext = {
  inputs: { customerUsername: 'customer' },
  secrets: { STAFF: 'unused' },
  outputs: {},
  baseUrl: 'http://127.0.0.1:4173',
  runId: 'fixture-run',
};
let adapter: PlaywrightWebAdapter;
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'llm-hands-surface-'));
  adapter = new PlaywrightWebAdapter();
  await adapter.start({
    baseUrl: context.baseUrl,
    runId: context.runId,
    evidenceDirectory: scratch,
    headless: true,
    viewport: { width: 1000, height: 700 },
  });
});
afterAll(async () => {
  await adapter.close();
  await rm(scratch, { recursive: true, force: true });
});

describe('Playwright surface fixture', () => {
  it('resolves role, label, text, attribute, css, xpath and dynamic input locators', async () => {
    await adapter.session.page!.setContent(
      '<label for="q">Customer</label><input id="q" name="customer"/><button>Search</button><a href="#">View Details</a><div data-user="customer">customer</div>',
    );
    for (const target of [
      {
        description: 'role',
        candidates: [
          { strategy: 'role', role: 'button', name: { kind: 'literal', value: 'Search' } },
        ],
        match: 'exactlyOne',
      },
      {
        description: 'label',
        candidates: [{ strategy: 'label', text: { kind: 'literal', value: 'Customer' } }],
        match: 'exactlyOne',
      },
      {
        description: 'text',
        candidates: [{ strategy: 'text', text: { kind: 'literal', value: 'View Details' } }],
        match: 'exactlyOne',
      },
      {
        description: 'attribute',
        candidates: [
          {
            strategy: 'attribute',
            name: 'data-user',
            value: { kind: 'input', name: 'customerUsername' },
          },
        ],
        match: 'exactlyOne',
      },
      {
        description: 'css',
        candidates: [{ strategy: 'css', selector: 'button' }],
        match: 'exactlyOne',
      },
      {
        description: 'xpath',
        candidates: [{ strategy: 'xpath', expression: '//button' }],
        match: 'exactlyOne',
      },
    ] as const) {
      const result = await adapter.execute(
        { kind: 'activate', target: TargetDescriptor.parse(target) },
        context,
      );
      expect(result.ok).toBe(true);
    }
  });
  it('supports scoped first-visible matching and observation without password values', async () => {
    await adapter.session.page!.setContent(
      '<input type="password" name="password"><table><tr><td>customer</td><td><a href="#details">View Details</a></td></tr></table>',
    );
    await adapter.session.page!.locator('input[type=password]').fill('secret');
    const observation = await adapter.observe();
    expect(JSON.stringify(observation)).not.toContain('secret');
    const result = await adapter.execute(
      {
        kind: 'activate',
        target: {
          description: 'customer action',
          scope: [{ strategy: 'text', text: { kind: 'input', name: 'customerUsername' } }],
          candidates: [
            { strategy: 'role', role: 'link', name: { kind: 'literal', value: 'View Details' } },
          ],
          match: 'firstVisible',
        },
      },
      context,
    );
    expect(result.ok).toBe(true);
  });
  it('observes input submit and reset controls as distinct named buttons', async () => {
    await adapter.session.page!.setContent(
      '<form><input type="submit" value="Submit"><input type="reset" value="Clear"></form>',
    );
    const observation = await adapter.observe();
    const submit = observation.elements.find((element) => element.name === 'Submit');
    const reset = observation.elements.find((element) => element.name === 'Clear');
    expect(submit).toMatchObject({ role: 'button', inputType: 'submit', editable: false });
    expect(reset).toMatchObject({ role: 'button', inputType: 'reset', editable: false });
    expect(submit?.locatorCandidates[0]).toMatchObject({
      strategy: 'role',
      role: 'button',
      name: { kind: 'literal', value: 'Submit' },
    });
  });
  it('extracts changed table values by semantic header without recompiling the target', async () => {
    await adapter.session.page!.setContent(
      '<table><tr><td>Name</td><td>Email</td><td>Account No.</td><td>Balance</td></tr><tr><td>other</td><td>other</td><td>9001</td><td>77777</td></tr></table>',
    );
    const accountTarget = TargetDescriptor.parse({
      description: 'account number by column meaning',
      candidates: [
        {
          strategy: 'tableCell',
          header: { kind: 'literal', value: 'Account No.' },
          columnIndex: 3,
        },
      ],
      match: 'exactlyOne',
    });
    const balanceTarget = TargetDescriptor.parse({
      description: 'balance by column meaning',
      candidates: [
        {
          strategy: 'tableCell',
          header: { kind: 'literal', value: 'Balance' },
          columnIndex: 4,
        },
      ],
      match: 'exactlyOne',
    });

    expect(
      (
        await adapter.execute(
          {
            kind: 'extract',
            output: 'accountNumber',
            target: accountTarget,
            transform: { kind: 'trim' },
          },
          context,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await adapter.execute(
          {
            kind: 'extract',
            output: 'currentBalance',
            target: balanceTarget,
            transform: { kind: 'trim' },
          },
          context,
        )
      ).ok,
    ).toBe(true);
    expect(context.outputs).toMatchObject({ accountNumber: '9001', currentBalance: '77777' });
  });
  it('evaluates checkpoints and rejects external navigation', async () => {
    await adapter.session.page!.setContent('<h1>Bank</h1><input aria-label="Name">');
    expect(
      (
        await adapter.evaluateCheckpoint(
          Checkpoint.parse({ kind: 'textPresent', description: 'bank text', text: 'Bank' }),
          context,
        )
      ).passed,
    ).toBe(true);
    expect(
      (
        await adapter.evaluateCheckpoint(
          Checkpoint.parse({
            kind: 'elementVisible',
            description: 'name',
            target: {
              description: 'name',
              candidates: [{ strategy: 'accessibility', name: { kind: 'literal', value: 'Name' } }],
              match: 'exactlyOne',
            },
          }),
          context,
        )
      ).passed,
    ).toBe(true);
    const result = await adapter.execute(
      { kind: 'navigate', destination: { kind: 'absoluteUrl', url: 'https://example.com/' } },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(SurfaceError);
  });
  it('returns explicit missing and ambiguous locator errors without clicking', async () => {
    await adapter.session.page!.setContent(
      '<button onclick="document.body.dataset.clicked=\'yes\'">One</button><button onclick="document.body.dataset.clicked=\'yes\'">Two</button>',
    );
    const missing = await adapter.execute(
      {
        kind: 'activate',
        target: {
          description: 'missing control',
          candidates: [
            { strategy: 'role', role: 'button', name: { kind: 'literal', value: 'Missing' } },
          ],
          match: 'exactlyOne',
        },
      },
      context,
    );
    expect(missing.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(missing.error?.message).toContain('role:0');
    const ambiguous = await adapter.execute(
      {
        kind: 'activate',
        target: {
          description: 'ambiguous control',
          candidates: [{ strategy: 'role', role: 'button' }],
          match: 'exactlyOne',
        },
      },
      context,
    );
    expect(ambiguous.error?.code).toBe('LOCATOR_AMBIGUOUS');
    expect(ambiguous.error?.message).toContain('role:2');
    expect(await adapter.session.page!.locator('body').getAttribute('data-clicked')).toBeNull();
  });
  it('uses a later independent locator only when the preferred locator has no match', async () => {
    await adapter.session.page!.setContent('<button aria-label="Stable action">Run</button>');
    const result = await adapter.execute(
      {
        kind: 'activate',
        target: {
          description: 'fallback control',
          candidates: [
            {
              strategy: 'role',
              role: 'button',
              name: { kind: 'literal', value: 'Missing preferred name' },
            },
            {
              strategy: 'accessibility',
              role: 'button',
              name: { kind: 'literal', value: 'Stable action' },
            },
          ],
          match: 'exactlyOne',
        },
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.target).toMatchObject({ strategy: 'accessibility', candidateIndex: 1 });
  });
  it('bounds waits by the declared action timeout', async () => {
    await adapter.session.page!.setContent('<main>Never ready</main>');
    const started = Date.now();
    const result = await adapter.execute(
      {
        kind: 'wait',
        condition: Checkpoint.parse({
          kind: 'textPresent',
          description: 'eventually ready',
          text: 'Ready now',
        }),
      },
      { ...context, actionTimeoutMs: 75 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'CHECKPOINT_FAILED', retryable: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
