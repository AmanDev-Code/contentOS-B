import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../../services/cache.service';
import {
  ScraperCredentialsService,
  EffectiveScraperCredentials,
} from '../../../services/scrapers/scraper-credentials.service';
import { InstagramReelResult } from '../registry/tool.types';
import { EngineOrchestratorService } from '../../media-engine';

const CACHE_PREFIX = 'tool:ig-reel:';
const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Instagram Reel Service — Public API facade.
 *
 * Delegates to the Media Engine's EngineOrchestratorService for extraction.
 * Maintains the same public interface (downloadReel → InstagramReelResult)
 * so existing controllers and consumers don't need changes.
 *
 * The old single-strategy code is replaced by:
 *   Request → EngineOrchestrator → Private API → Mobile API → Browser → Result
 */
@Injectable()
export class InstagramReelService {
  private readonly logger = new Logger(InstagramReelService.name);

  constructor(
    private readonly cacheService: CacheService,
    private readonly credentials: ScraperCredentialsService,
    private readonly engineOrchestrator: EngineOrchestratorService,
  ) {}

  /**
   * Main entry: download reel metadata from an Instagram URL.
   * Now delegates to the Media Engine's multi-engine orchestrator.
   */
  async downloadReel(url: string): Promise<InstagramReelResult> {
    const postId = this.extractPostId(url);

    // Check cache (same key pattern as before — backward compatible)
    const cached = await this.cacheService.get(`${CACHE_PREFIX}${postId}`);
    if (cached) {
      this.logger.debug(`Cache hit for reel ${postId}`);
      return cached as InstagramReelResult;
    }

    // Delegate to the engine orchestrator (tries all engines in order)
    const extraction = await this.engineOrchestrator.extract(url, 'instagram');

    if (!extraction.success || extraction.items.length === 0) {
      throw new InstagramFetchError(
        extraction.error?.message ||
          'Could not extract the video. Make sure the Reel is public and the URL is correct.',
      );
    }

    // Find the video item (prefer video over image)
    const videoItem = extraction.items.find((i) => i.type === 'video');
    const item = videoItem || extraction.items[0];

    if (!videoItem) {
      throw new InstagramFetchError(
        'This post is not a video/reel. Only video content can be downloaded.',
      );
    }

    // Map to the existing InstagramReelResult shape
    const result: InstagramReelResult = {
      videoUrl: item.url,
      thumbnailUrl: item.thumbnail || null,
      width: item.width || 1080,
      height: item.height || 1920,
      caption: extraction.metadata?.caption || null,
      author: extraction.metadata?.authorUsername || null,
      duration: item.duration || null,
    };

    // Cache result
    await this.cacheService.set(`${CACHE_PREFIX}${postId}`, result, CACHE_TTL_SECONDS);

    this.logger.log(
      `Reel ${postId} extracted via ${extraction.engine} in ${extraction.durationMs}ms`,
    );

    return result;
  }

  /**
   * Extract post shortcode from various Instagram URL formats.
   */
  extractPostId(url: string): string {
    const clean = url.split('?')[0].replace(/\/+$/, '');

    const patterns = [
      /instagram\.com\/reels?\/([a-zA-Z0-9_-]+)/,
      /instagram\.com\/p\/([a-zA-Z0-9_-]+)/,
      /instagram\.com\/tv\/([a-zA-Z0-9_-]+)/,
    ];

    for (const pattern of patterns) {
      const match = clean.match(pattern);
      if (match?.[1]) return match[1];
    }

    throw new InstagramFetchError(
      'Could not extract post ID from URL. Use a link like instagram.com/reel/ABC123',
    );
  }
}

/**
 * Custom error for Instagram fetch failures.
 */
export class InstagramFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstagramFetchError';
  }
}
