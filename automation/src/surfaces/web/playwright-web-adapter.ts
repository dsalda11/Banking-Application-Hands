import path from 'node:path';
import type { CapabilityActionType } from '../../domain/actions.js';
import type { CheckpointType } from '../../domain/checkpoints.js';
import type { DiscoveryObservationType } from '../../domain/discovery.js';
import type { EvidenceReferenceType } from '../../domain/evidence.js';
import type { ExecutionContext } from '../../execution/execution-context.js';
import { applyTransform } from '../../execution/apply-transform.js';
import {
  resolveStringValue,
  resolveValue,
  ValueResolutionError,
} from '../../execution/resolve-value.js';
import { evaluateCheckpoint } from './checkpoint-evaluator.js';
import { resolveTarget, type ResolvedLocator } from './locator-resolver.js';
import { collectObservation } from './observation-collector.js';
import { PlaywrightSession } from './playwright-session.js';
import { evidenceReference, prepareEvidenceDirectory, writeJson } from './safe-artifacts.js';
import { SurfaceError } from '../surface-errors.js';
import type {
  CheckpointEvaluationResult,
  ScreenshotOptions,
  SurfaceActionResult,
  SurfaceAdapter,
  SurfaceStartOptions,
  SurfaceEvent,
  TraceOptions,
} from '../surface-types.js';

export class PlaywrightWebAdapter implements SurfaceAdapter {
  readonly session = new PlaywrightSession();
  private evidenceDirectory = '';
  private tracing = false;
  private observationNumber = 0;
  private traceName = 'surface-trace.zip';

