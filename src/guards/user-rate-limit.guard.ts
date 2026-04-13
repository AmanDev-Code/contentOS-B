import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { CacheService } from '../services/cache.service';
import {
  RATE_LIMIT_BY_PATH,
  resolveRateLimitEndpoint,
} from '../config/rate-limit.config';

interface AuthedRequest extends Request {
  user?: { id: string };
}

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);

  constructor(private readonly cacheService: CacheService) {}

  private applyHeaders(response: unknown, headers: Record<string, string>) {
    const res = response as {
      header?: (name: string, value: string) => unknown;
      setHeader?: (name: string, value: string) => unknown;
      raw?: { setHeader?: (name: string, value: string) => unknown };
    };
    for (const [name, value] of Object.entries(headers)) {
      if (typeof res.header === 'function') {
        res.header(name, value);
      } else if (typeof res.setHeader === 'function') {
        res.setHeader(name, value);
      } else if (typeof res.raw?.setHeader === 'function') {
        res.raw.setHeader(name, value);
      }
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<AuthedRequest>();
    const res = ctx.getResponse();

    const userId = req.user?.id;
    if (!userId) {
      return true;
    }

    const path =
      (req as { path?: string }).path ||
      (req.url ? String(req.url).split('?')[0] : '') ||
      '';
    const endpoint = resolveRateLimitEndpoint(path, RATE_LIMIT_BY_PATH);
    if (!endpoint) {
      return true;
    }
    const method = String((req as { method?: string }).method || 'GET').toUpperCase();
    // Safeguard read-heavy listing endpoints from accidental throttle loops (StrictMode, polling).
    if (
      method === 'GET' &&
      (endpoint === '/generation/content' || endpoint === '/content')
    ) {
      return true;
    }

    const config = RATE_LIMIT_BY_PATH[endpoint];
    const allowed = await this.checkRateLimit(userId, endpoint, config);
    if (!allowed) {
      this.logger.warn(
        `User rate limit exceeded for user ${userId} on ${endpoint}`,
      );
      const usage = await this.getCurrentUsage(userId, endpoint, config);
      this.applyHeaders(res, {
        'X-RateLimit-Limit': config.max.toString(),
        'X-RateLimit-Remaining': Math.max(
          0,
          config.max - usage.count,
        ).toString(),
        'X-RateLimit-Reset': usage.resetTime.toString(),
        'X-RateLimit-Window': config.windowMs.toString(),
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: config.message || 'Too many requests',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const usage = await this.getCurrentUsage(userId, endpoint, config);
    this.applyHeaders(res, {
      'X-RateLimit-Limit': config.max.toString(),
      'X-RateLimit-Remaining': Math.max(
        0,
        config.max - usage.count,
      ).toString(),
      'X-RateLimit-Reset': usage.resetTime.toString(),
      'X-RateLimit-Window': config.windowMs.toString(),
    });

    return true;
  }

  private async checkRateLimit(
    userId: string,
    endpoint: string,
    config: { windowMs: number; max: number },
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
    } catch (e) {
      this.logger.error(`User rate limit check failed: ${(e as Error).message}`);
      return true;
    }
  }

  private async getCurrentUsage(
    userId: string,
    endpoint: string,
    config: { windowMs: number; max: number },
  ): Promise<{ count: number; resetTime: number }> {
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
        (timestamp) => timestamp > windowStart,
      );
      return {
        count: validRequests.length,
        resetTime:
          validRequests.length === 0
            ? now + config.windowMs
            : Math.min(...validRequests) + config.windowMs,
      };
    } catch {
      return {
        count: 0,
        resetTime: Date.now() + config.windowMs,
      };
    }
  }
}
