#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

import { loadEnvironment } from '../config/env.js';
import { runBankingSurfaceSmoke } from '../smoke/banking-surface-smoke.js';
import { loadArtifact } from '../replay/artifact-loader.js';
import { ArtifactRegistry } from '../replay/artifact-registry.js';
import { ReplayEngine } from '../replay/replay-engine.js';
import { PlaywrightWebAdapter } from '../surfaces/web/playwright-web-adapter.js';
import { createLogger } from '../logging/logger.js';
import { loadPolicy } from '../policy/policy-loader.js';
import { OperatorInterventionCoordinator } from '../intervention/intervention-coordinator.js';
import {
  InteractiveReplayLifecycle,
  processSignalSource,
} from '../intervention/interactive-replay-lifecycle.js';
import { loadDiscoveryGoal } from '../discovery/goal-loader.js';
import { DiscoveryOrchestrator } from '../discovery/discovery-orchestrator.js';
import { OpenAIResponsesPlanner } from '../discovery/openai-planner.js';
import { createBankingScriptedPlanner } from '../discovery/banking-scripted-planner.js';
import { DiscoveryTraceLoader } from '../compiler/trace-loader.js';
import { ArtifactCompiler } from '../compiler/artifact-compiler.js';
import {
  promoteArtifact,
  reviewArtifact,
  storeDraft,
  verifyArtifact,
} from '../compiler/artifact-lifecycle.js';

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

program
  .command('trace:validate')
  .description('Validate an integrity-bound discovery JSONL trace')
  .requiredOption('--trace <path>', 'Discovery trace path')
  .action(async (options: { trace: string }) => {
    const trace = await new DiscoveryTraceLoader().load(path.resolve(options.trace));
    console.log(
      JSON.stringify({ runId: trace.runId, hash: trace.traceHash, terminal: trace.terminal }),
    );
  });

program
  .command('artifact:compile')
  .description('Compile compatible discovery traces into an immutable draft')
  .requiredOption('--goal <path>', 'Discovery goal path')
  .requiredOption('--trace <path>', 'Discovery trace path', collectInput, [])
  .requiredOption('--artifact-id <id>', 'Target artifact ID')
  .requiredOption('--version <version>', 'Target artifact version')
  .option('--drafts-directory <path>', 'Draft output directory')
  .action(
    async (options: {
      goal: string;
      trace: string[];
      artifactId: string;
      version: string;
      draftsDirectory?: string;
    }) => {
      const environment = loadEnvironment();
      const goal = await loadDiscoveryGoal(path.resolve(options.goal));
      const traces = await new DiscoveryTraceLoader().loadSet(
        options.trace.map((item) => path.resolve(item)),
      );
      const compilation = new ArtifactCompiler().compile(goal, traces, {
        id: options.artifactId,
        version: options.version,
      });
      const stored = await storeDraft(
        path.resolve(
          options.draftsDirectory ?? path.join(environment.paths.artifactsDirectory, 'drafts'),
        ),
        compilation,
      );
      console.log(
        JSON.stringify({
          ...stored,
          artifactHash: compilation.artifactHash,
          diagnostics: compilation.diagnostics,
        }),
      );
    },
  );

program
  .command('artifact:review')
  .description('Explicitly approve or reject the exact bytes of a compiled draft')
  .requiredOption('--artifact <path>', 'Draft artifact path')
  .option('--manifest <path>', 'Compilation manifest path')
  .option('--review <path>', 'Review record path')
  .option('--reviewer <name>', 'Reviewer identity', 'local-human-reviewer')
  .option('--approve', 'Approve this exact artifact hash')
  .option('--reject', 'Reject this exact artifact hash')
  .action(
    async (options: {
      artifact: string;
      manifest?: string;
      review?: string;
      reviewer: string;
      approve?: boolean;
      reject?: boolean;
    }) => {
      if (Boolean(options.approve) === Boolean(options.reject))
        throw new Error('Specify exactly one of --approve or --reject');
      const artifactPath = path.resolve(options.artifact);
      const reviewPath = path.resolve(options.review ?? `${artifactPath}.review.json`);
      const record = await reviewArtifact({
        artifactPath,
        ...(options.manifest ? { compilationManifestPath: path.resolve(options.manifest) } : {}),
        reviewPath,
        decision: options.approve ? 'approved' : 'rejected',
        reviewer: options.reviewer,
      });
      console.log(JSON.stringify({ reviewPath, record }));
    },
  );

