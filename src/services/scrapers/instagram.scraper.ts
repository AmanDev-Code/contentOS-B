import { Injectable, Logger } from '@nestjs/common';
import { BrowserPoolService, boundedAutoScroll } from './browser-pool.service';
// boundedAutoScroll used below for lazy-loaded grid

import { ScraperEventLogService } from './scraper-event-log.service';
import {
  ScraperCredentialsService,
  type EffectiveScraperCredentials,
} from './scraper-credentials.service';
import { ScrapedPost } from './twitter.scraper';

const IG_FETCH_BUDGET_MS = 18_000;
const IG_SHORTCODE_RE = /\/(?:p|reel)\/([A-Za-z0-9_-]+)/;

@Injectable()
export class InstagramScraperService {
  private readonly logger = new Logger(InstagramScraperService.name);

  constructor(
    private readonly pool: BrowserPoolService,
    private readonly eventLog: ScraperEventLogService,
    private readonly credentials: ScraperCredentialsService,
  ) {}

  private buildCookies(c: EffectiveScraperCredentials): Array<any> {
    const igSession = c.instagramSession;
    if (!igSession) return [];
    const base = {
      domain: '.instagram.com',
      path: '/',
      secure: true,
      sameSite: 'None' as const,
    };
    const cookies: Array<any> = [
      { ...base, name: 'sessionid', value: igSession, httpOnly: true },
    ];
    const add = (name: string, value: string, sameSite: 'None' | 'Lax' = 'None') => {
      if (value) cookies.push({ ...base, name, value, sameSite });
    };
    add('csrftoken', c.instagramCsrfToken, 'Lax');
    add('ds_user_id', c.instagramDsUserId);
    add('ig_did', c.instagramIgDid);
    add('mid', c.instagramMid, 'Lax');
    return cookies;
  }

  /**
   * Fast path: fetch the post's public oEmbed/JSON via context.request.
   * Avoids rendering a full page per post.
   */
  private async extractCaptionViaApi(
    context: any,
    permalink: string,
  ): Promise<string> {
    // Instagram oEmbed endpoint returns html+caption without auth for public posts.
    // Fall back to ld+json scrape via cheap fetch otherwise.
    try {
      const target = `${permalink.replace(/\/?$/, '/')}?__a=1&__d=dioneyhub`;
      const resp = await context.request.get(target, { timeout: 6000 });
      if (!resp.ok()) throw new Error(`status ${resp.status()}`);
      const text = await resp.text();
      // Try JSON first
      try {
        const j = JSON.parse(text);
        const cap =
          j?.items?.[0]?.caption?.text ||
          j?.graphql?.shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
          '';
        if (typeof cap === 'string' && cap.trim().length >= 8) return cap.trim();
      } catch {
        /* html fallback below */
      }
      // Fallback: pull og:description from HTML
      const ogMatch = text.match(
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      );
      if (ogMatch?.[1] && ogMatch[1].length >= 8) return ogMatch[1];
    } catch {
      /* fall through */
    }
    return '';
  }

