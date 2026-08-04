import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { SupabaseService } from './supabase.service';

/**
 * Public API key management (Sprint 1.8 — Public API v1).
 *
 * Storage shape (table `public.api_keys`, created Sprint 1.2):
 *   - `key_prefix` — the leading, NON-secret slice of the full key, indexed for
 *     O(1) lookup (e.g. `trnd_a1b2c3d`). Stored in plaintext on purpose.
 *   - `key_hash`   — SHA-256 of the FULL key. Compared constant-time. The full
 *     plaintext key is returned exactly ONCE at creation and never persisted.
 *
 * Key format: `trnd_<urlsafe-secret>`. Auth header is RFC-compliant
 * `Authorization: Bearer trnd_...` (founder decision #1046/#1070 — unlike
 * Postiz's bare header, which is not used here. Zero Postiz code copied.).
 */

export const API_KEY_PLAINTEXT_PREFIX = 'trnd_';
/** Length of the stored, indexed public prefix (`trnd_` + 7 random chars). */
const PREFIX_LENGTH = 12;
/** Random secret bytes -> base64url. 24 bytes ≈ 32 url-safe chars of entropy. */
const SECRET_BYTES = 24;

/** Capability scopes recognised by the v1 API guard. */
export const API_SCOPES = [
  'posts:read',
  'posts:write',
  'accounts:read',
  'accounts:write',
  'media:write',
  // Admin-only scopes — issuance is gated in ApiKeysController and enforced on
  // admin endpoints via AdminOrApiKeyGuard. Used by the Trndinn Blog MCP server.
  'blog:read',
  'blog:write',
  'content-engine:read',
  'content-engine:write',
  'seo:read',
  'seo:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * Scopes that only platform admins may put on an API key. Issuance is enforced
 * at the create endpoint (`POST /api-keys`).
 */
export const ADMIN_ONLY_SCOPES: readonly ApiScope[] = [
  'blog:read',
  'blog:write',
  'content-engine:read',
  'content-engine:write',
  'seo:read',
  'seo:write',
] as const;

export function isAdminOnlyScope(scope: string): boolean {
  return (ADMIN_ONLY_SCOPES as readonly string[]).includes(scope);
}

export const DEFAULT_API_SCOPES: ApiScope[] = [
  'posts:read',
  'posts:write',
  'accounts:read',
  'media:write',
];

/**
 * Per-plan hourly rate limits applied to a key at creation time. Persisted to
 * `api_keys.rate_limit_per_hour` so enforcement reads a single source of truth
 * (founder decision: tiered by plan — Solo 30 / Growth 100 / Agency 300).
 */
export const PLAN_RATE_LIMIT_PER_HOUR: Record<string, number> = {
  free: 30,
  starter: 30,
  solo: 30,
  pro: 100,
  growth: 100,
  agency: 300,
  enterprise: 300,
};
const DEFAULT_RATE_LIMIT_PER_HOUR = 100;

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerHour: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** Full plaintext key. Shown ONCE — never retrievable again. */
  plaintextKey: string;
}

export interface ValidatedApiKey {
  keyId: string;
  userId: string;
  scopes: string[];
  rateLimitPerHour: number;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[] | null;
  rate_limit_per_hour: number | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** SHA-256 hex of the full key. One-way; never reversible. */
  private hashKey(fullKey: string): string {
    return createHash('sha256').update(fullKey, 'utf8').digest('hex');
  }

  private generatePlaintextKey(): { fullKey: string; prefix: string } {
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const fullKey = `${API_KEY_PLAINTEXT_PREFIX}${secret}`;
    const prefix = fullKey.slice(0, PREFIX_LENGTH);
    return { fullKey, prefix };
  }

