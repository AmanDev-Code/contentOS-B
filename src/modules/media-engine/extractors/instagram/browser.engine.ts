import { Injectable, Logger } from '@nestjs/common';

import {
  Engine,
  EngineType,
  ExtractionResult,
  MediaItem,
  ExtractionMetadata,
  Session,
} from '../../core';
import { BrowserPoolService } from '../../../../services/scrapers/browser-pool.service';

/**
 * Instagram Browser Engine — Playwright-based extraction as last resort.
 *
 * Opens a real browser context (headless Chromium), navigates to the post,
 * and extracts media URLs from the page.
 *
 * Advantages:
 * - Works even when API methods are blocked
 * - Can handle login challenges visually (future)
 * - No API-specific knowledge needed
 *
 * Disadvantages:
 * - Slowest method (~3-8 seconds per extraction)
 * - Resource intensive (CPU/memory for browser)
 * - Can trigger Playwright-detectable patterns
 *
 * Priority: 3 (last resort after API methods fail)
 */
@Injectable()
export class InstagramBrowserEngine implements Engine {
  private readonly logger = new Logger(InstagramBrowserEngine.name);

  readonly name: EngineType = 'browser';
  readonly priority = 3;

  constructor(private readonly browserPool: BrowserPoolService) {}

  async isAvailable(): Promise<boolean> {
    // Browser engine is always "available" — it'll launch chromium on demand
    return true;
  }

