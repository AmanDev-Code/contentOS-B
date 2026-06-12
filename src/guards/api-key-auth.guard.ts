import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService, type ValidatedApiKey } from '../services/api-key.service';
import { CacheService } from '../services/cache.service';
import { API_SCOPE_KEY } from '../decorators/api-scope.decorator';

export interface ApiKeyAuthedRequest {
  user?: { id: string };
  apiKey?: ValidatedApiKey;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Authenticates Public API v1 requests via `Authorization: Bearer trnd_*`.
 *
 * Responsibilities (Sprint 1.8):
 *  1. Resolve the key -> owning user (401 on missing/invalid/revoked/expired).
 *  2. Enforce per-key, per-hour rate limiting (429 when exceeded), emitting
 *     standard `X-RateLimit-*` headers.
 *  3. Enforce endpoint scopes declared via `@RequireApiScope(...)` (403).
 *
 * Sets `request.user = { id }` so reused downstream services that read
 * `req.user.id` work unchanged, plus `request.apiKey` for scope-aware handlers.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly cacheService: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<ApiKeyAuthedRequest>();
    const response = http.getResponse<{
      header?: (name: string, value: string | number) => unknown;
      setHeader?: (name: string, value: string | number) => unknown;
    }>();

    const rawKey = this.extractBearer(request);
    if (!rawKey) {
      throw new UnauthorizedException(
        'Missing API key. Provide "Authorization: Bearer trnd_...".',
      );
    }

    const validated = await this.apiKeyService.validateKey(rawKey);
    if (!validated) {
      throw new UnauthorizedException('Invalid or revoked API key.');
    }

    // --- Rate limiting (fixed 1-hour window per key) ---
    const windowSeconds = 3600;
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const rlKey = `apikey:rl:${validated.keyId}:${bucket}`;
    const limit = validated.rateLimitPerHour;
    const used = await this.cacheService.incr(rlKey, windowSeconds);
    const remaining = Math.max(0, limit - used);
    const resetEpoch = (bucket + 1) * windowSeconds;

    this.setHeader(response, 'X-RateLimit-Limit', limit);
    this.setHeader(response, 'X-RateLimit-Remaining', remaining);
    this.setHeader(response, 'X-RateLimit-Reset', resetEpoch);
    this.setHeader(response, 'X-RateLimit-Window', windowSeconds);

    if (used > limit) {
      const retryAfter = resetEpoch - Math.floor(Date.now() / 1000);
      this.setHeader(response, 'Retry-After', Math.max(1, retryAfter));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Rate limit exceeded: ${limit} requests/hour. Retry after ${Math.max(1, retryAfter)}s.`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // --- Scope enforcement ---
    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(API_SCOPE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (requiredScopes.length > 0) {
      const granted = new Set(validated.scopes);
      const missing = requiredScopes.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        throw new ForbiddenException(
          `API key is missing required scope(s): ${missing.join(', ')}.`,
        );
      }
    }

    request.user = { id: validated.userId };
    request.apiKey = validated;
    return true;
  }

  private extractBearer(request: ApiKeyAuthedRequest): string | undefined {
    const header = request.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return undefined;
    const [type, token] = value.split(' ');
    return type === 'Bearer' && token ? token.trim() : undefined;
  }

  private setHeader(
    response: {
      header?: (name: string, value: string | number) => unknown;
      setHeader?: (name: string, value: string | number) => unknown;
    },
    name: string,
    value: string | number,
  ): void {
    try {
      if (typeof response.header === 'function') {
        response.header(name, value);
      } else if (typeof response.setHeader === 'function') {
        response.setHeader(name, value);
      }
    } catch {
      // header set is best-effort; never block the request on it
    }
  }
}
