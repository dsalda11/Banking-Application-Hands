#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import { loadEnvironment } from '../config/env.js';
import { runBankingSurfaceSmoke } from '../smoke/banking-surface-smoke.js';
import { loadArtifact } from '../replay/artifact-loader.js';
import { ArtifactRegistry } from '../replay/artifact-registry.js';
import { ReplayEngine } from '../replay/replay-engine.js';
import { PlaywrightWebAdapter } from '../surfaces/web/playwright-web-adapter.js';
import { createLogger } from '../logging/logger.js';

async function directoryWritable(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function runDoctor(): Promise<void> {
  try {
    const environment = loadEnvironment();
    const directories = {
      artifacts: await directoryWritable(environment.paths.artifactsDirectory),
      policies: await directoryWritable(environment.paths.policiesDirectory),
      evidence: await directoryWritable(environment.paths.evidenceDirectory),
    };
    const node24InUse = process.versions.node.startsWith('24.');
    const report = {
      node: process.versions.node,
      node24InUse,
      directories,
      bankAppBaseUrl: environment.bankAppBaseUrl,
      openAiConfigured: Boolean(environment.openAiApiKey),
      bankCredentialsConfigured: Boolean(
        environment.bankStaffUsername && environment.bankStaffPassword,
      ),
      browserHeadless: environment.browserHeadless,
      operator: `${environment.operatorHost}:${environment.operatorPort}`,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!Object.values(directories).every(Boolean)) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Doctor failed');
    process.exitCode = 1;
  }
}

const program = new Command();
program.name('llm-hands-automation').description('Host-side automation engine scaffold');
program.command('doctor').description('Check local scaffold configuration').action(runDoctor);
async function runSurfaceSmokeCommand(options: { customerUsername?: string }): Promise<void> {
  const environment = loadEnvironment({ requireBankCredentials: true });
  const customerUsername = options.customerUsername ?? environment.bankCustomerUsername;
  if (!customerUsername)
    throw new Error('BANK_CUSTOMER_USERNAME or --customer-username is required');
  const result = await runBankingSurfaceSmoke(customerUsername, environment);
  console.log(JSON.stringify(result));
  if (result.status === 'failure') process.exitCode = 1;
}

function collectInput(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInputs(values: readonly string[], inputFile?: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (inputFile) {
    const raw = JSON.parse(readFileSync(inputFile, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Error('Input file must contain a JSON object');
    Object.assign(inputs, raw);
  }
  for (const entry of values) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error(`Input must use name=value syntax: ${entry.split('=')[0]}`);
    const name = entry.slice(0, separator);
    const rawValue = entry.slice(separator + 1);
    try {
      inputs[name] = JSON.parse(rawValue) as unknown;
    } catch {
      inputs[name] = rawValue;
    }
  }
  return inputs;
}

async function runArtifactReplay(options: {
  artifact: string;
  input: string[];
  inputFile?: string;
}): Promise<void> {
  const environment = loadEnvironment();
  const loaded = await loadArtifact(path.resolve(options.artifact));
  const secrets: Record<string, string> = {};
  for (const name of loaded.artifact.contract.requiredSecrets) {
    const value = process.env[name];
    if (value !== undefined) secrets[name] = value;
  }
  const result = await new ReplayEngine().run({
    loadedArtifact: loaded,
    inputs: parseInputs(options.input, options.inputFile),
    secrets,
    baseUrl: environment.bankAppBaseUrl,
    evidenceDirectory: environment.paths.evidenceDirectory,
    headless: environment.browserHeadless,
    adapter: new PlaywrightWebAdapter(),
    logger: createLogger({ level: environment.logLevel }),
  });
  console.log(JSON.stringify({ ...result, artifactHash: loaded.contentHash }));
  if (result.status === 'failure') process.exitCode = 1;
  if (result.status === 'businessOutcome') process.exitCode = 2;
}

program
  .command('surface-smoke')
  .description('Run the explicit non-LLM banking surface smoke flow')
  .option('--customer-username <username>', 'Customer username to locate')
  .action(runSurfaceSmokeCommand);

program
  .command('artifact:list')
  .description('List validated artifacts in the filesystem registry')
  .action(async () => {
    const environment = loadEnvironment();
    const registry = new ArtifactRegistry(environment.paths.artifactsDirectory);
    await registry.discover();
    console.log(
      JSON.stringify(
        registry.list().map((artifact) => ({ id: artifact.id, version: artifact.version })),
      ),
    );
  });
program
  .command('artifact:validate')
  .description('Validate one capability artifact without starting a browser')
  .requiredOption('--artifact <path>', 'Path to the capability artifact JSON')
  .action(async (options: { artifact: string }) => {
    const loaded = await loadArtifact(path.resolve(options.artifact));
    console.log(
      JSON.stringify({
        id: loaded.artifact.id,
        version: loaded.artifact.version,
        hash: loaded.contentHash,
      }),
    );
  });
program
  .command('replay')
  .description('Run a validated capability artifact deterministically')
  .requiredOption('--artifact <path>', 'Path to the capability artifact JSON')
  .option('--input <name=value>', 'Declared non-secret input', collectInput, [])
  .option('--input-file <path>', 'JSON object containing declared non-secret inputs')
  .action(runArtifactReplay);
program
  .command('proof-bank')
  .description('Run the explicit non-LLM banking proof flow')
  .option('--customer-username <username>', 'Customer username to locate')
  .action(runSurfaceSmokeCommand);
await program.parseAsync(process.argv);
