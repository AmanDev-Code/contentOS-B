import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RateLimiterService } from '../services/rate-limiter.service';
import { TOOL_LIMITS, GLOBAL_TOOL_LIMIT } from '../config/rate-limit.config';
import { TOOL_CATEGORY_KEY } from '../decorators/tool-category.decorator';

/**
 * IP-based rate limit guard for free tools (no auth required).
 *
 * Applies two layers:
 *  1. Per-tool limiter (keyed by IP + tool slug)
 *  2. Global per-IP limiter (across all tools)
 *
 * Fails CLOSED when Redis is down — returns 503 to protect AI credits.
 */
@Injectable()
export class ToolRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(ToolRateLimitGuard.name);

  constructor(
    private readonly rateLimiterService: RateLimiterService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse();

    const clientIp = this.extractIp(req);
    const toolSlug = this.extractToolSlug(req);
    const toolCategory = this.resolveToolCategory(req, context);

    if (!toolSlug || !toolCategory) {
      return true;
    }

    // Layer 1: Global per-IP limit across all tools
    const globalResult = await this.rateLimiterService.consume(
      'tool:global',
      clientIp,
      1,
      true, // fail-closed
    );

    if (!globalResult.allowed) {
      this.emitHeaders(res, globalResult.limit, globalResult.remaining, globalResult.retryAfterMs);
      this.logger.warn(`Global tool rate limit exceeded for IP ${clientIp}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: GLOBAL_TOOL_LIMIT.message || 'Rate limit reached.',
          error: 'Too Many Requests',
          retryAfter: Math.ceil(globalResult.retryAfterMs / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Layer 2: Per-tool category limit
    const toolResult = await this.rateLimiterService.consume(
      `tool:${toolCategory}`,
      `${clientIp}:${toolSlug}`,
      1,
      true, // fail-closed
    );

    if (!toolResult.allowed) {
      const config = TOOL_LIMITS[toolCategory];
      const retryAfterSeconds = Math.max(1, Math.ceil(toolResult.retryAfterMs / 1000));

      this.emitHeaders(res, toolResult.limit, toolResult.remaining, toolResult.retryAfterMs);

      this.logger.warn(
        `Tool rate limit exceeded for IP ${clientIp} on ${toolSlug} (${toolCategory})`,
      );

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: config?.message || 'Rate limit reached. Please try again later.',
          error: 'Too Many Requests',
          retryAfter: retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Emit success headers
    this.emitHeaders(res, toolResult.limit, toolResult.remaining, 0);
    return true;
  }

  private extractIp(req: Request): string {
    // Trust X-Forwarded-For when behind reverse proxy (Traefik/Nginx)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded.split(',')[0];
      return first.trim();
    }
    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
  }

  private extractToolSlug(req: Request): string | null {
    // Expects route pattern: /api/tools/:slug/generate or /tools/:slug/generate
    const path = req.path || req.url?.split('?')[0] || '';
    const match = path.match(/\/tools\/([^/]+)/);
    return match ? match[1] : null;
  }

  /**
   * Resolve tool category from request.
   * Priority: route metadata (@ToolCategoryMeta) > req.__toolCategory > default 'text-ai'.
   */
  private resolveToolCategory(req: Request, context: ExecutionContext): string | null {
    // 1. Check route metadata (set via @ToolCategoryMeta decorator)
    const metaCategory = this.reflector.get<string>(
      TOOL_CATEGORY_KEY,
      context.getHandler(),
    );
    if (metaCategory && TOOL_LIMITS[metaCategory]) {
      return metaCategory;
    }

    // 2. Check if category is passed on the request (set by middleware)
    const category = (req as any).__toolCategory;
    if (category && TOOL_LIMITS[category]) {
      return category;
    }

    // Default to text-ai (most common tool type)
    return 'text-ai';
  }

  private emitHeaders(
    response: unknown,
    limit: number,
    remaining: number,
    retryAfterMs: number,
  ): void {
    const res = response as {
      header?: (name: string, value: string) => unknown;
      setHeader?: (name: string, value: string) => unknown;
      raw?: { setHeader?: (name: string, value: string) => unknown };
    };

    const headers: Record<string, string> = {
      'X-RateLimit-Limit': limit.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
    };

    if (retryAfterMs > 0) {
      headers['Retry-After'] = Math.max(1, Math.ceil(retryAfterMs / 1000)).toString();
    }

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
}
