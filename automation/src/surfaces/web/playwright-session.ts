import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { SurfaceError } from '../surface-errors.js';

export type SessionState = 'idle' | 'starting' | 'active' | 'closing' | 'closed' | 'failed';

export class PlaywrightSession {
  state: SessionState = 'idle';
  browser: Browser | undefined;
  context: BrowserContext | undefined;
  page: Page | undefined;
  baseUrl = '';
  allowedOrigin = '';
  runId = '';
  timeoutMs = 15000;
  pendingError: SurfaceError | undefined;

  async start(options: {
    baseUrl: string;
    headless: boolean;
    runId: string;
    timeoutMs: number;
    viewport: { width: number; height: number };
  }): Promise<void> {
    if (this.state !== 'idle')
      throw new SurfaceError(
        this.state === 'active' ? 'SURFACE_ALREADY_STARTED' : 'INVALID_SURFACE_STATE',
        'Surface session cannot start from its current state',
      );
    this.state = 'starting';
    try {
      const url = new URL(options.baseUrl);
      this.baseUrl = url.toString().replace(/\/$/, '');
      this.allowedOrigin = url.origin;
      this.runId = options.runId;
      this.timeoutMs = options.timeoutMs;
      this.browser = await chromium.launch({ headless: options.headless });
      this.context = await this.browser.newContext({ viewport: options.viewport });
      this.context.setDefaultTimeout(options.timeoutMs);
      this.page = await this.context.newPage();
      this.page.on('dialog', (dialog) => {
        this.pendingError = new SurfaceError(
          'UNEXPECTED_DIALOG',
          `Unexpected ${dialog.type()} dialog was dismissed`,
        );
        void dialog.dismiss().catch(() => undefined);
      });
      this.page.on('download', (download) => {
        this.pendingError = new SurfaceError(
          'INVALID_SURFACE_STATE',
          `Unexpected download ${download.suggestedFilename()} was blocked`,
        );
        void download.cancel().catch(() => undefined);
      });
      this.context.on('page', (popup) => {
        if (popup !== this.page) {
          this.pendingError = new SurfaceError(
            'NAVIGATION_OUTSIDE_ALLOWED_ORIGIN',
            'Unexpected popup was closed',
          );
          void popup.close().catch(() => undefined);
        }
      });
      this.state = 'active';
    } catch (error: unknown) {
      this.state = 'failed';
      await this.close();
      throw new SurfaceError('BROWSER_LAUNCH_FAILED', 'Could not start Chromium', false, error);
    }
  }

  requirePage(): Page {
    if (this.state !== 'active' || !this.page)
      throw new SurfaceError('SURFACE_NOT_STARTED', 'Surface session is not active');
    return this.page;
  }
  takePendingError(): SurfaceError | undefined {
    const error = this.pendingError;
    this.pendingError = undefined;
    return error;
  }
  assertAllowed(url: string): void {
    if (url.startsWith('about:blank')) return;
    if (new URL(url, this.baseUrl).origin !== this.allowedOrigin)
      throw new SurfaceError(
        'NAVIGATION_OUTSIDE_ALLOWED_ORIGIN',
        'Navigation left the configured banking origin',
      );
  }
  async close(): Promise<void> {
    if (this.state === 'closed' || this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    if (this.state === 'closing') return;
    this.state = 'closing';
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.state = 'closed';
  }
}