function collectOutcomeInput(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command('artifact:verify')
  .description('Verify a reviewed draft in fresh model-free browser sessions')
  .requiredOption('--artifact <path>', 'Draft artifact path')
  .requiredOption('--review <path>', 'Review record path')
  .requiredOption('--policy <path>', 'Replay policy path')
  .option('--verification <path>', 'Verification manifest path')
  .option('--input <name=value>', 'Successful-case input', collectInput, [])
  .option('--input-file <path>', 'Successful-case JSON inputs')
  .option(
    '--outcome-input <code:name=value>',
    'Declared outcome and its input',
    collectOutcomeInput,
    [],
  )
  .action(
    async (options: {
      artifact: string;
      review: string;
      policy: string;
      verification?: string;
      input: string[];
      inputFile?: string;
      outcomeInput: string[];
    }) => {
      const environment = loadEnvironment();
      const loaded = await loadArtifact(path.resolve(options.artifact));
      const secrets = Object.fromEntries(
        loaded.artifact.contract.requiredSecrets
          .map((name) => [name, process.env[name]] as const)
          .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
      );
      const cases = [
        {
          name: 'success',
          inputs: parseInputs(options.input, options.inputFile),
          expected: 'success',
        },
      ];
      for (const encoded of options.outcomeInput) {
        const separator = encoded.indexOf(':');
        if (separator <= 0) throw new Error('Outcome input must use code:name=value');
        const code = encoded.slice(0, separator);
        cases.push({
          name: code,
          inputs: parseInputs([encoded.slice(separator + 1)]),
          expected: code,
        });
      }
      const verificationPath = path.resolve(
        options.verification ?? `${options.artifact}.verification.json`,
      );
      const manifest = await verifyArtifact({
        artifactPath: path.resolve(options.artifact),
        reviewPath: path.resolve(options.review),
        verificationPath,
        loadedPolicy: await loadPolicy(path.resolve(options.policy)),
        secrets,
        cases,
        baseUrl: environment.bankAppBaseUrl,
        evidenceDirectory: environment.paths.evidenceDirectory,
        headless: environment.browserHeadless,
        adapterFactory: () => new PlaywrightWebAdapter(),
      });
      console.log(JSON.stringify({ verificationPath, manifest }));
    },
  );

program
  .command('artifact:promote')
  .description('Explicitly promote an eligible draft into an active registry')
  .requiredOption('--artifact <path>', 'Draft artifact path')
  .requiredOption('--review <path>', 'Review record path')
  .requiredOption('--verification <path>', 'Verification manifest path')
  .option('--registry <path>', 'Active registry directory')
  .action(
    async (options: {
      artifact: string;
      review: string;
      verification: string;
      registry?: string;
    }) => {
      const environment = loadEnvironment();
      const promotedPath = await promoteArtifact({
        artifactPath: path.resolve(options.artifact),
        reviewPath: path.resolve(options.review),
        verificationPath: path.resolve(options.verification),
        registryDirectory: path.resolve(options.registry ?? environment.paths.artifactsDirectory),
      });
      console.log(JSON.stringify({ promotedPath }));
    },
  );
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
  policy?: string;
  input: string[];
  inputFile?: string;
  credentialProfile?: 'staff' | 'nonStaff';
  interactive?: boolean;
}): Promise<void> {
  const credentialProfile = options.credentialProfile ?? 'staff';
  const environment = loadEnvironment({
    requireBankCredentials: credentialProfile === 'staff',
    requireNonStaffCredentials: credentialProfile === 'nonStaff',
  });
  const loaded = await loadArtifact(path.resolve(options.artifact));
  const loadedPolicy = await loadPolicy(
    path.resolve(
      options.policy ??
        path.join(environment.paths.policiesDirectory, 'local-bank-readonly.v1.json'),
    ),
  );
  const secrets: Record<string, string> = {};
  for (const name of loaded.artifact.contract.requiredSecrets) {
    const value =
      credentialProfile === 'nonStaff'
        ? name === 'BANK_STAFF_USERNAME'
          ? environment.bankNonStaffUsername
          : name === 'BANK_STAFF_PASSWORD'
            ? environment.bankNonStaffPassword
            : undefined
        : process.env[name];
    if (value !== undefined) secrets[name] = value;
  }
  if (options.interactive && environment.browserHeadless)
    throw new Error('Interactive replay requires BROWSER_HEADLESS=false');
  const replayOptions = {
    loadedArtifact: loaded,
    inputs: parseInputs(options.input, options.inputFile),
    secrets,
    baseUrl: environment.bankAppBaseUrl,
    evidenceDirectory: environment.paths.evidenceDirectory,
    headless: options.interactive ? false : environment.browserHeadless,
    adapter: new PlaywrightWebAdapter(),
    loadedPolicy,
    logger: createLogger({ level: environment.logLevel }),
  } as const;
  const result = options.interactive
    ? await new InteractiveReplayLifecycle({
        signalSource: processSignalSource,
        createCoordinator: (onOperatorUrl) => new OperatorInterventionCoordinator(onOperatorUrl),
        runReplay: (coordinator, cancellationSignal, interruptionSource) =>
          new ReplayEngine().run({
            ...replayOptions,
            executionMode: 'interactive',
            interventionCoordinator: coordinator,
            cancellationSignal,
            interruptionSource,
          }),
        outputOperatorUrl: (url) => {
          // Fragment tokens stay out of server logs and structured evidence.
          console.log(`Open the local operator console: ${url}`);
        },
        setExitCode: (code) => {
          process.exitCode = code;
        },
      }).run()
    : await new ReplayEngine().run({
        ...replayOptions,
        executionMode: 'nonInteractive',
      });
  console.log(JSON.stringify({ ...result, artifactHash: loaded.contentHash }));
  if (result.status === 'failure') process.exitCode = 1;
  if (result.status === 'businessOutcome') process.exitCode = 2;
  if (result.status === 'permissionDenied') process.exitCode = 3;
  if (result.status === 'needsHuman') process.exitCode = 4;
  if (result.status === 'aborted') process.exitCode = 5;
  if (result.status === 'interrupted') process.exitCode = result.signal === 'SIGINT' ? 130 : 143;
}

