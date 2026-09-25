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
});
