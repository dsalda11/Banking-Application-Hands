import type { FrameLocator, Locator, Page } from 'playwright';
import type {
  LocatorCandidateType,
  LocatorValueSourceType,
  TargetDescriptorType,
} from '../../domain/locators.js';
import type { ExecutionContext } from '../../execution/execution-context.js';
import { SurfaceError } from '../surface-errors.js';

type LocatorRoot = Page | FrameLocator | Locator;
export interface ResolvedLocator {
  readonly locator: Locator;
  readonly strategy: string;
  readonly candidateIndex: number;
  readonly framePath: string[];
}

function bind(source: LocatorValueSourceType, context: ExecutionContext): string {
  if (source.kind === 'literal') return source.value;
  const value = context.inputs[source.name];
  if (typeof value !== 'string' || value.length === 0)
    throw new SurfaceError('INPUT_VALUE_MISSING', source.name);
  return value;
}

function locate(
  root: LocatorRoot,
  candidate: LocatorCandidateType,
  context: ExecutionContext,
): Locator {
  switch (candidate.strategy) {
    case 'role':
      return root.getByRole(
        candidate.role as never,
        candidate.name
          ? {
              name: bind(candidate.name, context),
              ...(candidate.exact === undefined ? {} : { exact: candidate.exact }),
            }
          : undefined,
      );
    case 'label':
      return root.getByLabel(
        bind(candidate.text, context),
        candidate.exact === undefined ? undefined : { exact: candidate.exact },
      );
    case 'text':
      return root.getByText(
        bind(candidate.text, context),
        candidate.exact === undefined ? undefined : { exact: candidate.exact },
      );
    case 'attribute': {
      if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(candidate.name))
        throw new SurfaceError('INVALID_LOCATOR', 'Unsafe attribute name');
      return root.locator(`*[${candidate.name}=${JSON.stringify(bind(candidate.value, context))}]`);
    }
    case 'css':
      return root.locator(candidate.selector);
    case 'xpath':
      return root.locator(`xpath=${candidate.expression}`);
    case 'accessibility':
      return candidate.role
        ? root.getByRole(
            candidate.role as never,
            candidate.name ? { name: bind(candidate.name, context) } : undefined,
          )
        : root.getByLabel(bind(candidate.name!, context));
    case 'visualAnchor':
      throw new SurfaceError(
        'UNSUPPORTED_LOCATOR_STRATEGY',
        'visualAnchor is discovery-only in this phase',
      );
  }
}

async function visibleCount(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1)
    if (await locator.nth(index).isVisible()) visible += 1;
  return visible;
}

async function resolveFramePath(
  page: Page,
  candidates: readonly LocatorCandidateType[],
  context: ExecutionContext,
): Promise<{ root: LocatorRoot; ids: string[] }> {
  let root: LocatorRoot = page;
  const ids: string[] = [];
  for (const candidate of candidates) {
    const locator = locate(root, candidate, context);
    const count = await visibleCount(locator);
    if (count !== 1)
      throw new SurfaceError(
        count === 0 ? 'LOCATOR_NOT_FOUND' : 'LOCATOR_AMBIGUOUS',
        'Frame locator did not resolve uniquely',
      );
    const frame = await locator.first().contentFrame();
    if (!frame) throw new SurfaceError('LOCATOR_NOT_FOUND', 'Resolved target is not a frame');
    root = frame;
    ids.push(candidate.strategy);
  }
  return { root, ids };
}

function scoped(
  root: LocatorRoot,
  candidate: LocatorCandidateType,
  context: ExecutionContext,
): Locator {
  if (candidate.strategy === 'text')
    return root.locator('tr').filter({ hasText: bind(candidate.text, context) });
  return locate(root, candidate, context);
}

export async function resolveTarget(
  page: Page,
  target: TargetDescriptorType,
  context: ExecutionContext,
): Promise<ResolvedLocator> {
  const frame = await resolveFramePath(page, target.framePath ?? [], context);
  let root = frame.root;
  for (const candidate of target.scope ?? []) {
    const narrowed = scoped(root, candidate, context);
    const count = await visibleCount(narrowed);
    if (count === 0)
      throw new SurfaceError('LOCATOR_NOT_FOUND', `Scope not found: ${target.description}`);
    root = narrowed.first();
  }
  for (const [index, candidate] of target.candidates.entries()) {
    const locator = locate(root, candidate, context);
    const count = await visibleCount(locator);
    if (target.match === 'exactlyOne' && count === 1)
      return {
        locator: locator.filter({ visible: true }).first(),
        strategy: candidate.strategy,
        candidateIndex: index,
        framePath: frame.ids,
      };
    if (target.match === 'firstVisible' && count > 0)
      return {
        locator: locator.filter({ visible: true }).first(),
        strategy: candidate.strategy,
        candidateIndex: index,
        framePath: frame.ids,
      };
    if (target.match === 'exactlyOne' && count > 1) continue;
  }
  const code =
    target.match === 'exactlyOne' &&
    (
      await Promise.all(
        target.candidates.map((candidate) => visibleCount(locate(root, candidate, context))),
      )
    ).some((count) => count > 1)
      ? 'LOCATOR_AMBIGUOUS'
      : 'LOCATOR_NOT_FOUND';
  throw new SurfaceError(code, `Could not resolve ${target.description}`);
}
