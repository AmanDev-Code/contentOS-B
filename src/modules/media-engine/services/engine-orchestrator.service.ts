import { Injectable, Logger } from '@nestjs/common';

import {
  Engine,
  EngineType,
  EngineStatus,
  ExtractionResult,
  ExtractionError,
  Platform,
  Session,
  REDIS_KEYS,
} from '../core';
import { CacheService } from '../../../services/cache.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { SessionPoolService } from './session-pool.service';
import { CooldownManagerService } from './cooldown-manager.service';
import { MediaEngineAlertService } from './alert.service';

/**
 * Engine Orchestrator — The heart of the media extraction system.
 *
 * Tries engines in priority order with full fallback chain:
 * Request → Engine A (Private API) → fail? → Engine B (Mobile API) → fail? → Engine C (Browser) → fail? → Report
 *
 * Integrates with:
 * - Circuit Breaker: Skip engines with open circuits
 * - Session Pool: Acquire/release sessions for authenticated engines
 * - Cooldown Manager: Respect per-account throttling
 * - URL Cache: Skip extraction if result is already cached
 */
@Injectable()
export class EngineOrchestratorService {
  private readonly logger = new Logger(EngineOrchestratorService.name);
  private readonly engines: Map<EngineType, Engine> = new Map();

  constructor(
    private readonly cache: CacheService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly sessionPool: SessionPoolService,
    private readonly cooldownManager: CooldownManagerService,
    private readonly alerts: MediaEngineAlertService,
  ) {}

  /**
   * Register an engine with the orchestrator.
   * Engines are tried in priority order (lower = first).
   */
  registerEngine(engine: Engine): void {
    this.engines.set(engine.name, engine);
    this.logger.log(`Registered engine: ${engine.name} (priority: ${engine.priority})`);
  }

  /**
   * Extract media from a URL using the engine chain.
   * Tries each engine in priority order, skipping those with open circuits.
   * Returns the first successful result, or a combined error.
   */
  async extract(url: string, platform: Platform): Promise<ExtractionResult> {
    const startTime = Date.now();

    // Check URL cache first
    const cached = await this.getCachedResult(url);
    if (cached) {
      this.logger.debug(`Cache hit for URL: ${url}`);
      return cached;
    }

    // Get engines sorted by priority
    const sortedEngines = this.getSortedEngines();

    if (sortedEngines.length === 0) {
      return this.buildErrorResult(url, platform, startTime, {
        code: 'NO_ENGINES',
        message: 'No extraction engines registered',
        retryable: false,
      });
    }

    const errors: ExtractionError[] = [];

    for (const engine of sortedEngines) {
      // Check circuit breaker
      const allowed = await this.circuitBreaker.isAllowed(engine.name);
      if (!allowed) {
        this.logger.debug(`Circuit OPEN for engine: ${engine.name}, skipping`);
        errors.push({
          code: 'CIRCUIT_OPEN',
          message: `Engine ${engine.name} circuit is open`,
          retryable: true,
          engine: engine.name,
        });
        continue;
      }

      // Check engine availability
      const available = await engine.isAvailable();
      if (!available) {
        this.logger.debug(`Engine ${engine.name} not available, skipping`);
        errors.push({
          code: 'ENGINE_UNAVAILABLE',
          message: `Engine ${engine.name} is not available`,
          retryable: true,
          engine: engine.name,
        });
        continue;
      }

      // Acquire session for authenticated engines
      let session: Session | null = null;
      if (this.requiresSession(engine.name)) {
        session = await this.sessionPool.acquire(platform);
        if (!session) {
          this.logger.warn(`No sessions available for engine: ${engine.name}`);
          errors.push({
            code: 'NO_SESSION',
            message: `No available session for engine ${engine.name}`,
            retryable: true,
            engine: engine.name,
          });
          continue;
        }

        // Respect cooldown
        await this.cooldownManager.waitForSlot(session.accountId);
        await this.cooldownManager.recordRequest(session.accountId);
      }

      try {
        // Attempt extraction
        const result = await engine.extract(url, session ?? undefined);

        if (result.success) {
          // Record success
          await this.circuitBreaker.recordSuccess(engine.name);
          if (session) {
            await this.sessionPool.release(session, { success: true });
          }

          // Cache the result
          await this.cacheResult(url, result);

          this.logger.log(
            `Extraction success via ${engine.name} for ${url} (${Date.now() - startTime}ms)`,
          );
          this.alerts.emitExtractionSuccess(url, engine.name, session?.accountId, Date.now() - startTime);
          return result;
        }

        // Engine returned a non-success result
        await this.circuitBreaker.recordFailure(engine.name);
        if (session) {
          await this.sessionPool.release(session, {
            success: false,
            rateLimited: result.error?.code === 'RATE_LIMITED',
            checkpoint: result.error?.code === 'CHECKPOINT',
          });
        }

        if (result.error) {
          errors.push(result.error);
        }
      } catch (err) {
        // Unhandled error from engine
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.error(`Engine ${engine.name} threw: ${errorMessage}`);

        await this.circuitBreaker.recordFailure(engine.name);
        if (session) {
          await this.sessionPool.release(session, { success: false });
        }

        errors.push({
          code: 'ENGINE_ERROR',
          message: `${engine.name}: ${errorMessage}`,
          retryable: true,
          engine: engine.name,
        });
      }
    }

    // All engines failed
    this.logger.error(`All engines failed for URL: ${url}`);
    this.alerts.emitAllEnginesFailed(url, platform, errors.map((e) => `[${e.engine}] ${e.code}: ${e.message}`));
    return this.buildErrorResult(url, platform, startTime, {
      code: 'ALL_ENGINES_FAILED',
      message: `All ${sortedEngines.length} engines failed: ${errors.map((e) => `[${e.engine}] ${e.code}`).join(', ')}`,
      retryable: errors.some((e) => e.retryable),
    });
  }

