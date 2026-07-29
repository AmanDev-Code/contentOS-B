import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  RateLimiterRedis,
  RateLimiterMemory,
  RateLimiterRes,
  IRateLimiterStoreOptions,
} from 'rate-limiter-flexible';
import {
  CORE_LIMITS,
  API_KEY_LIMITS,
  TOOL_LIMITS,
  GLOBAL_TOOL_LIMIT,
  type RateLimitConfig,
} from '../config/rate-limit.config';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  consumed: number;
  limit: number;
  retryAfterMs: number;
}

@Injectable()
export class RateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(RateLimiterService.name);
  private redis: Redis | null = null;

  /** Redis-backed limiters keyed by name */
  private limiters = new Map<string, RateLimiterRedis>();

  /** In-memory insurance limiter for fail-open (core product) */
  private insuranceLimiter: RateLimiterMemory;

  constructor(private readonly configService: ConfigService) {
    // Insurance limiter: generous fallback when Redis is unreachable
    this.insuranceLimiter = new RateLimiterMemory({
      points: 100,
      duration: 60, // 100 req per minute — safety net only
      keyPrefix: 'insurance',
    });
  }

  async onModuleInit() {
    try {
      const host = this.configService.get<string>('redis.host') || 'localhost';
      const port = this.configService.get<number>('redis.port') || 6379;
      const password =
        this.configService.get<string>('redis.password') || undefined;

      this.redis = new Redis({
        host,
        port,
        password,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3000),
        lazyConnect: true,
        enableOfflineQueue: false,
      });

      await this.redis.connect();
      this.logger.log(
        `RateLimiterService: Redis connected at ${host}:${port}`,
      );

      // Initialize all core product limiters
      for (const [name, config] of Object.entries(CORE_LIMITS)) {
        this.createLimiter(name, config);
      }

      // Initialize API key limiter
      this.createLimiter('apikey', API_KEY_LIMITS.default);

      // Initialize tool limiters
      for (const [name, config] of Object.entries(TOOL_LIMITS)) {
        this.createLimiter(`tool:${name}`, config);
      }

      // Initialize global tool limiter (per-IP across all tools)
      this.createLimiter('tool:global', GLOBAL_TOOL_LIMIT);

      this.logger.log(
        `RateLimiterService: Initialized ${this.limiters.size} limiters`,
      );
    } catch (error) {
      this.logger.error(
        `RateLimiterService: Redis connection failed: ${(error as Error).message}`,
      );
      this.logger.warn(
        'RateLimiterService: Running with insurance (memory) limiter only',
      );
      this.redis = null;
    }
  }

  /**
   * Consume points from a named limiter.
   *
   * @param limiterName - Registered limiter name (from config)
   * @param key - Unique identifier (userId, IP, apiKeyId)
   * @param points - Points to consume (default: 1)
   * @param failClosed - If true, reject when Redis is down. Default: false (fail-open)
   */
  async consume(
    limiterName: string,
    key: string,
    points = 1,
    failClosed = false,
  ): Promise<RateLimitResult> {
    const limiter = this.limiters.get(limiterName);

    if (!limiter) {
      // No limiter configured for this name — allow through
      this.logger.warn(
        `RateLimiterService: No limiter found for "${limiterName}", allowing request`,
      );
      return {
        allowed: true,
        remaining: -1,
        resetMs: 0,
        consumed: 0,
        limit: 0,
        retryAfterMs: 0,
      };
    }

    try {
      const res = await limiter.consume(key, points);
      return this.toResult(res, true, limiter);
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        // Rate limit exceeded
        return this.toResult(error, false, limiter);
      }

      // Redis error — use fallback strategy
      this.logger.error(
        `RateLimiterService: Redis error on "${limiterName}": ${(error as Error).message}`,
      );

      if (failClosed) {
        // Tools mode: reject on Redis failure
        return {
          allowed: false,
          remaining: 0,
          resetMs: 60000,
          consumed: 0,
          limit: 0,
          retryAfterMs: 60000,
        };
      }

      // Core product mode: fall back to memory limiter
      try {
        const res = await this.insuranceLimiter.consume(key, points);
        return {
          allowed: true,
          remaining: res.remainingPoints,
          resetMs: res.msBeforeNext,
          consumed: res.consumedPoints,
          limit: 100,
          retryAfterMs: 0,
        };
      } catch (insuranceError) {
        if (insuranceError instanceof RateLimiterRes) {
          return {
            allowed: false,
            remaining: 0,
            resetMs: insuranceError.msBeforeNext,
            consumed: insuranceError.consumedPoints,
            limit: 100,
            retryAfterMs: insuranceError.msBeforeNext,
          };
        }
        // Should never happen — allow through as last resort
        return {
          allowed: true,
          remaining: -1,
          resetMs: 0,
          consumed: 0,
          limit: 0,
          retryAfterMs: 0,
        };
      }
    }
  }

  /**
   * Get current rate limit status without consuming points.
   */
  async get(limiterName: string, key: string): Promise<RateLimitResult | null> {
    const limiter = this.limiters.get(limiterName);
    if (!limiter) return null;

    try {
      const res = await limiter.get(key);
      if (!res) {
        return {
          allowed: true,
          remaining: (limiter as any).points || 0,
          resetMs: 0,
          consumed: 0,
          limit: (limiter as any).points || 0,
          retryAfterMs: 0,
        };
      }
      const limit = (limiter as any).points || 0;
      return {
        allowed: res.remainingPoints > 0,
        remaining: res.remainingPoints,
        resetMs: res.msBeforeNext,
        consumed: res.consumedPoints,
        limit,
        retryAfterMs: res.remainingPoints <= 0 ? res.msBeforeNext : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a named rate limiter with given config.
   * Can be called at runtime to register dynamic limiters (e.g., per-plan API key limits).
   */
  createDynamicLimiter(name: string, config: RateLimitConfig): void {
    this.createLimiter(name, config);
  }

  /** Check if Redis is connected */
  isRedisConnected(): boolean {
    return this.redis?.status === 'ready';
  }

  private createLimiter(name: string, config: RateLimitConfig): void {
    if (!this.redis) return;

    const opts: IRateLimiterStoreOptions = {
      storeClient: this.redis,
      keyPrefix: `rl:${name}`,
      points: config.points,
      duration: config.durationSeconds,
      blockDuration: config.blockDurationSeconds || 0,
      insuranceLimiter: config.failClosed ? undefined : this.insuranceLimiter,
    };

    this.limiters.set(name, new RateLimiterRedis(opts));
  }

  private toResult(
    res: RateLimiterRes,
    allowed: boolean,
    limiter: RateLimiterRedis,
  ): RateLimitResult {
    const limit = (limiter as any).points || 0;
    return {
      allowed,
      remaining: Math.max(0, res.remainingPoints),
      resetMs: res.msBeforeNext,
      consumed: res.consumedPoints,
      limit,
      retryAfterMs: allowed ? 0 : res.msBeforeNext,
    };
  }
}
