import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { DiscoveryObservation, type DiscoveryObservationType } from '../../domain/discovery.js';
import { SurfaceError } from '../surface-errors.js';

const interactive =
  'a,button,input,select,textarea,td,th,dd,output,[contenteditable="true"],[role],[tabindex]:not([tabindex="-1"])';
const boundedText = (value: string | null | undefined, max = 160): string | undefined => {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
};

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sanitizeObservation(
  observation: DiscoveryObservationType,
  confidentialValues: readonly string[],
): DiscoveryObservationType {
  const secrets = confidentialValues.filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (value: string): string =>
    secrets.reduce((current, secret) => current.split(secret).join('[REDACTED]'), value);
  const redactUnknown = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactUnknown);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          redactUnknown(item),
        ]),
      );
    return value;
  };
  const sanitized = {
    ...observation,
    url: redact(observation.url),
    title: redact(observation.title),
    headings: observation.headings.map((value) => redact(value).slice(0, 256)),
    visibleText: observation.visibleText.map((value) => redact(value).slice(0, 512)),
    elements: observation.elements.map((element) => ({
      ...element,
      ...(element.name ? { name: redact(element.name).slice(0, 256) } : {}),
      ...(element.text ? { text: redact(element.text).slice(0, 512) } : {}),
      locatorCandidates: redactUnknown(element.locatorCandidates),
      ...(element.frameLocatorCandidates
        ? { frameLocatorCandidates: redactUnknown(element.frameLocatorCandidates) }
        : {}),
    })),
    frames: observation.frames.map((frame) => ({ ...frame, url: redact(frame.url) })),
  };
  const state = {
    url: sanitized.url,
    title: sanitized.title,
    headings: sanitized.headings,
    visibleText: sanitized.visibleText,
    elements: sanitized.elements.map((element) => ({
      role: element.role,
      name: element.name,
      text: element.text,
      framePath: element.framePath,
      frameId: element.frameId,
      frameLocatorCandidates: element.frameLocatorCandidates,
      tagName: element.tagName,
      inputType: element.inputType,
      visible: element.visible,
      enabled: element.enabled,
      editable: element.editable,
      locatorCandidates: element.locatorCandidates,
    })),
    frames: sanitized.frames,
    scroll: sanitized.scroll,
  };
  return DiscoveryObservation.parse({ ...sanitized, stateFingerprint: fingerprint(state) });
}

