import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import {
  Engine,
  EngineType,
  ExtractionResult,
  MediaItem,
  ExtractionMetadata,
  Session,
} from '../../core';

/**
 * Instagram Embed Engine — Unauthenticated extraction via embed page.
 *
 * Fetches the /p/{shortcode}/embed/ page (no login required) and extracts
 * media URLs from embedded JSON or meta tags.
 *
 * Advantages:
 * - NO authentication needed (works without any session)
 * - Fast (simple HTTP GET, no browser)
 * - Works even when all sessions are dead/checkpoint
 *
 * Disadvantages:
 * - Instagram may rate-limit by IP
 * - May not always include video_url in embed response
 * - Lower metadata quality (no like/comment counts)
 *
 * Priority: 4 (last resort after browser engine fails)
 */
@Injectable()
export class InstagramEmbedEngine implements Engine {
  private readonly logger = new Logger(InstagramEmbedEngine.name);

  readonly name: EngineType = 'embed';
  readonly priority = 4;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async extract(url: string, _session?: Session): Promise<ExtractionResult> {
    const startTime = Date.now();

    const shortcode = this.extractShortcode(url);
    if (!shortcode) {
      return this.errorResult(url, startTime, 'INVALID_URL', `Cannot extract shortcode from: ${url}`);
    }

    try {
      // Fetch the embed page — doesn't require authentication
      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
      const response = await axios.get(embedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15_000,
        maxRedirects: 3,
      });

      const html = response.data as string;

      // Method 1: Extract from embedded JSON (window.__additionalDataLoaded or similar)
      const mediaData = this.extractFromEmbedJson(html, shortcode);
      if (mediaData) {
        return {
          ...mediaData,
          durationMs: Date.now() - startTime,
        };
      }

      // Method 2: Extract from og:video meta tag in embed page
      const ogVideo = this.extractFromMetaTags(html, shortcode);
      if (ogVideo) {
        return {
          ...ogVideo,
          durationMs: Date.now() - startTime,
        };
      }

      // Method 3: Extract video URL from embed page script data
      const scriptData = this.extractFromScripts(html, shortcode);
      if (scriptData) {
        return {
          ...scriptData,
          durationMs: Date.now() - startTime,
        };
      }

      return this.errorResult(url, startTime, 'NO_MEDIA', 'Embed page did not contain extractable media');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('404') || message.includes('Request failed with status code 404')) {
        return this.errorResult(url, startTime, 'NOT_FOUND', 'Post not found (404)', false);
      }
      if (message.includes('429')) {
        return this.errorResult(url, startTime, 'RATE_LIMITED', 'Embed endpoint rate limited', true);
      }

      return this.errorResult(url, startTime, 'FETCH_ERROR', message, true);
    }
  }

  /**
   * Extract media from embedded JSON in the embed page source.
   */
  private extractFromEmbedJson(html: string, shortcode: string): ExtractionResult | null {
    try {
      // Pattern: window.__additionalDataLoaded('extra', {...})
      // or embedded JSON with video_url
      const patterns = [
        /window\.__additionalDataLoaded\([^,]*,\s*({.+?})\s*\)/s,
        /"video_url"\s*:\s*"(https?:[^"]+)"/,
        /"video_versions"\s*:\s*(\[.+?\])/s,
      ];

      // Try full JSON extraction first
      const jsonMatch = html.match(patterns[0]);
      if (jsonMatch?.[1]) {
        const data = JSON.parse(jsonMatch[1]);
        const media =
          data?.shortcode_media ||
          data?.graphql?.shortcode_media;

        if (media) {
          return this.mediaNodeToResult(media, shortcode);
        }
      }

      // Try direct video_url extraction
      const videoUrlMatch = html.match(patterns[1]);
      if (videoUrlMatch?.[1]) {
        const videoUrl = videoUrlMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        const items: MediaItem[] = [{
          url: videoUrl,
          type: 'video',
        }];

        // Try to get dimensions from the page
        const widthMatch = html.match(/"video_width"\s*:\s*(\d+)/);
        const heightMatch = html.match(/"video_height"\s*:\s*(\d+)/);
        if (widthMatch && heightMatch) {
          items[0].width = parseInt(widthMatch[1]);
          items[0].height = parseInt(heightMatch[1]);
          items[0].quality = this.inferQuality(items[0].height);
        }

        // Get caption
        const captionMatch = html.match(/"caption"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]+)"/);

        return {
          success: true,
          platform: 'instagram',
          sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
          engine: this.name,
          items,
          metadata: {
            shortcode,
            caption: captionMatch?.[1]?.replace(/\\n/g, '\n'),
          },
          durationMs: 0,
          extractedAt: new Date().toISOString(),
        };
      }
    } catch {
      // JSON parse failed — continue to other methods
    }

    return null;
  }

  /**
   * Extract from og: meta tags in the embed page.
   */
  private extractFromMetaTags(html: string, shortcode: string): ExtractionResult | null {
    const ogVideoMatch = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i) ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video"/i);

    if (!ogVideoMatch?.[1]) return null;

    const videoUrl = ogVideoMatch[1].replace(/&amp;/g, '&');
    const items: MediaItem[] = [{ url: videoUrl, type: 'video' }];

    // Get dimensions
    const widthMatch = html.match(/<meta[^>]+property="og:video:width"[^>]+content="(\d+)"/i);
    const heightMatch = html.match(/<meta[^>]+property="og:video:height"[^>]+content="(\d+)"/i);
    if (widthMatch && heightMatch) {
      items[0].width = parseInt(widthMatch[1]);
      items[0].height = parseInt(heightMatch[1]);
      items[0].quality = this.inferQuality(items[0].height);
    }

    // Caption from og:description
    const descMatch = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i);

    return {
      success: true,
      platform: 'instagram',
      sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
      engine: this.name,
      items,
      metadata: {
        shortcode,
        caption: descMatch?.[1],
      },
      durationMs: 0,
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Extract from inline script tags that contain media data.
   */
  private extractFromScripts(html: string, shortcode: string): ExtractionResult | null {
    try {
      // Instagram embed pages often have data in script tags like:
      // <script>window.__initialData = {...}</script>
      const scriptPatterns = [
        /gql_data['"]\s*:\s*({.+?"shortcode_media".+?})\s*[,}]/s,
        /"xdt_shortcode_media"\s*:\s*({.+?})\s*}/s,
      ];

      for (const pattern of scriptPatterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
          try {
            const data = JSON.parse(match[1]);
            const media = data?.shortcode_media || data;
            if (media?.video_url || media?.display_url) {
              return this.mediaNodeToResult(media, shortcode);
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Convert a media node (GraphQL-style) to an ExtractionResult.
   */
  private mediaNodeToResult(media: any, shortcode: string): ExtractionResult | null {
    const items: MediaItem[] = [];

    if (media.is_video && media.video_url) {
      items.push({
        url: media.video_url,
        type: 'video',
        width: media.dimensions?.width,
        height: media.dimensions?.height,
        duration: media.video_duration,
        quality: this.inferQuality(media.dimensions?.height),
      });
    } else if (media.display_url) {
      items.push({
        url: media.display_url,
        type: 'image',
        width: media.dimensions?.width,
        height: media.dimensions?.height,
      });
    }

    if (items.length === 0) return null;

    return {
      success: true,
      platform: 'instagram',
      sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
      engine: this.name,
      items,
      metadata: {
        shortcode,
        caption: media.edge_media_to_caption?.edges?.[0]?.node?.text,
        authorUsername: media.owner?.username,
      },
      durationMs: 0,
      extractedAt: new Date().toISOString(),
    };
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
