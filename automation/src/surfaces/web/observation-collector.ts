import type { Page } from 'playwright';
import { DiscoveryObservation } from '../../domain/discovery.js';
import type { DiscoveryObservationType } from '../../domain/discovery.js';
import { SurfaceError } from '../surface-errors.js';

const interactive = 'a,button,input,select,textarea,[contenteditable="true"],[role]';
const boundedText = (value: string | null | undefined, max = 160): string | undefined => {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
};

export async function collectObservation(
  page: Page,
  observationId: string,
): Promise<DiscoveryObservationType> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const elements: Array<Record<string, unknown>> = [];
  const frames = page.frames();
  for (const [frameIndex, frame] of frames.entries()) {
    const locator = frame.locator(interactive);
    const count = Math.min(await locator.count(), 200 - elements.length);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const data = await item.evaluate((element) => {
        const tagName = element.tagName.toLowerCase();
        const role =
          element.getAttribute('role') ??
          (tagName === 'a' ? 'link' : tagName === 'button' ? 'button' : undefined);
        const text = element.getAttribute('aria-label') ?? element.textContent ?? undefined;
        return {
          tagName,
          role,
          text,
          name: element.getAttribute('name') ?? undefined,
          inputType: element.getAttribute('type') ?? undefined,
          enabled: !(element as HTMLButtonElement).disabled,
          editable:
            tagName === 'input' ||
            tagName === 'textarea' ||
            element.getAttribute('contenteditable') === 'true',
        };
      });
      const box = await item.boundingBox();
      const { text: rawText, ...safeData } = data;
      elements.push({
        reference: `e-${String(elements.length + 1).padStart(3, '0')}`,
        framePath: frameIndex === 0 ? [] : [`frame-${frameIndex}`],
        ...safeData,
        ...(box
          ? {
              boundingBox: {
                x: Math.max(0, Math.min(1, box.x / viewport.width)),
                y: Math.max(0, Math.min(1, box.y / viewport.height)),
                width: Math.max(0, Math.min(1, box.width / viewport.width)),
                height: Math.max(0, Math.min(1, box.height / viewport.height)),
              },
            }
          : {}),
        ...(boundedText(rawText) ? { text: boundedText(rawText) } : {}),
      });
    }
    if (elements.length >= 200) break;
  }
  try {
    return DiscoveryObservation.parse({
      observationId,
      capturedAt: new Date().toISOString(),
      url: page.url(),
      title: (await page.title()) || '(untitled)',
      elements,
      evidence: [],
    });
  } catch (error: unknown) {
    throw new SurfaceError(
      'CHECKPOINT_FAILED',
      'Could not construct a sanitized observation',
      false,
      error,
    );
  }
}