  async extract(url: string, session?: Session): Promise<ExtractionResult> {
    const startTime = Date.now();

    const shortcode = this.extractShortcode(url);
    if (!shortcode) {
      return this.errorResult(url, startTime, 'INVALID_URL', `Cannot extract shortcode from: ${url}`);
    }

    let context: any = null;

    try {
      // Create browser context with session cookies if available
      const cookies = session
        ? Object.entries(session.cookies.cookies).map(([name, value]) => ({
            name,
            value,
            domain: '.instagram.com',
            path: '/',
          }))
        : undefined;

      const { context: ctx, page } = await this.browserPool.createContext({
        cookies,
        blockResources: true,
        blockedResourceTypes: ['font', 'stylesheet'], // Allow images/media
      });
      context = ctx;

      // Navigate to the post page
      const postUrl = `https://www.instagram.com/p/${shortcode}/`;
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      // Wait for content to load
      await page.waitForTimeout(2000);

      // Check for login wall
      const loginRequired = await page.$('input[name="username"]');
      if (loginRequired) {
        return this.errorResult(url, startTime, 'LOGIN_WALL', 'Instagram login wall detected', true);
      }

      // Try to extract media from the page
      const mediaData = await page.evaluate(() => {
        const result: any = { items: [], metadata: {} };

        // Method 1: Look for video elements
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          const src = video.src || video.querySelector('source')?.src;
          if (src) {
            result.items.push({
              url: src,
              type: 'video',
              width: video.videoWidth || video.clientWidth,
              height: video.videoHeight || video.clientHeight,
            });
          }
        }

        // Method 2: Look for og:video meta tag
        if (result.items.length === 0) {
          const ogVideo = document.querySelector('meta[property="og:video"]') as HTMLMetaElement;
          if (ogVideo?.content) {
            result.items.push({
              url: ogVideo.content,
              type: 'video',
              width: parseInt(
                (document.querySelector('meta[property="og:video:width"]') as HTMLMetaElement)?.content || '0',
              ),
              height: parseInt(
                (document.querySelector('meta[property="og:video:height"]') as HTMLMetaElement)?.content || '0',
              ),
            });
          }
        }

        // Method 3: Look for high-res images (for image posts)
        if (result.items.length === 0) {
          const images = document.querySelectorAll('article img[srcset], article img[src]');
          for (const img of images) {
            const imgEl = img as HTMLImageElement;
            // Get highest resolution from srcset
            const srcset = imgEl.srcset;
            let bestUrl = imgEl.src;

            if (srcset) {
              const sources = srcset.split(',').map((s) => s.trim().split(' '));
              const sorted = sources.sort((a, b) => {
                const aW = parseInt(a[1] || '0');
                const bW = parseInt(b[1] || '0');
                return bW - aW;
              });
              if (sorted[0]?.[0]) bestUrl = sorted[0][0];
            }

            if (bestUrl && !bestUrl.includes('profile_pic') && imgEl.width > 100) {
              result.items.push({
                url: bestUrl,
                type: 'image',
                width: imgEl.naturalWidth || imgEl.width,
                height: imgEl.naturalHeight || imgEl.height,
              });
            }
          }
        }

        // Extract metadata from meta tags
        const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content;
        const description = (document.querySelector('meta[property="og:description"]') as HTMLMetaElement)?.content;

        result.metadata = {
          caption: description || ogTitle,
        };

        return result;
      });

      if (!mediaData.items.length) {
        // Fallback: try extracting from page source __additionalData or shared_data
        const pageSource = await page.content();
        const extracted = this.extractFromPageSource(pageSource, shortcode);
        if (extracted) {
          return {
            ...extracted,
            durationMs: Date.now() - startTime,
          };
        }

        return this.errorResult(url, startTime, 'NO_MEDIA', 'Browser could not find media elements');
      }

      const items: MediaItem[] = mediaData.items.map((item: any) => ({
        url: item.url,
        type: item.type as 'video' | 'image',
        width: item.width || undefined,
        height: item.height || undefined,
        quality: item.type === 'video' ? this.inferQuality(item.height) : undefined,
      }));

      const metadata: ExtractionMetadata = {
        shortcode,
        caption: mediaData.metadata?.caption,
      };

      return {
        success: true,
        platform: 'instagram',
        sourceUrl: url,
        engine: this.name,
        accountId: session?.accountId,
        items,
        metadata,
        durationMs: Date.now() - startTime,
        extractedAt: new Date().toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Browser extraction failed: ${message}`);

      if (message.includes('Timeout') || message.includes('timeout')) {
        return this.errorResult(url, startTime, 'TIMEOUT', 'Browser navigation timed out', true);
      }

      return this.errorResult(url, startTime, 'BROWSER_ERROR', message, true);
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Try to extract media data from embedded JSON in page source.
   */
  private extractFromPageSource(html: string, shortcode: string): ExtractionResult | null {
    try {
      // Look for __additionalDataLoaded or window._sharedData patterns
      const patterns = [
        /window\.__additionalDataLoaded\([^,]+,\s*({.+?})\s*\)/s,
        /window\._sharedData\s*=\s*({.+?})\s*;/s,
        /"xdt_shortcode_media"\s*:\s*({.+?})\s*}/s,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
          const data = JSON.parse(match[1]);
          const media =
            data?.graphql?.shortcode_media ||
            data?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;

          if (media) {
            const items: MediaItem[] = [];
            if (media.is_video && media.video_url) {
              items.push({
                url: media.video_url,
                type: 'video',
                width: media.dimensions?.width,
                height: media.dimensions?.height,
                duration: media.video_duration,
              });
            } else if (media.display_url) {
              items.push({
                url: media.display_url,
                type: 'image',
                width: media.dimensions?.width,
                height: media.dimensions?.height,
              });
            }

            if (items.length > 0) {
              return {
                success: true,
                platform: 'instagram',
                sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
                engine: 'browser',
                items,
                metadata: {
                  shortcode,
                  caption: media.edge_media_to_caption?.edges?.[0]?.node?.text,
                  authorUsername: media.owner?.username,
                },
                durationMs: 0, // Caller will override
                extractedAt: new Date().toISOString(),
              };
            }
          }
        }
      }
    } catch {
      // JSON parse failed — ignore
    }

    return null;
  }

  private extractShortcode(url: string): string | null {
    const patterns = [
      /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/,
      /instagr\.am\/p\/([A-Za-z0-9_-]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) return match[1];
    }

    return null;
  }

  private inferQuality(height?: number): string | undefined {
    if (!height) return undefined;
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return '360p';
  }

  private errorResult(
    url: string,
    startTime: number,
    code: string,
    message: string,
    retryable = true,
  ): ExtractionResult {
    return {
      success: false,
      platform: 'instagram',
      sourceUrl: url,
      engine: this.name,
      items: [],
      error: { code, message, retryable, engine: this.name },
      durationMs: Date.now() - startTime,
      extractedAt: new Date().toISOString(),
    };
  }
}