async function runPolicyDenialProof(options: { artifact: string; policy?: string }): Promise<void> {
  const raw = JSON.parse(readFileSync(path.resolve(options.artifact), 'utf8')) as {
    steps: Array<{ action: { kind: string; destination?: unknown } }>;
  };
  const firstNavigate = raw.steps.find((step) => step.action.kind === 'navigate');
  if (!firstNavigate) throw new Error('Policy-denial fixture requires a navigate action');
  firstNavigate.action.destination = {
    kind: 'absoluteUrl',
    url: 'http://127.0.0.1:65535/policy-denial-fixture',
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'policy-denial-artifact-'));
  const artifactPath = path.join(directory, 'policy-denial.json');
  try {
    await writeFile(artifactPath, JSON.stringify(raw), 'utf8');
    await runArtifactReplay({
      artifact: artifactPath,
      input: ['customerUsername=policy-denial-fixture'],
      ...(options.policy ? { policy: options.policy } : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runPermissionDeniedProof(options: {
  artifact: string;
  policy?: string;
  customerUsername: string;
}): Promise<void> {
  const raw = JSON.parse(readFileSync(path.resolve(options.artifact), 'utf8')) as {
    steps: Array<{
      id: string;
      action: Record<string, unknown>;
      checkpoint: Record<string, unknown>;
    }>;
  };
  const submitLogin = raw.steps.find((step) => step.id === 'submit-login');
  const openCustomers = raw.steps.find((step) => step.id === 'open-customers');
  if (!submitLogin || !openCustomers)
    throw new Error('Permission-denied fixture requires login and staff-navigation steps');
  submitLogin.checkpoint = {
    kind: 'textPresent',
    description: 'Non-staff authentication reaches the customer console.',
    text: 'Transfer Money',
  };
  openCustomers.action = {
    kind: 'navigate',
    destination: { kind: 'relativeRoute', route: '/showcust' },
  };
  openCustomers.checkpoint = {
    kind: 'textPresent',
    description: 'The protected staff route reports access denial.',
    text: 'Error Occured!! GO back and try again.',
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'permission-denial-artifact-'));
  const artifactPath = path.join(directory, 'permission-denial.json');
  try {
    await writeFile(artifactPath, JSON.stringify(raw), 'utf8');
    await runArtifactReplay({
      artifact: artifactPath,
      input: [`customerUsername=${options.customerUsername}`],
      credentialProfile: 'nonStaff',
      ...(options.policy ? { policy: options.policy } : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runDiscovery(options: {
  goal: string;
  policy: string;
  input: string[];
  inputFile?: string;
  planner: 'openai' | 'fake';
}): Promise<void> {
  const environment = loadEnvironment({
    requireOpenAI: options.planner === 'openai',
    requireBankCredentials: true,
  });
  const loaded = await loadDiscoveryGoal(path.resolve(options.goal));
  const loadedPolicy = await loadPolicy(path.resolve(options.policy));
  const runtimeGoal = {
    ...loaded.goal,
    budgets: {
      ...loaded.goal.budgets,
      maxModelCalls: Math.min(
        loaded.goal.budgets.maxModelCalls,
        environment.discoveryMaxModelCalls,
      ),
      maxActions: Math.min(loaded.goal.budgets.maxActions, environment.discoveryMaxActions),
      timeoutMs: Math.min(loaded.goal.budgets.timeoutMs, environment.discoveryTimeoutMs),
      maxRepeatedStates: Math.min(
        loaded.goal.budgets.maxRepeatedStates,
        environment.discoveryMaxRepeatedStates,
      ),
      maxConsecutiveFailures: Math.min(
        loaded.goal.budgets.maxConsecutiveFailures,
        environment.discoveryMaxConsecutiveFailures,
      ),
    },
    screenshotPolicy:
      environment.discoverySendScreenshots && loaded.goal.screenshotPolicy === 'sanitized'
        ? ('sanitized' as const)
        : ('disabled' as const),
  };
  const planner =
    options.planner === 'openai'
      ? new OpenAIResponsesPlanner({
          apiKey: environment.openAiApiKey!,
          model: environment.openAiModel,
          timeoutMs: Math.min(30_000, runtimeGoal.budgets.timeoutMs),
          maxRetries: 1,
        })
      : createBankingScriptedPlanner();
  const secrets = Object.fromEntries(
    runtimeGoal.secretReferences
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const result = await new DiscoveryOrchestrator().run({
    loadedGoal: { ...loaded, goal: runtimeGoal },
    loadedPolicy,
    inputs: parseInputs(options.input, options.inputFile),
    secrets,
    adapter: new PlaywrightWebAdapter(),
    planner,
    evidenceDirectory: environment.paths.evidenceDirectory,
    headless: environment.browserHeadless,
    logger: createLogger({ level: environment.logLevel }),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'success' ? 0 : result.status === 'businessOutcome' ? 2 : 1;
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
  .option('--policy <path>', 'Path to the replay policy JSON')
  .option('--input <name=value>', 'Declared non-secret input', collectInput, [])
  .option('--input-file <path>', 'JSON object containing declared non-secret inputs')
  .action(runArtifactReplay);
program
  .command('replay:interactive')
  .description('Run a replay with local human intervention through the loopback operator console')
  .requiredOption('--artifact <path>', 'Path to the capability artifact JSON')
  .requiredOption('--policy <path>', 'Path to the replay policy JSON')
  .option('--input <name=value>', 'Declared non-secret input', collectInput, [])
  .option('--input-file <path>', 'JSON object containing declared non-secret inputs')
  .action((options) => runArtifactReplay({ ...options, interactive: true }));
program
  .command('proof:permission-denied')
  .description('Run the banking staff workflow with local non-staff credentials')
  .requiredOption('--artifact <path>', 'Path to the capability artifact JSON')
  .option('--policy <path>', 'Path to the replay policy JSON')
  .requiredOption('--customer-username <username>', 'Declared non-secret customer input')
  .action(runPermissionDeniedProof);
program
  .command('proof:policy-denial')
  .description('Verify a forbidden local-origin navigation is denied before browser execution')
  .requiredOption('--artifact <path>', 'Path to the capability artifact JSON')
  .option('--policy <path>', 'Path to the replay policy JSON')
  .action(runPolicyDenialProof);
program
  .command('proof-bank')
  .description('Run the explicit non-LLM banking proof flow')
  .option('--customer-username <username>', 'Customer username to locate')
  .action(runSurfaceSmokeCommand);
program
  .command('discover')
  .description('Run bounded one-action-at-a-time UI discovery')
  .requiredOption('--goal <path>', 'Path to the validated discovery goal')
  .requiredOption('--policy <path>', 'Path to the fail-closed discovery policy')
  .option('--input <name=value>', 'Declared non-secret input', collectInput, [])
  .option('--input-file <path>', 'JSON object containing declared non-secret inputs')
  .option('--planner <mode>', 'Planner mode: openai or fake', 'openai')
  .action(
    (options: {
      goal: string;
      policy: string;
      input: string[];
      inputFile?: string;
      planner: string;
    }) => {
      if (options.planner !== 'openai' && options.planner !== 'fake')
        throw new Error('Planner must be openai or fake');
      return runDiscovery({ ...options, planner: options.planner });
    },
  );
await program.parseAsync(process.argv);
