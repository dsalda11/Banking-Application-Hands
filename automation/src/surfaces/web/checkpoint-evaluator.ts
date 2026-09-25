import type { Page } from 'playwright';
import type { CheckpointType } from '../../domain/checkpoints.js';
import type { DataShapeType } from '../../domain/data-shapes.js';
import type { ExecutionContext } from '../../execution/execution-context.js';
import { resolveTarget } from './locator-resolver.js';
import { SurfaceError } from '../surface-errors.js';
import type { CheckpointEvaluationResult, ResolvedTargetFacts } from '../surface-types.js';

const detail = (checkpoint: CheckpointType): Record<string, unknown> =>
  checkpoint as unknown as Record<string, unknown>;

function matches(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch (error: unknown) {
    throw new SurfaceError('CHECKPOINT_FAILED', 'Invalid checkpoint pattern', false, error);
  }
}

function shapeMatches(value: unknown, shape: DataShapeType): boolean {
  if (shape.kind === 'string')
    return (
      typeof value === 'string' &&
      (shape.enum ? shape.enum.includes(value) : true) &&
      (shape.pattern ? matches(value, shape.pattern) : true)
    );
  if (shape.kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (shape.kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (shape.kind === 'boolean') return typeof value === 'boolean';
  if (shape.kind === 'array')
    return (
      Array.isArray(value) &&
      value.every((entry) => shape.items && shapeMatches(entry, shape.items))
    );
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    (shape.required ?? []).every((key) => key in object) &&
    Object.entries(shape.properties ?? {}).every(
      ([key, child]) => !(key in object) || shapeMatches(object[key], child),
    )
  );
}

export async function evaluateCheckpoint(
  page: Page,
  checkpoint: CheckpointType,
  context: ExecutionContext,
): Promise<CheckpointEvaluationResult> {
  const started = Date.now();
  const value = detail(checkpoint);
  const base = (
    passed: boolean,
    observedState: unknown,
    target?: ResolvedTargetFacts,
  ): CheckpointEvaluationResult => ({
    passed,
    kind: checkpoint.kind,
    description: checkpoint.description,
    observedState,
    durationMs: Date.now() - started,
    ...(target ? { target } : {}),
  });
  try {
    switch (checkpoint.kind) {
      case 'urlMatches':
        return base(matches(page.url(), String(value.pattern)), { url: page.url() });
      case 'titleMatches':
        return base(matches(await page.title(), String(value.pattern)), {
          title: await page.title(),
        });
      case 'textPresent': {
        const text = await page.locator('body').innerText();
        return base(text.includes(String(value.text)), {
          present: text.includes(String(value.text)),
        });
      }
      case 'textAbsent': {
        const text = await page.locator('body').innerText();
        return base(!text.includes(String(value.text)), {
          present: text.includes(String(value.text)),
        });
      }
      case 'elementVisible': {
        const resolved = await resolveTarget(page, value.target as never, context);
        return base(
          true,
          { visible: true },
          {
            strategy: resolved.strategy,
            candidateIndex: resolved.candidateIndex,
            framePath: resolved.framePath,
            description: (value.target as { description: string }).description,
          },
        );
      }
      case 'elementAbsent': {
        try {
          await resolveTarget(page, value.target as never, context);
          return base(false, { absent: false });
        } catch (error: unknown) {
          if (error instanceof SurfaceError && error.code === 'LOCATOR_NOT_FOUND')
            return base(true, { absent: true });
          throw error;
        }
      }
      case 'valueEquals': {
        const resolved = await resolveTarget(page, value.target as never, context);
        const current = await resolved.locator
          .inputValue()
          .catch(async () => resolved.locator.innerText());
        return base(
          current === String(value.value),
          { valuePresent: true },
          {
            strategy: resolved.strategy,
            candidateIndex: resolved.candidateIndex,
            framePath: resolved.framePath,
            description: (value.target as { description: string }).description,
          },
        );
      }
      case 'outputPresent': {
        const outputName = String(value.output);
        return base(outputName in context.outputs, { present: outputName in context.outputs });
      }
      case 'outputMatchesShape': {
        const outputName = String(value.output);
        const shape = context.outputShapes?.[outputName];
        return base(
          outputName in context.outputs &&
            Boolean(shape) &&
            shapeMatches(context.outputs[outputName], shape as DataShapeType),
          { present: outputName in context.outputs },
        );
      }
      case 'all': {
        const results = [];
        for (const child of checkpoint.children ?? [])
          results.push(await evaluateCheckpoint(page, child, context));
        return base(
          results.every((entry) => entry.passed),
          results.map((entry) => entry.passed),
        );
      }
      case 'any': {
        const results = [];
        for (const child of checkpoint.children ?? [])
          results.push(await evaluateCheckpoint(page, child, context));
        return base(
          results.some((entry) => entry.passed),
          results.map((entry) => entry.passed),
        );
      }
      case 'not': {
        const result = await evaluateCheckpoint(page, checkpoint.child as CheckpointType, context);
        return base(!result.passed, { childPassed: result.passed });
      }
      case 'applicationFingerprint':
        throw new SurfaceError(
          'UNSUPPORTED_CHECKPOINT',
          `Fingerprint ${String(value.fingerprintId)} requires target metadata`,
        );
    }
    return base(false, { unsupported: true });
  } catch (error: unknown) {
    const surface =
      error instanceof SurfaceError
        ? error
        : new SurfaceError('CHECKPOINT_FAILED', 'Checkpoint evaluation failed', false, error);
    return {
      passed: false,
      kind: checkpoint.kind,
      description: checkpoint.description,
      observedState: { error: surface.code },
      durationMs: Date.now() - started,
      error: surface,
    };
  }
}
