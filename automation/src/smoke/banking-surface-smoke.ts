import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CapabilityArtifact,
  type CapabilityArtifactType,
  type CapabilityStepType,
  type DataShapeType,
  type RunResultType,
} from '../domain/index.js';
import { loadEnvironment } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import type { ExecutionContext } from '../execution/execution-context.js';
import { PlaywrightWebAdapter } from '../surfaces/web/playwright-web-adapter.js';
import { SurfaceError } from '../surfaces/surface-errors.js';
import type { SurfaceEvent } from '../surfaces/surface-types.js';

async function loadArtifact(repositoryRoot: string): Promise<CapabilityArtifactType> {
  const raw = JSON.parse(
    await readFile(
      path.join(repositoryRoot, 'artifacts/lookup-customer-account.v1.example.json'),
      'utf8',
    ),
  ) as unknown;
  return CapabilityArtifact.parse(raw);
}

function step(artifact: CapabilityArtifactType, id: string): CapabilityStepType {
  const found = artifact.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Fixture step missing: ${id}`);
  return found;
}

export async function runBankingSurfaceSmoke(
  customerUsername: string,
  environment = loadEnvironment({ requireBankCredentials: true }),
): Promise<RunResultType> {
  const runId = `surface-${randomUUID()}`;
  const artifact = await loadArtifact(environment.paths.repositoryRoot);
  const logger = createLogger({ level: environment.logLevel }).child({
    runId,
    artifactId: artifact.id,
  });
  const adapter = new PlaywrightWebAdapter();
  const context: ExecutionContext = {
    inputs: { customerUsername },
    secrets: {
      BANK_STAFF_USERNAME: environment.bankStaffUsername!,
      BANK_STAFF_PASSWORD: environment.bankStaffPassword!,
    },
    outputs: {},
    baseUrl: environment.bankAppBaseUrl,
    outputShapes: Object.fromEntries(
      Object.entries(artifact.contract.outputs).map(([name, spec]) => [name, spec.shape]),
    ) as Record<string, DataShapeType>,
    runId,
    logger,
  };
  let trace;
  let screenshot;
  let observation;
  const events: SurfaceEvent[] = [];
  const runAction = async (id: string): Promise<void> => {
    const started = Date.now();
    const action = step(artifact, id).action;
    const actionResult = await adapter.execute(action, { ...context, stepId: id });
    events.push({
      timestamp: new Date().toISOString(),
      stepId: id,
      action: action.kind,
      ...(actionResult.target ? { locatorStrategy: actionResult.target.strategy } : {}),
      durationMs: Date.now() - started,
      ok: actionResult.ok,
      ...(actionResult.error ? { errorCode: actionResult.error.code } : {}),
    });
    if (!actionResult.ok)
      throw actionResult.error ?? new SurfaceError('ACTION_TIMEOUT', `Smoke action failed: ${id}`);
  };
  try {
    await adapter.start({
      baseUrl: environment.bankAppBaseUrl,
      headless: environment.browserHeadless,
      runId,
      evidenceDirectory: environment.paths.evidenceDirectory,
      timeoutMs: 15000,
      viewport: { width: 1280, height: 720 },
    });
    for (const id of ['open-login', 'enter-staff-username', 'enter-staff-password', 'submit-login'])
      await runAction(id);
    const loginCheckpoint = await adapter.evaluateCheckpoint(
      step(artifact, 'submit-login').checkpoint,
      context,
    );
    if (!loginCheckpoint.passed)
      throw new SurfaceError('CHECKPOINT_FAILED', 'Staff login checkpoint did not pass');
    events.push({
      timestamp: new Date().toISOString(),
      eventType: 'trace_omitted',
      action: 'trace',
      reason: 'Raw Playwright traces are disabled because they cannot be retained safely.',
      ok: true,
    });
    for (const id of ['open-customers', 'enter-customer-search', 'submit-customer-search'])
      await runAction(id);
    const notFound = await adapter.evaluateCheckpoint(
      artifact.contract.businessOutcomes[0]!.detection,
      context,
    );
    if (notFound.passed) {
      screenshot = await adapter.captureScreenshot({ name: 'not-found-final' });
      observation = await adapter.observe();
      await adapter.writeObservation(observation);
      const eventEvidence = await adapter.writeEventLog(events);
      const result: RunResultType = {
        status: 'businessOutcome',
        runId,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        code: 'CUSTOMER_NOT_FOUND',
        evidence: [screenshot, eventEvidence, ...(trace ? [trace] : [])],
        completedAt: new Date().toISOString(),
      };
      await adapter.writeResult(result);
      return result;
    }
    await runAction('open-customer-details');
    for (const id of ['extract-account-number', 'extract-current-balance']) {
      await runAction(id);
    }
    const success = await adapter.evaluateCheckpoint(artifact.success, context);
    if (!success.passed)
      throw new SurfaceError('CHECKPOINT_FAILED', 'Final output checkpoint did not pass');
    screenshot = await adapter.captureScreenshot({ name: 'success-final' });
    observation = await adapter.observe();
    await adapter.writeObservation(observation);
    const eventEvidence = await adapter.writeEventLog(events);
    const result: RunResultType = {
      status: 'success',
      runId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      outputs: context.outputs,
      evidence: [screenshot, eventEvidence, ...(trace ? [trace] : [])],
      completedAt: new Date().toISOString(),
    };
    await adapter.writeResult(result);
    return result;
  } catch (error: unknown) {
    if (adapter.session.state === 'active' && !trace)
      trace = await adapter.stopTrace().catch(() => undefined);
    const surface =
      error instanceof SurfaceError
        ? error
        : new SurfaceError('ACTION_TIMEOUT', 'Banking surface smoke failed', false, error);
    const result: RunResultType = {
      status: 'failure',
      runId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      error: surface.toErrorDetail(),
      evidence: trace ? [trace] : [],
      completedAt: new Date().toISOString(),
    };
    await adapter.writeResult(result).catch(() => undefined);
    return result;
  } finally {
    await adapter.close();
  }
}
