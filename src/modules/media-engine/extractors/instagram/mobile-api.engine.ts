import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

import {
  Engine,
  EngineType,
  ExtractionResult,
  MediaItem,
  ExtractionMetadata,
  Session,
  INSTAGRAM,
} from '../../core';

/**
 * Instagram Mobile API Engine — Mimics the Instagram Android app's private API.
 *
 * Uses /api/v1/media/{id}/info/ endpoint (instagrapi-style).
 * This is the same approach used by python-instagrapi and similar libraries.
 *
 * Requires an authenticated session with proper device fingerprint.
 * More resilient than GraphQL but slightly slower.
 *
 * Priority: 2 (tried after Private API GraphQL fails)
 */
@Injectable()
export class InstagramMobileApiEngine implements Engine {
  private readonly logger = new Logger(InstagramMobileApiEngine.name);

  readonly name: EngineType = 'mobile-api';
  readonly priority = 2;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async extract(url: string, session?: Session): Promise<ExtractionResult> {
    const startTime = Date.now();

    if (!session) {
      return this.errorResult(url, startTime, 'NO_SESSION', 'Mobile API requires a session');
    }

    const shortcode = this.extractShortcode(url);
    if (!shortcode) {
      return this.errorResult(url, startTime, 'INVALID_URL', `Cannot extract shortcode from: ${url}`);
    }

    try {
      const mediaId = this.shortcodeToMediaId(shortcode);

      // Try /api/v1/media/{id}/info/ endpoint
      const response = await axios.get(
        `${INSTAGRAM.PRIVATE_API_URL}/media/${mediaId}/info/`,
        {
          headers: {
            ...session.headers,
            'Cookie': this.buildCookieString(session),
            'Accept': '*/*',
          },
          timeout: 15_000,
        },
      );

      const data = response.data;
      const mediaItem = data?.items?.[0];

      if (!mediaItem) {
        return this.errorResult(url, startTime, 'NO_DATA', 'Mobile API returned no items');
      }

      const items = this.parseMediaItems(mediaItem);
      const metadata = this.parseMetadata(mediaItem, shortcode);

      return {
        success: true,
        platform: 'instagram',
        sourceUrl: url,
        engine: this.name,
        accountId: session.accountId,
        items,
        metadata,
        durationMs: Date.now() - startTime,
        extractedAt: new Date().toISOString(),
      };
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;

      if (status === 429) {
        return this.errorResult(url, startTime, 'RATE_LIMITED', 'Rate limit hit on Mobile API', true);
      }
      if (status === 401 || status === 403) {
        return this.errorResult(url, startTime, 'AUTH_FAILED', 'Mobile API session expired', true);
      }
      if (status === 400) {
        const data = axiosErr.response?.data as any;
        if (data?.checkpoint_url || data?.message === 'checkpoint_required') {
          return this.errorResult(url, startTime, 'CHECKPOINT', 'Checkpoint challenge on Mobile API', false);
        }
        if (data?.message === 'login_required') {
          return this.errorResult(url, startTime, 'AUTH_FAILED', 'Login required on Mobile API', true);
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      return this.errorResult(url, startTime, 'FETCH_ERROR', message, true);
    }
  }

  /**
   * Parse media items from Mobile API response.
   * Mobile API returns a different structure than GraphQL.
   */
  private parseMediaItems(media: any): MediaItem[] {
    const items: MediaItem[] = [];

    // Carousel (carousel_media array)
    if (media.carousel_media?.length) {
      for (const item of media.carousel_media) {
        items.push(this.parseOneItem(item));
      }
      return items;
    }

    // Single media
    items.push(this.parseOneItem(media));
    return items;
  }

  private parseOneItem(item: any): MediaItem {
    const isVideo = item.media_type === 2 || item.video_versions?.length > 0;

    if (isVideo) {
      // video_versions sorted by quality (highest first)
      const bestVideo = item.video_versions?.[0];
      const bestImage = item.image_versions2?.candidates?.[0];

      return {
        url: bestVideo?.url || '',
        type: 'video',
        width: bestVideo?.width || item.original_width,
        height: bestVideo?.height || item.original_height,
        duration: item.video_duration,
        thumbnail: bestImage?.url,
        quality: this.inferQuality(bestVideo?.height),
      };
    }

    // Image
    const bestImage = item.image_versions2?.candidates?.[0];
    return {
      url: bestImage?.url || '',
      type: 'image',
      width: bestImage?.width || item.original_width,
      height: bestImage?.height || item.original_height,
    };
  }

  private parseMetadata(media: any, shortcode: string): ExtractionMetadata {
    return {
      postId: media.pk?.toString() || media.id,
      shortcode,
      authorUsername: media.user?.username,
      authorId: media.user?.pk?.toString(),
      caption: media.caption?.text,
      likeCount: media.like_count,
      commentCount: media.comment_count,
      viewCount: media.view_count || media.play_count,
      timestamp: media.taken_at
        ? new Date(media.taken_at * 1000).toISOString()
        : undefined,
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

  private shortcodeToMediaId(shortcode: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let mediaId = BigInt(0);

    for (const char of shortcode) {
      mediaId = mediaId * BigInt(64) + BigInt(alphabet.indexOf(char));
    }

    return mediaId.toString();
  }

  private buildCookieString(session: Session): string {
    return Object.entries(session.cookies.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
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
