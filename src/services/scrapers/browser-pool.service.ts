import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/**
 * Shared Chromium browser instance + per-scrape context.
 *
 * Why: launching Chromium takes ~1-2s each call. Reusing the browser process
 * across scrapes cuts that cost to ~0. A fresh context per-scrape still gives
 * cookie isolation between platforms.
 */
@Injectable()
export class BrowserPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserPoolService.name);
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = chromium
      .launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      })
      .then((b) => {
        this.browser = b;
        b.on('disconnected', () => {
          this.browser = null;
        });
        this.launching = null;
        return b;
      })
      .catch((e) => {
        this.launching = null;
        throw e;
      });
    return this.launching;
  }

  /**
   * Creates a fresh context with resource-blocking applied.
   * Caller is responsible for context.close().
   */
  async createContext(options?: {
    cookies?: Array<Parameters<BrowserContext['addCookies']>[0][number]>;
    blockResources?: boolean;
    /** Resource types to abort. Defaults to images, media, fonts, stylesheets. */
    blockedResourceTypes?: Array<'image' | 'media' | 'font' | 'stylesheet'>;
  }): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });
    if (options?.cookies?.length) {
      await context.addCookies(options.cookies);
    }
    const page = await context.newPage();
    if (options?.blockResources !== false) {
      const blocked = new Set<string>(
        options?.blockedResourceTypes ?? ['image', 'media', 'font', 'stylesheet'],
      );
      await page.route('**/*', (route) => {
        if (blocked.has(route.request().resourceType())) return route.abort();
        return route.continue();
      });
    }
    return { context, page };
  }

  /** Close shared browser so next scrape picks up fresh process (e.g. after credential rotation). */
  async recycle(): Promise<void> {
    try {
      await this.browser?.close();
    } catch (e) {
      this.logger.warn(`browser recycle: ${(e as Error).message}`);
    }
    this.browser = null;
    this.launching = null;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.browser?.close();
    } catch (e) {
      this.logger.warn(`browser close failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Bounded auto-scroll. Exits after maxIterations to avoid infinite-scroll hangs.
 */
export async function boundedAutoScroll(
  page: Page,
  opts: { maxIterations?: number; distance?: number; intervalMs?: number } = {},
): Promise<void> {
  const maxIterations = opts.maxIterations ?? 8;
  const distance = opts.distance ?? 900;
  const intervalMs = opts.intervalMs ?? 350;
  await page.evaluate(
    async ({ maxIterations, distance, intervalMs }) => {
      await new Promise<void>((resolve) => {
        let i = 0;
        const t = setInterval(() => {
          window.scrollBy(0, distance);
          i += 1;
          if (i >= maxIterations) {
            clearInterval(t);
            resolve();
          }
        }, intervalMs);
      });
    },
    { maxIterations, distance, intervalMs },
  );
}
