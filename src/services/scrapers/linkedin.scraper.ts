import { Injectable } from '@nestjs/common';
import { BrowserPoolService, boundedAutoScroll } from './browser-pool.service';
// keep boundedAutoScroll import for fallback when no posts appear initially
import { ScraperEventLogService } from './scraper-event-log.service';
import { ScraperCredentialsService } from './scraper-credentials.service';
import { ScrapedPost } from './twitter.scraper';

@Injectable()
export class LinkedinScraperService {
  constructor(
    private readonly pool: BrowserPoolService,
    private readonly eventLog: ScraperEventLogService,
    private readonly credentials: ScraperCredentialsService,
  ) {}

  async fetch(tag: string, limit: number): Promise<ScrapedPost[]> {
    const started = Date.now();
    const { linkedinCookie: liAt } = await this.credentials.getEffective();
    const cookies = liAt
      ? [
          {
            name: 'li_at',
            value: liAt,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None' as const,
          },
        ]
      : [];
    const { context, page } = await this.pool.createContext({ cookies });
    const cleanTag = tag.replace(/^#+/, '');
    const url = `https://www.linkedin.com/search/results/content/?keywords=%23${encodeURIComponent(cleanTag)}&origin=HASH_TAG_FROM_FEED&sortBy=%22date_posted%22`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });

      const currentUrl = page.url();
      if (
        currentUrl.includes('/login') ||
        currentUrl.includes('/authwall') ||
        currentUrl.includes('/checkpoint')
      ) {
        throw new Error('login_wall: redirected to LinkedIn auth/checkpoint');
      }

      const feedSelector =
        '[data-urn^="urn:li:activity"], .feed-shared-update-v2, .update-components-text, div.update-components-update-v2, .search-results-container li, article';
      try {
        await page.waitForSelector(feedSelector, { timeout: 5000 });
      } catch {
        // fallback handled below
      }

      const max = Math.max(5, Math.min(limit, 60));
      let posts = await page.$$eval(
        feedSelector,
        (nodes, maxItems) => {
          const out: Array<{
            id: string;
            text: string;
            hashtags: string[];
            publishedAt: string;
            platform?: string;
            contentType?: string;
          }> = [];
          for (const node of nodes.slice(0, maxItems)) {
            const text = (node.textContent || '').trim();
            if (!text) continue;
            const hashtags =
              text
                .match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g)
                ?.map((h) => h.toLowerCase()) || [];
            out.push({
              id:
                String((node as any).getAttribute?.('data-id') || '').trim() ||
                crypto.randomUUID(),
              text,
              hashtags: Array.from(new Set(hashtags)),
              publishedAt: new Date().toISOString(),
              platform: 'linkedin',
              contentType: 'post',
            });
          }
          return out;
        },
        max,
      );

      if (posts.length === 0) {
        // One small scroll then DOM-wide hashtag scan fallback
        await boundedAutoScroll(page, {
          maxIterations: 2,
          distance: 1200,
          intervalMs: 250,
        });
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
          const all = Array.from(
            document.querySelectorAll('div, li, article, section'),
          );
          for (const el of all) {
            const t = (el.textContent || '').trim();
            if (t.length < 40 || t.length > 4000) continue;
            if (!/#[a-zA-Z][a-zA-Z0-9_-]{1,48}/.test(t)) continue;
            if (el.querySelector('div,li,article,section')) {
              const inner = Array.from(el.children).some(
                (c) =>
                  (c.textContent || '').includes('#') &&
                  (c.textContent || '').length > 40,
              );
              if (inner) continue;
            }
            const key = t.slice(0, 120);
            if (seen.has(key)) continue;
            seen.add(key);
            const hashtags =
              t
                .match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g)
                ?.map((h) => h.toLowerCase()) || [];
            out.push({
              id: crypto.randomUUID(),
              text: t,
              hashtags: Array.from(new Set(hashtags)),
              publishedAt: new Date().toISOString(),
              platform: 'linkedin',
              contentType: 'post',
            });
            if (out.length >= maxItems) break;
          }
          return out;
        }, max);
      }

      if (posts.length === 0) {
        throw new Error(
          'selector_miss: no LinkedIn feed update nodes with text',
        );
      }

      if (process.env.SCRAPER_DEBUG_SCREENSHOTS === 'true') {
        await page.screenshot({
          path: `debug-linkedin-${cleanTag}.png`,
          fullPage: false,
        });
      }

      this.eventLog.record({
        ts: new Date().toISOString(),
        platform: 'linkedin',
        tag: cleanTag,
        status: 'ok',
        count: posts.length,
        elapsedMs: Date.now() - started,
      });
      return posts as ScrapedPost[];
    } catch (error) {
      if (process.env.SCRAPER_DEBUG_SCREENSHOTS === 'true') {
        await page
          .screenshot({
            path: `debug-linkedin-${cleanTag}-error.png`,
            fullPage: false,
          })
          .catch(() => {});
      }
      this.eventLog.record({
        ts: new Date().toISOString(),
        platform: 'linkedin',
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
