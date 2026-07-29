import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { RateLimiterService } from '../services/rate-limiter.service';
import { CORE_LIMITS, resolvePathToLimiter } from '../config/rate-limit.config';

interface AuthedRequest extends Request {
  user?: { id: string };
}

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);

  constructor(private readonly rateLimiterService: RateLimiterService) {}

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

    const limiterName = resolvePathToLimiter(path);
    if (!limiterName) {
      return true;
    }

    // Bypass GET requests on read-heavy listing endpoints to avoid throttle loops
    const method = String(
      (req as { method?: string }).method || 'GET',
    ).toUpperCase();
    if (
      method === 'GET' &&
      (limiterName === 'gen-content' || limiterName === 'content')
    ) {
      return true;
    }

    const config = CORE_LIMITS[limiterName];
    const result = await this.rateLimiterService.consume(
      limiterName,
      userId,
      1,
      false, // fail-open for core product
    );

    // Always emit rate limit headers
    const resetEpoch = Math.ceil(Date.now() + result.resetMs);
    this.applyHeaders(res, {
      'X-RateLimit-Limit': (config?.points || result.limit).toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': resetEpoch.toString(),
      'X-RateLimit-Window': (
        (config?.durationSeconds || 3600) * 1000
      ).toString(),
    });

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(result.retryAfterMs / 1000),
      );

      this.applyHeaders(res, {
        'Retry-After': retryAfterSeconds.toString(),
      });

      this.logger.warn(
        `User rate limit exceeded for user ${userId} on ${limiterName}`,
      );

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: config?.message || 'Too many requests',
          error: 'Too Many Requests',
          retryAfter: retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
