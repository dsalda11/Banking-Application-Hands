import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { CapabilityArtifactType, CapabilityStepType, RunResultType } from '../domain/index.js';
import { ErrorDetail } from '../domain/errors.js';
import type { DataShapeType } from '../domain/data-shapes.js';
import type { EvidenceReferenceType } from '../domain/evidence.js';
import type { ExecutionContext } from '../execution/execution-context.js';
import { SurfaceError } from '../surfaces/surface-errors.js';
import type { SurfaceAdapter, SurfaceEvent } from '../surfaces/surface-types.js';
import { ArtifactLoadError, type LoadedArtifact } from './artifact-loader.js';
import { RuntimeBindingError, validateRuntimeBindings } from './runtime-bindings.js';

export interface ReplayOptions {
  readonly loadedArtifact: LoadedArtifact;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly baseUrl: string;
  readonly evidenceDirectory: string;
  readonly headless: boolean;
  readonly adapter: SurfaceAdapter;
  readonly logger?: Logger;
}

class ReplayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ReplayError';
  }
}

function errorDetail(error: unknown, stepId?: string) {
  if (error instanceof SurfaceError) return error.toErrorDetail(stepId);
  if (error instanceof ReplayError)
    return ErrorDetail.parse({
      category: error.code.includes('CHECKPOINT') ? 'checkpoint' : 'application',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      evidence: [],
      ...(stepId ? { stepId } : {}),
    });
  if (error instanceof RuntimeBindingError)
    return ErrorDetail.parse({
      category: 'session',
      code: error.code,
      message: error.message,
      retryable: false,
      evidence: [],
    });
  if (error instanceof ArtifactLoadError)
    return ErrorDetail.parse({
      category: 'schema',
      code: error.code,
      message: error.message,
      retryable: false,
      evidence: [],
    });
  return ErrorDetail.parse({
    category: 'internal',
    code: 'REPLAY_FAILED',
    message: 'Replay failed unexpectedly',
    retryable: false,
    evidence: [],
    ...(stepId ? { stepId } : {}),
  });
}

function delayMs(step: CapabilityStepType, attempt: number): number {
  if (step.recovery.kind !== 'retry') return 0;
  return step.recovery.backoff.kind === 'fixed'
    ? step.recovery.backoff.delayMs
    : Math.min(
        step.recovery.backoff.initialDelayMs * 2 ** Math.max(0, attempt - 1),
        step.recovery.backoff.maxDelayMs,
      );
}

function canRetry(step: CapabilityStepType, code: string): boolean {
  return step.recovery.kind === 'retry' && step.recovery.retryableErrorCodes.includes(code);
}

export class ReplayEngine {
  async run(options: ReplayOptions): Promise<RunResultType> {
    const runId = `replay-${randomUUID()}`;
    const { artifact, contentHash } = options.loadedArtifact;
    const events: SurfaceEvent[] = [];
    let trace: EvidenceReferenceType | undefined;
    let startedTrace = false;
    let secretStepSeen = false;
    let context: ExecutionContext | undefined;

    try {
      const bindings = validateRuntimeBindings(artifact, options.inputs, options.secrets);
      const replayContext: ExecutionContext = {
        inputs: bindings.inputs,
        secrets: bindings.secrets,
        outputs: {},
        baseUrl: options.baseUrl,
        outputShapes: Object.fromEntries(
          Object.entries(artifact.contract.outputs).map(([name, spec]) => [name, spec.shape]),
        ) as Record<string, DataShapeType>,
        runId,
        ...(options.logger ? { logger: options.logger } : {}),
      };
      context = replayContext;
      await options.adapter.start({
        baseUrl: options.baseUrl,
        headless: options.headless,
        runId,
        evidenceDirectory: options.evidenceDirectory,
        timeoutMs: 15000,
        viewport: { width: 1280, height: 720 },
      });
      for (const precondition of artifact.preconditions) {
        const result = await options.adapter.evaluateCheckpoint(precondition, context);
        events.push({
          timestamp: new Date().toISOString(),
          action: `checkpoint:${result.kind}`,
          ok: result.passed,
        });
        if (!result.passed)
          throw result.error ?? new ReplayError('CHECKPOINT_FAILED', result.description);
      }

      for (const step of artifact.steps) {
        const result = await this.executeStep(
          step,
          artifact,
          replayContext,
          options.adapter,
          events,
        );
        if (result.outcome) {
          const evidence = await this.finishEvidence(options.adapter, events, trace);
          const businessResult: RunResultType = {
            status: 'businessOutcome',
            runId,
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            artifactHash: contentHash,
            code: result.outcome.code,
            evidence,
            completedAt: new Date().toISOString(),
          };
          await options.adapter.writeResult(businessResult);
          return businessResult;
        }
        if (step.action.kind === 'enterText' && step.action.value.kind === 'secret')
          secretStepSeen = true;
        if (secretStepSeen && !startedTrace && step.action.kind !== 'enterText') {
          await options.adapter.startTrace({ name: 'post-secret-replay-trace' });
          startedTrace = true;
        }
      }
      if (!context)
        throw new ReplayError('REPLAY_CONTEXT_MISSING', 'Replay context was not initialized');
      const success = await options.adapter.evaluateCheckpoint(artifact.success, replayContext);
      events.push({
        timestamp: new Date().toISOString(),
        action: `checkpoint:${success.kind}`,
        ok: success.passed,
      });
      if (!success.passed)
        throw success.error ?? new ReplayError('CHECKPOINT_FAILED', success.description);
      for (const outputName of Object.keys(artifact.contract.outputs))
        if (!(outputName in replayContext.outputs))
          throw new ReplayError(
            'REQUIRED_OUTPUT_MISSING',
            `Required output ${outputName} was not produced`,
          );
      const screenshot = await options.adapter.captureScreenshot({ name: 'replay-final' });
      const observation = await options.adapter.observe();
      const observationEvidence = await options.adapter.writeObservation(observation);
      trace = startedTrace ? await options.adapter.stopTrace() : undefined;
      const evidence = [screenshot, observationEvidence, ...(trace ? [trace] : [])];
      const successResult: RunResultType = {
        status: 'success',
        runId,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactHash: contentHash,
        outputs: replayContext.outputs,
        evidence,
        completedAt: new Date().toISOString(),
      };
      const eventEvidence = await options.adapter.writeEventLog(events).catch((error: unknown) => {
        throw new ReplayError(
          'EVIDENCE_WRITE_FAILED',
          'Replay evidence could not be written',
          false,
          error,
        );
      });
      successResult.evidence.push(eventEvidence);
      await options.adapter.writeResult(successResult);
      return successResult;
    } catch (error: unknown) {
      if (startedTrace) trace = await options.adapter.stopTrace().catch(() => undefined);
      let failure = errorDetail(error, events.at(-1)?.stepId);
      try {
        await options.adapter.writeEventLog(events);
      } catch (evidenceError: unknown) {
        failure = ErrorDetail.parse({
          category: 'internal',
          code: 'EVIDENCE_WRITE_FAILED',
          message: 'Replay evidence could not be written',
          retryable: false,
          evidence: [],
          ...(events.at(-1)?.stepId ? { stepId: events.at(-1)!.stepId } : {}),
        });
        options.logger?.error(
          { code: 'EVIDENCE_WRITE_FAILED', runId },
          'Replay evidence could not be written',
        );
        void evidenceError;
      }
      const result: RunResultType = {
        status: 'failure',
        runId,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactHash: contentHash,
        error: failure,
        evidence: trace ? [trace] : [],
        completedAt: new Date().toISOString(),
      };
      try {
        await options.adapter.writeResult(result);
      } catch (resultError: unknown) {
        options.logger?.error(
          { code: 'RESULT_EVIDENCE_WRITE_FAILED', runId },
          'Replay result evidence could not be written',
        );
        void resultError;
      }
      return result;
    } finally {
      await options.adapter.close();
    }
  }

