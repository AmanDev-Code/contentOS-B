import {
  Injectable,
  NestMiddleware,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../services/cache.service';
import {
  RATE_LIMIT_BY_PATH,
  RateLimitRule,
  resolveRateLimitEndpoint,
} from '../config/rate-limit.config';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    sub: string;
  };
}

/**
 * Legacy/global middleware: `req.user` is only set after AuthGuard, which runs
 * after middleware, so this almost never applies limits for Bearer-auth API calls.
 * Per-user limits are enforced by {@link UserRateLimitGuard} on protected controllers.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);

  constructor(private readonly cacheService: CacheService) {}

  private applyHeaders(res: Response, headers: Record<string, string>) {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof (res as any).setHeader === 'function') {
        (res as any).setHeader(name, value);
      }
    }
  }

  async use(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user?.id) {
        return next();
      }

      const path =
        req.path || (req.url ? String(req.url).split('?')[0] : '') || '';
      const normalizedPath = path.replace(/\/+$/, '');
      const endpoint =
        resolveRateLimitEndpoint(normalizedPath, RATE_LIMIT_BY_PATH) ||
        normalizedPath;
      const rateLimitConfig = RATE_LIMIT_BY_PATH[endpoint];

      if (!rateLimitConfig) {
        return next();
      }

      const userId = req.user.id;
      const isAllowed = await this.checkRateLimit(
        userId,
        endpoint,
        rateLimitConfig,
      );

      if (!isAllowed) {
        this.logger.warn(
          `Rate limit exceeded for user ${userId} on endpoint ${endpoint}`,
        );

        const usage = await this.getCurrentUsage(
          userId,
          endpoint,
          rateLimitConfig,
        );

        this.applyHeaders(res, {
          'X-RateLimit-Limit': rateLimitConfig.max.toString(),
          'X-RateLimit-Remaining': Math.max(
            0,
            rateLimitConfig.max - usage.count,
          ).toString(),
          'X-RateLimit-Reset': usage.resetTime.toString(),
          'X-RateLimit-Window': rateLimitConfig.windowMs.toString(),
        });

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: rateLimitConfig.message || 'Too many requests',
            error: 'Too Many Requests',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const usage = await this.getCurrentUsage(
        userId,
        endpoint,
        rateLimitConfig,
      );
      this.applyHeaders(res, {
        'X-RateLimit-Limit': rateLimitConfig.max.toString(),
        'X-RateLimit-Remaining': Math.max(
          0,
          rateLimitConfig.max - usage.count,
        ).toString(),
        'X-RateLimit-Reset': usage.resetTime.toString(),
        'X-RateLimit-Window': rateLimitConfig.windowMs.toString(),
      });

      next();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error('Rate limiting error:', (error as Error).message);
      next();
    }
  }

  private async checkRateLimit(
    userId: string,
    endpoint: string,
    config: RateLimitRule,
  ): Promise<boolean> {
    const key = `rate_limit:v2:${userId}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      const windowData = await this.cacheService.get(key);

      if (!windowData) {
        await this.cacheService.set(
          key,
          JSON.stringify({
            count: 1,
            windowStart: now,
            requests: [now],
          }),
          Math.ceil(config.windowMs / 1000),
        );
        return true;
      }

      const data = JSON.parse(windowData as string);
      const validRequests = (data.requests as number[]).filter(
        (timestamp) => timestamp > windowStart,
      );

      if (validRequests.length >= config.max) {
        return false;
      }

      validRequests.push(now);

      await this.cacheService.set(
        key,
        JSON.stringify({
          count: validRequests.length,
          windowStart: Math.min(data.windowStart, windowStart),
          requests: validRequests,
        }),
        Math.ceil(config.windowMs / 1000),
      );

      return true;
    } catch (error) {
      this.logger.error(`Rate limit check failed: ${(error as Error).message}`);
      return true;
    }
  }

  private async getCurrentUsage(
    userId: string,
    endpoint: string,
    config: RateLimitRule,
  ): Promise<{
    count: number;
    resetTime: number;
  }> {
    const key = `rate_limit:v2:${userId}:${endpoint}`;

    try {
      const windowData = await this.cacheService.get(key);

      if (!windowData) {
        return {
          count: 0,
          resetTime: Date.now() + config.windowMs,
        };
      }

      const data = JSON.parse(windowData as string);
      const now = Date.now();
      const windowStart = now - config.windowMs;

      const validRequests = (data.requests as number[]).filter(
        (timestamp: number) => timestamp > windowStart,
      );

      return {
        count: validRequests.length,
        resetTime:
          validRequests.length === 0
            ? now + config.windowMs
            : Math.min(...validRequests) + config.windowMs,
      };
    } catch (error) {
      this.logger.error(`Failed to get current usage: ${(error as Error).message}`);
      return {
        count: 0,
        resetTime: Date.now() + config.windowMs,
      };
    }
  }

  async getRateLimitStatus(
    userId: string,
    endpoint: string,
  ): Promise<{
    limit: number;
    remaining: number;
    resetTime: number;
    windowMs: number;
  }> {
    const config = RATE_LIMIT_BY_PATH[endpoint];

    if (!config) {
      return {
        limit: 0,
        remaining: 0,
        resetTime: 0,
        windowMs: 0,
      };
    }

    const usage = await this.getCurrentUsage(userId, endpoint, config);

    return {
      limit: config.max,
      remaining: Math.max(0, config.max - usage.count),
      resetTime: usage.resetTime,
      windowMs: config.windowMs,
    };
  }
}
