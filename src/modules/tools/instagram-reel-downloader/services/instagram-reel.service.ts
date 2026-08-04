import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { CacheService } from '../../../../services/cache.service';
import {
  ScraperCredentialsService,
  EffectiveScraperCredentials,
} from '../../../../services/scrapers/scraper-credentials.service';
import { InstagramReelResult } from '../types';
import { EngineOrchestratorService, MediaEngineAlertService } from '../../../media-engine';

const CACHE_PREFIX = 'tool:ig-reel:';
const CACHE_TTL_SECONDS = 900; // 15 minutes — Instagram CDN tokens expire in ~30-60min
const URL_VALIDATION_TIMEOUT_MS = 3000; // 3s timeout for HEAD check

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
    private readonly alerts: MediaEngineAlertService,
  ) {}

  /**
   * Main entry: download reel metadata from an Instagram URL.
   * Now delegates to the Media Engine's multi-engine orchestrator.
   *
   * @param url The Instagram Reel URL
   * @param bustCache If true, skip the cache and force a fresh extraction.
   *                  Use this when the client detects an expired CDN URL
   *                  (video won't play, 403/410 on CDN) and needs a fresh one.
   */
  async downloadReel(
    url: string,
    bustCache = false,
  ): Promise<InstagramReelResult> {
    // Strip tracking params — Instagram only needs the path.
    // UTM/igsh params create different cache keys in the orchestrator and
    // can cause stale-URL issues when the same reel is fetched with/without params.
    const cleanUrl = this.normalizeInstagramUrl(url);
    const postId = this.extractPostId(cleanUrl);
    const cacheKey = `${CACHE_PREFIX}${postId}`;

    // Check cache (same key pattern as before — backward compatible)
    if (!bustCache) {
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        const result = cached as InstagramReelResult;

        // Validate CDN URL is still alive (Instagram URLs expire in 30-60min)
        const urlAlive = await this.validateVideoUrl(result.videoUrl);
        if (urlAlive) {
          this.logger.debug(`Cache hit for reel ${postId} — URL still alive`);
          this.alerts.emitCacheHit(cleanUrl);
          return result;
        }

        // Stale URL detected — purge cache and re-extract
        this.logger.warn(`Cache stale for reel ${postId} — CDN URL expired, re-extracting`);
        await this.cacheService.delete(cacheKey);
      }
    } else {
      this.logger.debug(`Cache bust requested for reel ${postId}`);
      await this.cacheService.delete(cacheKey);
    }

    // Delegate to the engine orchestrator (tries all engines in order)
    const extraction = await this.engineOrchestrator.extract(cleanUrl, 'instagram');

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
    await this.cacheService.set(cacheKey, result, CACHE_TTL_SECONDS);

    this.logger.log(
      `Reel ${postId} extracted via ${extraction.engine} in ${extraction.durationMs}ms`,
    );

    return result;
  }

  /**
   * Strip tracking/analytics query params from Instagram URLs.
   * Instagram only needs the path — UTM, igsh, etc. create cache fragmentation
   * and can cause stale-URL issues in the orchestrator's sha256-based cache.
   */
  private normalizeInstagramUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Keep only the path — no query params needed for Instagram content
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      // If URL parsing fails, at minimum strip query string
      return url.split('?')[0].replace(/\/+$/, '');
    }
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

  /**
   * Validate a cached video URL is still accessible.
   * Performs a HEAD request with a short timeout — if the CDN returns 4xx/5xx
   * or the request times out, the URL is considered expired.
   *
   * @returns true if the URL is still alive (2xx/3xx), false otherwise
   */
  private async validateVideoUrl(videoUrl: string): Promise<boolean> {
    try {
      const response = await axios.head(videoUrl, {
        timeout: URL_VALIDATION_TIMEOUT_MS,
        maxRedirects: 3,
        validateStatus: () => true, // Don't throw on any status
      });

      const alive = response.status >= 200 && response.status < 400;
      this.alerts.emitUrlValidation(
        videoUrl,
        alive ? 'alive' : 'expired',
        response.status,
      );

      if (!alive) {
        this.alerts.emitCacheStale(videoUrl, response.status);
      }

      return alive;
    } catch {
      // Timeout or network error — treat as expired
      this.alerts.emitUrlValidation(videoUrl, 'expired');
      this.alerts.emitCacheStale(videoUrl);
      return false;
    }
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