export async function collectObservation(
  page: Page,
  observationId: string,
): Promise<DiscoveryObservationType> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const elements: Array<Record<string, unknown>> = [];
  const frames = page.frames().slice(0, 8);
  for (const [frameIndex, frame] of frames.entries()) {
    const frameLocatorCandidates: Array<Record<string, unknown>> = [];
    if (frameIndex > 0) {
      const frameElement = await frame.frameElement().catch(() => undefined);
      const frameFacts = await frameElement
        ?.evaluate((node) => {
          const element = node as Element;
          return {
            name: element.getAttribute('name'),
            id: element.getAttribute('id'),
            title: element.getAttribute('title'),
          };
        })
        .catch(() => undefined);
      if (frameFacts?.name)
        frameLocatorCandidates.push({
          strategy: 'attribute',
          name: 'name',
          value: { kind: 'literal', value: frameFacts.name },
        });
      if (frameFacts?.id)
        frameLocatorCandidates.push({
          strategy: 'attribute',
          name: 'id',
          value: { kind: 'literal', value: frameFacts.id },
        });
      if (frameFacts?.title)
        frameLocatorCandidates.push({
          strategy: 'attribute',
          name: 'title',
          value: { kind: 'literal', value: frameFacts.title },
        });
    }
    const locator = frame.locator(interactive);
    const count = Math.min(await locator.count(), 120 - elements.length);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const data = await item.evaluate((element) => {
        const tagName = element.tagName.toLowerCase();
        const explicitRole = element.getAttribute('role');
        const role =
          explicitRole ??
          (tagName === 'a'
            ? 'link'
            : tagName === 'button'
              ? 'button'
              : tagName === 'input'
                ? 'textbox'
                : undefined);
        const label =
          element.getAttribute('aria-label') ??
          (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : undefined);
        const text = label ?? element.textContent ?? undefined;
        return {
          tagName,
          role,
          text,
          name: label ?? element.getAttribute('name') ?? undefined,
          attributeName: element.getAttribute('name') ? 'name' : undefined,
          attributeValue: element.getAttribute('name') ?? undefined,
          inputType: element.getAttribute('type') ?? undefined,
          enabled: !(element as HTMLButtonElement).disabled,
          editable:
            tagName === 'input' ||
            tagName === 'textarea' ||
            element.getAttribute('contenteditable') === 'true',
        };
      });
      const box = await item.boundingBox();
      const text = boundedText(data.inputType === 'password' ? data.name : data.text);
      const candidates: Array<Record<string, unknown>> = [];
      if (data.role && (data.name || text))
        candidates.push({
          strategy: 'role',
          role: data.role,
          name: { kind: 'literal', value: boundedText(data.name ?? text, 256) },
          exact: true,
        });
      if (data.attributeName && data.attributeValue)
        candidates.push({
          strategy: 'attribute',
          name: data.attributeName,
          value: { kind: 'literal', value: data.attributeValue },
        });
      if (text && data.tagName !== 'input')
        candidates.push({
          strategy: 'text',
          text: { kind: 'literal', value: text },
          exact: true,
        });
      if (candidates.length === 0)
        candidates.push({
          strategy: 'accessibility',
          ...(data.role ? { role: data.role } : {}),
          ...(data.name ? { name: { kind: 'literal', value: data.name } } : {}),
        });
      const safeData = {
        tagName: data.tagName,
        role: data.role,
        name: data.name,
        inputType: data.inputType,
        enabled: data.enabled,
        editable: data.editable,
      };
      elements.push({
        reference: `e-${String(elements.length + 1).padStart(3, '0')}`,
        framePath: frameIndex === 0 ? [] : [`frame-${frameIndex}`],
        frameId: frameIndex === 0 ? 'main' : `frame-${frameIndex}`,
        ...(frameLocatorCandidates.length ? { frameLocatorCandidates } : {}),
        ...safeData,
        visible: true,
        locatorCandidates: candidates.slice(0, 4),
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
        ...(text ? { text } : {}),
      });
    }
    if (elements.length >= 120) break;
  }
  try {
    const pageFacts = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim())
        .filter((value): value is string => Boolean(value))
        .slice(0, 24);
      const visibleText = [
        ...document.querySelectorAll('main p,main td,main li,body > p,body > div'),
      ]
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 512))
        .filter((value): value is string => Boolean(value))
        .slice(0, 80);
      const maxX = Math.max(1, document.documentElement.scrollWidth - innerWidth);
      const maxY = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      return {
        headings,
        visibleText,
        scroll: { x: Math.min(1, scrollX / maxX), y: Math.min(1, scrollY / maxY) },
      };
    });
    const base = {
      observationId,
      capturedAt: new Date().toISOString(),
      url: page.url(),
      title: (await page.title()) || '(untitled)',
      headings: pageFacts.headings,
      visibleText: pageFacts.visibleText,
      elements,
      frames: frames.map((frame, index) => ({
        id: index === 0 ? 'main' : `frame-${index}`,
        url: frame.url() || 'about:blank',
      })),
      scroll: pageFacts.scroll,
      evidence: [],
    };
    return DiscoveryObservation.parse({ ...base, stateFingerprint: fingerprint(base) });
  } catch (error: unknown) {
    throw new SurfaceError(
      'CHECKPOINT_FAILED',
      'Could not construct a sanitized observation',
      false,
      error,
    );
  }
}