  private async executeStep(
    step: CapabilityStepType,
    artifact: CapabilityArtifactType,
    context: ExecutionContext,
    adapter: SurfaceAdapter,
    events: SurfaceEvent[],
  ): Promise<{ outcome?: { code: string } }> {
    const attempts = step.recovery.kind === 'retry' ? step.recovery.maxAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      const actionResult = await adapter.execute(step.action, { ...context, stepId: step.id });
      events.push({
        timestamp: new Date().toISOString(),
        stepId: step.id,
        action: step.action.kind,
        ...(actionResult.target ? { locatorStrategy: actionResult.target.strategy } : {}),
        durationMs: Date.now() - started,
        ok: actionResult.ok,
        ...(actionResult.error ? { errorCode: actionResult.error.code } : {}),
      });
      let failure: unknown;
      if (!actionResult.ok)
        failure = actionResult.error ?? new ReplayError('ACTION_FAILED', 'Artifact action failed');
      if (!failure) {
        const checkpoint = await adapter.evaluateCheckpoint(step.checkpoint, context);
        events.push({
          timestamp: new Date().toISOString(),
          stepId: step.id,
          action: `checkpoint:${checkpoint.kind}`,
          durationMs: checkpoint.durationMs,
          ok: checkpoint.passed,
          ...(checkpoint.error ? { errorCode: checkpoint.error.code } : {}),
        });
        if (!checkpoint.passed)
          failure =
            checkpoint.error ?? new ReplayError('CHECKPOINT_FAILED', checkpoint.description);
      }
      if (!failure) {
        for (const outcome of artifact.contract.businessOutcomes) {
          const detection = await adapter.evaluateCheckpoint(outcome.detection, context);
          events.push({
            timestamp: new Date().toISOString(),
            stepId: step.id,
            action: `outcome:${outcome.code}`,
            durationMs: detection.durationMs,
            ok: detection.passed,
          });
          if (detection.passed) return { outcome: { code: outcome.code } };
        }
        return {};
      }
      const code =
        failure instanceof SurfaceError || failure instanceof ReplayError
          ? failure.code
          : 'ACTION_FAILED';
      if (attempt < attempts && canRetry(step, code)) {
        const delay = delayMs(step, attempt);
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw failure;
    }
    throw new ReplayError('REPLAY_STEP_FAILED', `Step ${step.id} failed`);
  }

  private async finishEvidence(
    adapter: SurfaceAdapter,
    events: readonly SurfaceEvent[],
    trace: EvidenceReferenceType | undefined,
  ): Promise<EvidenceReferenceType[]> {
    const screenshot = await adapter.captureScreenshot({ name: 'replay-business-outcome' });
    const observation = await adapter.observe();
    const observationEvidence = await adapter.writeObservation(observation);
    const stoppedTrace = trace ?? (await adapter.stopTrace());
    const eventEvidence = await adapter.writeEventLog(events);
    return [
      screenshot,
      observationEvidence,
      eventEvidence,
      ...(stoppedTrace ? [stoppedTrace] : []),
    ];
  }
}