  async start(options: SurfaceStartOptions): Promise<void> {
    this.evidenceDirectory = await prepareEvidenceDirectory(
      options.evidenceDirectory,
      options.runId,
    );
    await this.session.start({
      baseUrl: options.baseUrl,
      headless: options.headless ?? true,
      runId: options.runId,
      timeoutMs: options.timeoutMs ?? 15000,
      viewport: options.viewport ?? { width: 1280, height: 720 },
    });
  }
  private page() {
    return this.session.requirePage();
  }
  async observe(): Promise<DiscoveryObservationType> {
    return collectObservation(
      this.page(),
      `obs-${String(++this.observationNumber).padStart(3, '0')}`,
    );
  }
  private facts(resolved: ResolvedLocator, description: string) {
    return {
      strategy: resolved.strategy,
      candidateIndex: resolved.candidateIndex,
      framePath: resolved.framePath,
      description,
    };
  }
  private async actionResult(
    action: CapabilityActionType,
    context: ExecutionContext,
    work: () => Promise<{
      target?: ReturnType<PlaywrightWebAdapter['facts']>;
      output?: { name: string; value: unknown };
    }>,
  ): Promise<SurfaceActionResult> {
    const startedAt = new Date().toISOString();
    try {
      const pendingError = this.session.takePendingError();
      if (pendingError) throw pendingError;
      const result = await work();
      return {
        ok: true,
        action: action.kind,
        startedAt,
        completedAt: new Date().toISOString(),
        url: this.page().url(),
        ...(result.target ? { target: result.target } : {}),
        ...(result.output ? { output: result.output } : {}),
      };
    } catch (error: unknown) {
      const surface =
        error instanceof SurfaceError
          ? error
          : error instanceof ValueResolutionError
            ? new SurfaceError(error.code, error.message)
            : new SurfaceError(
                action.kind === 'navigate' ? 'NAVIGATION_TIMEOUT' : 'ACTION_TIMEOUT',
                'Surface action failed',
                false,
                error,
              );
      context.logger?.warn(
        { code: surface.code, action: action.kind, runId: context.runId, stepId: context.stepId },
        surface.message,
      );
      return {
        ok: false,
        action: action.kind,
        startedAt,
        completedAt: new Date().toISOString(),
        url: this.page().url(),
        error: surface,
      };
    }
  }
  async execute(
    action: CapabilityActionType,
    context: ExecutionContext,
  ): Promise<SurfaceActionResult> {
    return this.actionResult(action, context, async () => {
      switch (action.kind) {
        case 'navigate': {
          const raw =
            'kind' in action.destination &&
            (action.destination.kind === 'relativeRoute' ||
              action.destination.kind === 'absoluteUrl')
              ? action.destination.kind === 'relativeRoute'
                ? new URL(action.destination.route, `${this.session.baseUrl}/`).toString()
                : action.destination.url
              : String(resolveValue(action.destination, context));
          this.session.assertAllowed(raw);
          await this.page().goto(raw, {
            waitUntil: 'domcontentloaded',
            timeout: this.session.timeoutMs,
          });
          this.session.assertAllowed(this.page().url());
          return {};
        }
        case 'activate': {
          const resolved = await resolveTarget(this.page(), action.target, context);
          await resolved.locator.click({ timeout: this.session.timeoutMs });
          await this.page()
            .waitForLoadState('domcontentloaded', { timeout: this.session.timeoutMs })
            .catch(() => undefined);
          this.session.assertAllowed(this.page().url());
          return { target: this.facts(resolved, action.target.description) };
        }
        case 'enterText': {
          const resolved = await resolveTarget(this.page(), action.target, context);
          if (!(await resolved.locator.isEditable()))
            throw new SurfaceError('ELEMENT_NOT_EDITABLE', action.target.description);
          const value = resolveStringValue(action.value, context);
          if (action.clear) await resolved.locator.fill(value);
          else await resolved.locator.pressSequentially(value);
          return { target: this.facts(resolved, action.target.description) };
        }
        case 'selectOption': {
          const resolved = await resolveTarget(this.page(), action.target, context);
          const value = resolveStringValue(action.value, context);
          try {
            await resolved.locator.selectOption(value);
          } catch (error: unknown) {
            throw new SurfaceError(
              'OPTION_NOT_FOUND',
              'Requested option was not available',
              false,
              error,
            );
          }
          return { target: this.facts(resolved, action.target.description) };
        }
        case 'pressKey': {
          const target = action.target
            ? await resolveTarget(this.page(), action.target, context)
            : undefined;
          if (target) await target.locator.press(action.key);
          else await this.page().keyboard.press(action.key);
          return target
            ? { target: this.facts(target, action.target?.description ?? 'keyboard target') }
            : {};
        }
        case 'scroll': {
          if (action.target) {
            const resolved = await resolveTarget(this.page(), action.target, context);
            await resolved.locator.scrollIntoViewIfNeeded();
            return { target: this.facts(resolved, action.target.description) };
          }
          await this.page().mouse.wheel(
            0,
            (action.direction === 'down' ? 1 : -1) * (action.amount ?? 100),
          );
          return {};
        }
        case 'wait': {
          const deadline = Date.now() + this.session.timeoutMs;
          while (Date.now() < deadline) {
            const result = await this.evaluateCheckpoint(action.condition, context);
            if (result.passed) return {};
            await this.page().waitForTimeout(50);
          }
          throw new SurfaceError('CHECKPOINT_FAILED', 'Wait checkpoint timed out', true);
        }
        case 'extract': {
          const resolved = await resolveTarget(this.page(), action.target, context);
          const raw = await resolved.locator
            .inputValue()
            .catch(async () => resolved.locator.innerText());
          const output = applyTransform(action.transform, raw);
          context.outputs[action.output] = output;
          if (context.outputShapes?.[action.output]) {
            const check = await this.evaluateCheckpoint(
              {
                kind: 'outputMatchesShape',
                description: 'extracted output shape',
                output: action.output,
              },
              context,
            );
            if (!check.passed)
              throw new SurfaceError(
                'EXTRACTION_FAILED',
                `Output ${action.output} did not match its declared shape`,
              );
          }
          return {
            target: this.facts(resolved, action.target.description),
            output: { name: action.output, value: output },
          };
        }
      }
    });
  }
  async evaluateCheckpoint(
    checkpoint: CheckpointType,
    context: ExecutionContext,
  ): Promise<CheckpointEvaluationResult> {
    return evaluateCheckpoint(this.page(), checkpoint, context);
  }
  private async assertNoPasswordValue(): Promise<void> {
    const fields = this.page().locator('input[type="password"]');
    for (let index = 0; index < (await fields.count()); index += 1)
      if (await fields.nth(index).inputValue())
        throw new SurfaceError(
          'INVALID_SURFACE_STATE',
          'Credential field is populated; screenshot/trace is blocked',
        );
  }
  async captureScreenshot(options: ScreenshotOptions = {}): Promise<EvidenceReferenceType> {
    await this.assertNoPasswordValue();
    const filePath = path.join(this.evidenceDirectory, `${options.name ?? 'screenshot'}.png`);
    await this.page().screenshot({ path: filePath, fullPage: options.fullPage ?? true });
    return evidenceReference(
      this.session.baseUrl
        ? path.resolve(this.evidenceDirectory, '../../..')
        : this.evidenceDirectory,
      filePath,
      'screenshot',
      'image/png',
    );
  }
  async startTrace(options: TraceOptions = {}): Promise<void> {
    await this.assertNoPasswordValue();
    if (this.tracing) throw new SurfaceError('INVALID_SURFACE_STATE', 'Trace already started');
    await this.session.context?.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    this.traceName = `${options.name ?? 'surface-trace'}.zip`;
    this.tracing = true;
  }
  async stopTrace(): Promise<EvidenceReferenceType | undefined> {
    if (!this.tracing) return undefined;
    const filePath = path.join(this.evidenceDirectory, this.traceName);
    await this.session.context?.tracing.stop({ path: filePath });
    this.tracing = false;
    return evidenceReference(
      path.resolve(this.evidenceDirectory, '../../..'),
      filePath,
      'trace',
      'application/zip',
    );
  }
  async writeObservation(observation: DiscoveryObservationType): Promise<EvidenceReferenceType> {
    const filePath = path.join(this.evidenceDirectory, 'observation.json');
    await writeJson(filePath, observation);
    return evidenceReference(
      path.resolve(this.evidenceDirectory, '../../..'),
      filePath,
      'semanticSnapshot',
      'application/json',
    );
  }
  async writeResult(result: unknown): Promise<EvidenceReferenceType> {
    const filePath = path.join(this.evidenceDirectory, 'result.json');
    await writeJson(filePath, result);
    return evidenceReference(
      path.resolve(this.evidenceDirectory, '../../..'),
      filePath,
      'result',
      'application/json',
    );
  }
  async writeEventLog(events: readonly SurfaceEvent[]): Promise<EvidenceReferenceType> {
    const filePath = path.join(this.evidenceDirectory, 'events.json');
    await writeJson(filePath, events);
    return evidenceReference(
      path.resolve(this.evidenceDirectory, '../../..'),
      filePath,
      'eventLog',
      'application/json',
    );
  }
  async close(): Promise<void> {
    await this.session.close();
  }
}
