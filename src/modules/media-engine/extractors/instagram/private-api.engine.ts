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
 * Instagram Private API Engine — GraphQL with doc_id POST.
 *
 * This is the PROVEN WORKING method. Uses Instagram's internal GraphQL
 * endpoint with documented doc_ids to fetch media info.
 *
 * Requires an authenticated session (cookies + headers from session pool).
 * Mimics the Instagram Android app making API calls.
 *
 * Priority: 1 (tried first — fastest and most reliable when sessions are healthy)
 */
@Injectable()
export class InstagramPrivateApiEngine implements Engine {
  private readonly logger = new Logger(InstagramPrivateApiEngine.name);

  readonly name: EngineType = 'private-api';
  readonly priority = 1;

  async isAvailable(): Promise<boolean> {
    // Always available as long as the service is running
    return true;
  }

  async extract(url: string, session?: Session): Promise<ExtractionResult> {
    const startTime = Date.now();

    if (!session) {
      return this.errorResult(url, startTime, 'NO_SESSION', 'Private API requires a session');
    }

    const shortcode = this.extractShortcode(url);
    if (!shortcode) {
      return this.errorResult(url, startTime, 'INVALID_URL', `Cannot extract shortcode from: ${url}`);
    }

    try {
      const mediaId = await this.shortcodeToMediaId(shortcode);
      const mediaInfo = await this.fetchMediaInfo(mediaId, session);

      if (!mediaInfo) {
        return this.errorResult(url, startTime, 'NO_DATA', 'GraphQL returned no media data');
      }

      const items = this.parseMediaItems(mediaInfo);
      const metadata = this.parseMetadata(mediaInfo, shortcode);

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
        return this.errorResult(url, startTime, 'RATE_LIMITED', 'Instagram rate limit hit', true);
      }
      if (status === 401 || status === 403) {
        return this.errorResult(url, startTime, 'AUTH_FAILED', 'Session authentication failed', true);
      }
      if (status === 400) {
        // Check for checkpoint/challenge
        const data = axiosErr.response?.data as any;
        if (data?.checkpoint_url || data?.message === 'checkpoint_required') {
          return this.errorResult(url, startTime, 'CHECKPOINT', 'Instagram checkpoint challenge', false);
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      return this.errorResult(url, startTime, 'FETCH_ERROR', message, true);
    }
  }

  /**
   * Fetch media info using GraphQL doc_id POST method.
   */
  private async fetchMediaInfo(mediaId: string, session: Session): Promise<any> {
    const variables = JSON.stringify({
      media_id: mediaId,
    });

    const response = await axios.post(
      INSTAGRAM.GRAPHQL_URL,
      new URLSearchParams({
        variables,
        doc_id: INSTAGRAM.DOC_IDS.MEDIA_INFO,
      }).toString(),
      {
        headers: {
          ...session.headers,
          'Cookie': this.buildCookieString(session),
          'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
          'X-FB-LSD': session.cookies.cookies['lsd'] || '',
        },
        timeout: 15_000,
      },
    );

    const data = response.data;

    // Navigate the GraphQL response structure
    return (
      data?.data?.xdt_shortcode_media ||
      data?.data?.shortcode_media ||
      data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ||
      null
    );
  }

  /**
   * Convert shortcode to numeric media ID.
   * Instagram uses a base64-like encoding for shortcodes.
   */
  private async shortcodeToMediaId(shortcode: string): Promise<string> {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let mediaId = BigInt(0);

    for (const char of shortcode) {
      mediaId = mediaId * BigInt(64) + BigInt(alphabet.indexOf(char));
    }

    return mediaId.toString();
  }

  /**
   * Parse media items from GraphQL response.
   */
  private parseMediaItems(media: any): MediaItem[] {
    const items: MediaItem[] = [];

    // Check if it's a carousel (sidecar)
    if (media.edge_sidecar_to_children?.edges) {
      for (const edge of media.edge_sidecar_to_children.edges) {
        const node = edge.node;
        items.push(this.nodeToMediaItem(node));
      }
      return items;
    }

    // Single media item
    items.push(this.nodeToMediaItem(media));
    return items;
  }

  /**
   * Convert a GraphQL node to a MediaItem.
   */
  private nodeToMediaItem(node: any): MediaItem {
    const isVideo = node.is_video || node.__typename === 'GraphVideo' || node.__typename === 'XDTGraphVideo';

    if (isVideo) {
      return {
        url: node.video_url || node.video_versions?.[0]?.url || '',
        type: 'video',
        width: node.dimensions?.width || node.original_width,
        height: node.dimensions?.height || node.original_height,
        duration: node.video_duration,
        thumbnail: node.display_url || node.image_versions2?.candidates?.[0]?.url,
        quality: this.inferQuality(node.dimensions?.height || node.original_height),
      };
    }

    return {
      url: node.display_url || node.image_versions2?.candidates?.[0]?.url || '',
      type: 'image',
      width: node.dimensions?.width || node.original_width,
      height: node.dimensions?.height || node.original_height,
    };
  }

  /**
   * Parse metadata from GraphQL response.
   */
  private parseMetadata(media: any, shortcode: string): ExtractionMetadata {
    return {
      postId: media.id || media.pk?.toString(),
      shortcode,
      authorUsername: media.owner?.username || media.user?.username,
      authorId: media.owner?.id || media.user?.pk?.toString(),
      caption:
        media.edge_media_to_caption?.edges?.[0]?.node?.text ||
        media.caption?.text ||
        undefined,
      likeCount: media.edge_media_preview_like?.count || media.like_count,
      commentCount: media.edge_media_to_comment?.count || media.comment_count,
      viewCount: media.video_view_count || media.view_count || media.play_count,
      timestamp: media.taken_at_timestamp
        ? new Date(media.taken_at_timestamp * 1000).toISOString()
        : media.taken_at
          ? new Date(media.taken_at * 1000).toISOString()
          : undefined,
    };
  }

  /**
   * Extract shortcode from various Instagram URL formats.
   */
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
