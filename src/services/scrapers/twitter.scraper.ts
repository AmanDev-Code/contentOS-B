import { Injectable } from '@nestjs/common';
import { BrowserPoolService } from './browser-pool.service';
import { ScraperEventLogService } from './scraper-event-log.service';
import { ScraperCredentialsService } from './scraper-credentials.service';

export type PostPlatform = 'instagram' | 'twitter' | 'linkedin';
export type PostContentType = 'post' | 'reel' | 'tweet' | 'thread' | 'article';

export interface ScrapedPost {
  id: string;
  text: string;
  hashtags: string[];
  publishedAt: string;
  permalink?: string;
  platform?: PostPlatform;
  contentType?: PostContentType;
}

@Injectable()
export class TwitterScraperService {
  constructor(
    private readonly pool: BrowserPoolService,
    private readonly eventLog: ScraperEventLogService,
    private readonly credentials: ScraperCredentialsService,
  ) {}

  async fetch(tag: string, limit: number): Promise<ScrapedPost[]> {
    const started = Date.now();
    const { xAuthToken: authToken } = await this.credentials.getEffective();
    const cookies = authToken
      ? [
          {
            name: 'auth_token',
            value: authToken,
            domain: '.x.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None' as const,
          },
        ]
      : [];
    const { context, page } = await this.pool.createContext({ cookies });
    const cleanTag = tag.replace(/^#+/, '');
    const url = `https://x.com/search?q=${encodeURIComponent(`#${cleanTag}`)}&src=typed_query&f=live`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });

      const currentUrl = page.url();
      if (
        currentUrl.includes('/i/flow/login') ||
        currentUrl.includes('/account/access')
      ) {
        throw new Error('login_wall: redirected to X login flow');
      }

      try {
        await page.waitForSelector(
          'article[data-testid="tweet"], article[role="article"]',
          { timeout: 5000 },
        );
      } catch {
        // fallback scan handled below
      }

      const max = Math.max(5, Math.min(limit, 60));
      let posts = await page.$$eval(
        'article[data-testid="tweet"], article[role="article"], article',
        (nodes, maxItems) => {
          const out: Array<{
            id: string;
            text: string;
            hashtags: string[];
            publishedAt: string;
            permalink?: string;
            platform?: string;
            contentType?: string;
          }> = [];
          for (const node of nodes.slice(0, maxItems)) {
            const text = (node.textContent || '').trim();
            if (!text) continue;
            const hashtags =
              text.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g)?.map((h) => h.toLowerCase()) || [];
            const link = (node as any).querySelector?.('a[href*="/status/"]');
            const href = String((link as any)?.href || '');
            out.push({
              id: href.split('/status/')[1]?.split('?')[0] || crypto.randomUUID(),
              text,
              hashtags: Array.from(new Set(hashtags)),
              publishedAt: new Date().toISOString(),
              permalink: href || undefined,
              platform: 'twitter',
              contentType: 'tweet',
            });
          }
          return out;
        },
        max,
      );

      if (posts.length === 0) {
        posts = await page.evaluate((maxItems: number) => {
          const out: Array<{
            id: string;
            text: string;
            hashtags: string[];
            publishedAt: string;
            platform?: string;
            contentType?: string;
          }> = [];
          const seen = new Set<string>();
          const all = Array.from(document.querySelectorAll('div, article, section'));
          for (const el of all) {
            const t = (el.textContent || '').trim();
            if (t.length < 30 || t.length > 3000) continue;
            if (!/#[a-zA-Z][a-zA-Z0-9_-]{1,48}/.test(t)) continue;
            if (el.querySelector('div, article, section')) {
              const inner = Array.from(el.children).some(
                (c) => (c.textContent || '').includes('#') && (c.textContent || '').length > 30,
              );
              if (inner) continue;
            }
            const key = t.slice(0, 120);
            if (seen.has(key)) continue;
            seen.add(key);
            const hashtags =
              t.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g)?.map((h) => h.toLowerCase()) || [];
            out.push({
              id: crypto.randomUUID(),
              text: t,
              hashtags: Array.from(new Set(hashtags)),
              publishedAt: new Date().toISOString(),
              platform: 'twitter',
              contentType: 'tweet',
            });
            if (out.length >= maxItems) break;
          }
          return out;
        }, max);
      }

      if (posts.length === 0) {
        throw new Error('selector_miss: no X article nodes produced text');
      }

      if (process.env.SCRAPER_DEBUG_SCREENSHOTS === 'true') {
        await page.screenshot({ path: `debug-x-${cleanTag}.png`, fullPage: false });
      }

      this.eventLog.record({
        ts: new Date().toISOString(),
        platform: 'twitter',
        tag: cleanTag,
        status: 'ok',
        count: posts.length,
        elapsedMs: Date.now() - started,
      });
      return posts as ScrapedPost[];
    } catch (error) {
      if (process.env.SCRAPER_DEBUG_SCREENSHOTS === 'true') {
        await page.screenshot({ path: `debug-x-${cleanTag}-error.png`, fullPage: false }).catch(() => {});
      }
      this.eventLog.record({
        ts: new Date().toISOString(),
        platform: 'twitter',
        tag: cleanTag,
        status: 'error',
        elapsedMs: Date.now() - started,
        error: (error as Error).message,
      });
      throw error;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }
}