  /**
   * Get status of all registered engines.
   */
  async getEngineStatus(): Promise<EngineStatus[]> {
    const statuses: EngineStatus[] = [];

    for (const [, engine] of this.engines) {
      const circuitState = await this.circuitBreaker.getState(engine.name);
      const available = await engine.isAvailable();

      statuses.push({
        name: engine.name,
        available,
        circuitState: circuitState.state,
        successRate: this.calculateSuccessRate(circuitState.failures),
        lastUsed: circuitState.lastFailure, // Approximation
      });
    }

    return statuses;
  }

  /**
   * Get a specific engine by type.
   */
  getEngine(type: EngineType): Engine | undefined {
    return this.engines.get(type);
  }

  /**
   * Get all registered engines sorted by priority.
   */
  private getSortedEngines(): Engine[] {
    return Array.from(this.engines.values()).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Check if an engine type requires an authenticated session.
   */
  private requiresSession(engineType: EngineType): boolean {
    // Private API and Mobile API require sessions; Browser and embed may not
    return engineType === 'private-api' || engineType === 'mobile-api';
  }

  /**
   * Get cached extraction result for a URL.
   */
  private async getCachedResult(url: string): Promise<ExtractionResult | null> {
    const key = `${REDIS_KEYS.URL_CACHE}:${this.hashUrl(url)}`;
    return (await this.cache.get(key)) as ExtractionResult | null;
  }

  /**
   * Cache an extraction result.
   */
  private async cacheResult(url: string, result: ExtractionResult): Promise<void> {
    const key = `${REDIS_KEYS.URL_CACHE}:${this.hashUrl(url)}`;
    // Cache for 1 hour — media URLs expire
    await this.cache.set(key, result, 3600);
  }

  /**
   * Simple URL hash for cache keys.
   */
  private hashUrl(url: string): string {
    const { createHash } = require('crypto');
    return createHash('sha256').update(url).digest('hex').slice(0, 16);
  }

  private calculateSuccessRate(failures: number): number {
    // Rough approximation — would be better with actual metrics
    if (failures === 0) return 1;
    return Math.max(0, 1 - failures * 0.2);
  }

  private buildErrorResult(
    url: string,
    platform: Platform,
    startTime: number,
    error: ExtractionError,
  ): ExtractionResult {
    return {
      success: false,
      platform,
      sourceUrl: url,
      engine: 'private-api', // Default; doesn't matter for error results
      items: [],
      error,
      durationMs: Date.now() - startTime,
      extractedAt: new Date().toISOString(),
    };
  }
}