  async fetch(tag: string, limit: number): Promise<ScrapedPost[]> {
    const started = Date.now();
    const deadline = started + IG_FETCH_BUDGET_MS;
    const effective = await this.credentials.getEffective();
    const { context, page } = await this.pool.createContext({
      cookies: this.buildCookies(effective),
      blockedResourceTypes: ['image', 'media', 'font'],
    });
    const cleanTag = tag.replace(/^#+/, '');
    const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(cleanTag)}/`;

    let links: string[] = [];
    try {
      // STRATEGY 1: IG public tags JSON feed — no rendering needed, returns 60+ posts.
      try {
        const jsonUrl = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(cleanTag)}`;
        const r = await context.request.get(jsonUrl, {
          headers: {
            'x-ig-app-id': '936619743392459',
            accept: '*/*',
            'x-asbd-id': '129477',
            'x-requested-with': 'XMLHttpRequest',
          },
          timeout: 6000,
        });
        if (r.ok()) {
          const j = await r.json();
          const sections =
            j?.data?.top?.sections ||
            j?.data?.recent?.sections ||
            [];
          const reelsSections = j?.data?.top?.sections || [];
          const collect: Array<{ link: string; isReel: boolean; caption: string }> = [];
          const pickFromSections = (secs: any[]) => {
            for (const s of secs) {
              const medias = s?.layout_content?.medias || s?.layout_content?.fill_items || [];
              for (const m of medias) {
                const media = m?.media || m;
                const code = media?.code || media?.shortcode;
                if (!code) continue;
                const isReel = media?.product_type === 'clips' || media?.media_type === 2;
                collect.push({
                  link: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
                  isReel,
                  caption: media?.caption?.text || '',
                });
              }
            }
          };
          pickFromSections(sections);
          pickFromSections(reelsSections);
          // Prefer reels first per request
          collect.sort((a, b) => Number(b.isReel) - Number(a.isReel));
          if (collect.length > 0) {
            const max = Math.max(5, Math.min(limit, 15));
            const posts: ScrapedPost[] = [];
            for (const item of collect) {
              if (posts.length >= max) break;
              const cap = item.caption || '';
              if (!cap || cap.length < 8) continue;
              const hashtags =
                cap.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g)?.map((h) => h.toLowerCase()) || [];
              const shortcode = item.link.match(IG_SHORTCODE_RE)?.[1];
              posts.push({
                id: shortcode || crypto.randomUUID(),
                text: cap,
                hashtags: Array.from(new Set(hashtags)),
                publishedAt: new Date().toISOString(),
                permalink: item.link,
                platform: 'instagram',
                contentType: item.isReel ? 'reel' : 'post',
              });
            }
            if (posts.length > 0) {
              this.eventLog.record({
                ts: new Date().toISOString(),
                platform: 'instagram',
                tag: cleanTag,
                status: 'ok',
                count: posts.length,
                elapsedMs: Date.now() - started,
              });
              return posts;
            }
            // JSON had media but captions empty — fall through to fetch-by-link path
            links = collect.map((c) => c.link);
          }
        }
      } catch {
        /* fall through to DOM scrape */
      }

      // STRATEGY 2: DOM scrape the hashtag page
      if (links.length === 0) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });

        const currentUrl = page.url();
        if (
          currentUrl.includes('/accounts/login') ||
          currentUrl.includes('/challenge')
        ) {
          throw new Error('login_wall: redirected to Instagram login/challenge');
        }

        // Scroll to trigger lazy-load of the hashtag grid.
        await Promise.race([
          page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 5000 }).catch(() => null),
          page.waitForTimeout(2500),
        ]);
        await boundedAutoScroll(page, { maxIterations: 4, distance: 1200, intervalMs: 300 });
        await page.waitForTimeout(800);

        links = await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (els) =>
          Array.from(
            new Set(
              els
                .map((el: any) => String(el.href || ''))
                .filter((h: string) => /\/(p|reel)\//.test(h)),
            ),
          ),
        );
      }

      if (links.length === 0) {
        throw new Error('selector_miss: no /p/ or /reel/ links found on hashtag page');
      }

      // Prefer reels: sort so /reel/ links come first
      links.sort((a, b) => Number(b.includes('/reel/')) - Number(a.includes('/reel/')));

      // Done with the grid page — close it to release memory; API calls use context.request directly.
      await page.close().catch(() => {});

      const max = Math.max(5, Math.min(limit, 15));
      const targetPosts = Math.min(max, 10);

      // Fetch captions concurrently via IG JSON API (no Playwright per post).
      const candidates = links.slice(0, Math.min(links.length, targetPosts + 6));
      const results = await Promise.allSettled(
        candidates.map(async (link) => {
          if (Date.now() > deadline) throw new Error('budget');
          const cap = await this.extractCaptionViaApi(context, link);
          if (!cap) throw new Error('empty');
          return { link, cap };
        }),
      );

      const posts: ScrapedPost[] = [];
      for (const r of results) {
        if (posts.length >= targetPosts) break;
        if (r.status !== 'fulfilled') continue;
        const { link, cap } = r.value;
        const hashtags =
          cap.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g)?.map((h) => h.toLowerCase()) || [];
        const shortcode = link.match(IG_SHORTCODE_RE)?.[1];
        posts.push({
          id: shortcode || crypto.randomUUID(),
          text: cap,
          hashtags: Array.from(new Set(hashtags)),
          publishedAt: new Date().toISOString(),
          permalink: link,
          platform: 'instagram',
          contentType: link.includes('/reel/') ? 'reel' : 'post',
        });
      }

      if (posts.length === 0) {
        throw new Error(
          'selector_miss: links found but no readable post captions extracted',
        );
      }

      this.eventLog.record({
        ts: new Date().toISOString(),
        platform: 'instagram',
        tag: cleanTag,
        status: 'ok',
        count: posts.length,
        elapsedMs: Date.now() - started,
      });
      return posts;
    } catch (error) {
      this.eventLog.record({
        ts: new Date().toISOString(),
        platform: 'instagram',
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