  /**
   * Create a new API key for a user. Returns the full plaintext key ONCE.
   * `rateLimitPerHour` defaults from the user's plan tier when not supplied.
   */
  async createKey(
    userId: string,
    params: {
      name: string;
      scopes?: string[];
      rateLimitPerHour?: number;
      planType?: string;
      expiresAt?: string | null;
    },
  ): Promise<CreatedApiKey> {
    const client = this.supabase.getServiceClient();

    const scopes = this.normalizeScopes(params.scopes);
    const rateLimitPerHour =
      params.rateLimitPerHour ??
      (params.planType
        ? (PLAN_RATE_LIMIT_PER_HOUR[params.planType.toLowerCase()] ??
          DEFAULT_RATE_LIMIT_PER_HOUR)
        : DEFAULT_RATE_LIMIT_PER_HOUR);

    // Retry on the (very unlikely) prefix collision against the UNIQUE index.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { fullKey, prefix } = this.generatePlaintextKey();
      const keyHash = this.hashKey(fullKey);

      const { data, error } = await client
        .from('api_keys')
        .insert({
          user_id: userId,
          name: params.name,
          key_prefix: prefix,
          key_hash: keyHash,
          scopes,
          rate_limit_per_hour: rateLimitPerHour,
          expires_at: params.expiresAt ?? null,
        })
        .select(
          'id, user_id, name, key_prefix, scopes, rate_limit_per_hour, last_used_at, expires_at, revoked_at, created_at',
        )
        .single();

      if (!error && data) {
        return {
          ...this.mapRow(data as ApiKeyRow),
          plaintextKey: fullKey,
        };
      }

      if ((error as { code?: string })?.code === '23505') {
        // prefix collision — regenerate and retry
        lastError = error;
        continue;
      }
      throw new Error(
        `Failed to create API key: ${(error as { message?: string })?.message ?? 'unknown error'}`,
      );
    }
    throw new Error(
      `Failed to create API key after retries: ${(lastError as { message?: string })?.message ?? 'prefix collision'}`,
    );
  }

  /**
   * Validate a raw `trnd_*` key. Returns the owning user + scopes + limit, or
   * null when the key is unknown, revoked, or expired. Uses prefix lookup then
   * a constant-time hash comparison (never leaks which step failed).
   */
  async validateKey(rawKey: string): Promise<ValidatedApiKey | null> {
    if (!rawKey || !rawKey.startsWith(API_KEY_PLAINTEXT_PREFIX)) {
      return null;
    }
    const prefix = rawKey.slice(0, PREFIX_LENGTH);
    const client = this.supabase.getServiceClient();

    const { data, error } = await client
      .from('api_keys')
      .select(
        'id, user_id, name, key_prefix, key_hash, scopes, rate_limit_per_hour, last_used_at, expires_at, revoked_at, created_at',
      )
      .eq('key_prefix', prefix)
      .is('revoked_at', null)
      .maybeSingle();

    if (error) {
      this.logger.warn(`API key lookup failed: ${error.message}`);
      return null;
    }
    if (!data) return null;

    const row = data;

    if (!this.constantTimeEquals(this.hashKey(rawKey), row.key_hash)) {
      return null;
    }

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    // Best-effort last_used_at touch (throttled to once/min to avoid write churn).
    void this.touchLastUsed(row.id, row.last_used_at);

    return {
      keyId: row.id,
      userId: row.user_id,
      scopes: row.scopes ?? [],
      rateLimitPerHour: row.rate_limit_per_hour ?? DEFAULT_RATE_LIMIT_PER_HOUR,
    };
  }

  async listKeys(userId: string): Promise<ApiKeyRecord[]> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('api_keys')
      .select(
        'id, user_id, name, key_prefix, scopes, rate_limit_per_hour, last_used_at, expires_at, revoked_at, created_at',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Failed to list API keys: ${error.message}`);
    return (data ?? []).map((r) => this.mapRow(r as ApiKeyRow));
  }

  /** Soft-revoke: sets `revoked_at`. The row is retained for audit. */
  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Failed to revoke API key: ${error.message}`);
    return Boolean(data);
  }

  private normalizeScopes(scopes?: string[]): string[] {
    if (!scopes || scopes.length === 0) return [...DEFAULT_API_SCOPES];
    const allowed = new Set<string>(API_SCOPES);
    const filtered = scopes.filter((s) => allowed.has(s));
    return filtered.length > 0 ? filtered : [...DEFAULT_API_SCOPES];
  }

  private constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private async touchLastUsed(
    keyId: string,
    lastUsedAt: string | null,
  ): Promise<void> {
    try {
      if (lastUsedAt && Date.now() - new Date(lastUsedAt).getTime() < 60_000) {
        return; // throttle: at most one write per minute
      }
      await this.supabase
        .getServiceClient()
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyId);
    } catch (e) {
      this.logger.debug?.(
        `last_used_at touch failed for ${keyId}: ${(e as Error).message}`,
      );
    }
  }

  private mapRow(row: ApiKeyRow): ApiKeyRecord {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: row.scopes ?? [],
      rateLimitPerHour: row.rate_limit_per_hour ?? DEFAULT_RATE_LIMIT_PER_HOUR,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }
}
