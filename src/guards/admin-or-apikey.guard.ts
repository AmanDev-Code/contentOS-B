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
import {
  API_KEY_PLAINTEXT_PREFIX,
  ApiKeyService,
  type ValidatedApiKey,
} from '../services/api-key.service';
import { RateLimiterService } from '../services/rate-limiter.service';
import { SupabaseService } from '../services/supabase.service';
import { ProfileRepository } from '../repositories/profile.repository';
import { API_SCOPE_KEY } from '../decorators/api-scope.decorator';
import { isPlatformAdmin } from '../common/platform-admin';

/**
 * Request shape produced by this guard. Keeps `request.user` compatible with
 * both `AuthGuard`-authed and `ApiKeyAuthGuard`-authed downstream handlers
 * (they only read `req.user.id`), and adds `authMethod` for observability.
 */
export interface AdminOrApiKeyRequest {
  user?: {
    id: string;
    email: string;
    role?: string;
    authMethod: 'jwt' | 'apikey';
  };
  apiKey?: ValidatedApiKey;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
}

/**
 * Dual auth: accepts either
 *   (a) `Authorization: Bearer trnd_*` — validates the API key, enforces rate
 *       limits, checks endpoint scopes, and requires the owning user to be a
 *       platform admin; or
 *   (b) `Authorization: Bearer <supabase-jwt>` — validates the JWT via
 *       Supabase and requires the user to be a platform admin.
 *
 * Both paths land at the same identity model on `request.user`. JWT admins
 * bypass scope checks (they have full dashboard access); API-key admins must
 * carry the scope(s) declared via `@RequireApiScope(...)` for that endpoint.
 *
 * NOTE: This guard does NOT modify `ApiKeyAuthGuard` — the Public API v1 keeps
 * using that guard unchanged. This one is additive, used only on admin routes
 * that we want to expose to the MCP server.
 */
@Injectable()
export class AdminOrApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(AdminOrApiKeyGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly rateLimiterService: RateLimiterService,
    private readonly supabaseService: SupabaseService,
    private readonly profileRepository: ProfileRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AdminOrApiKeyRequest>();
    const response = http.getResponse<{
      header?: (name: string, value: string | number) => unknown;
      setHeader?: (name: string, value: string | number) => unknown;
    }>();

    const bearer = this.extractBearer(request);
    if (!bearer) {
      throw new UnauthorizedException(
        'Authentication required. Provide "Authorization: Bearer <jwt|trnd_...>".',
      );
    }

    if (bearer.startsWith(API_KEY_PLAINTEXT_PREFIX)) {
      return this.authorizeViaApiKey(context, request, response, bearer);
    }

    return this.authorizeViaJwt(request, bearer);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // API key path
  // ─────────────────────────────────────────────────────────────────────────

  private async authorizeViaApiKey(
    context: ExecutionContext,
    request: AdminOrApiKeyRequest,
    response: {
      header?: (name: string, value: string | number) => unknown;
      setHeader?: (name: string, value: string | number) => unknown;
    },
    rawKey: string,
  ): Promise<boolean> {
    const validated = await this.apiKeyService.validateKey(rawKey);
    if (!validated) {
      throw new UnauthorizedException('Invalid or revoked API key.');
    }

    // Rate limit per key (mirrors ApiKeyAuthGuard behaviour).
    const limit = validated.rateLimitPerHour;
    this.rateLimiterService.createDynamicLimiter(`apikey:${validated.keyId}`, {
      points: limit,
      durationSeconds: 3600,
      message: `Rate limit exceeded: ${limit} requests/hour.`,
    });
    const rlResult = await this.rateLimiterService.consume(
      `apikey:${validated.keyId}`,
      validated.keyId,
      1,
      false, // fail-open for API keys
    );
    const remaining = rlResult.remaining;
    const resetEpoch = Math.ceil((Date.now() + rlResult.resetMs) / 1000);
    this.setHeader(response, 'X-RateLimit-Limit', limit);
    this.setHeader(response, 'X-RateLimit-Remaining', remaining);
    this.setHeader(response, 'X-RateLimit-Reset', resetEpoch);
    this.setHeader(response, 'X-RateLimit-Window', 3600);
    if (!rlResult.allowed) {
      const retryAfter = Math.max(1, Math.ceil(rlResult.retryAfterMs / 1000));
      this.setHeader(response, 'Retry-After', retryAfter);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Rate limit exceeded: ${limit} requests/hour. Retry after ${retryAfter}s.`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Resolve the key's owning user so we can enforce platform-admin.
    const profile = await this.profileRepository.findById(validated.userId);
    const email =
      (profile as { email?: string } | null)?.email?.toString() ?? '';
    if (!isPlatformAdmin({ id: validated.userId, email })) {
      throw new ForbiddenException(
        'This API key does not belong to a platform admin.',
      );
    }

    // Scope enforcement (only for API-key auth — JWT admins are unrestricted).
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

    request.user = {
      id: validated.userId,
      email,
      role: 'admin',
      authMethod: 'apikey',
    };
    request.apiKey = validated;
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // JWT path
  // ─────────────────────────────────────────────────────────────────────────

  private async authorizeViaJwt(
    request: AdminOrApiKeyRequest,
    token: string,
  ): Promise<boolean> {
    let userId: string;
    let email: string;
    let role: string;
    try {
      const {
        data: { user },
        error,
      } = await this.supabaseService.getClient().auth.getUser(token);
      if (error || !user) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      userId = user.id;
      email = user.email || '';
      role = user.role || 'user';
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(
        `JWT verification failed: ${(err as Error)?.message ?? 'unknown'}`,
      );
      throw new UnauthorizedException('Authentication failed');
    }

    // Account status gate (mirrors AuthGuard): banned/suspended cannot write.
    const accountStatus = await this.profileRepository.getAccountStatus(userId);
    if (accountStatus === 'suspended' || accountStatus === 'banned') {
      const method = (request.method || 'GET').toUpperCase();
      const isSafeRead =
        method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      if (!isSafeRead) {
        throw new ForbiddenException(
          'This account cannot perform this action.',
        );
      }
    }

    if (!isPlatformAdmin({ id: userId, email })) {
      throw new ForbiddenException('Admin access required');
    }

    request.user = {
      id: userId,
      email,
      role,
      authMethod: 'jwt',
    };
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private extractBearer(request: AdminOrApiKeyRequest): string | undefined {
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
