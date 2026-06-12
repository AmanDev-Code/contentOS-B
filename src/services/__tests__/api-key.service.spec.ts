import { createHash } from 'crypto';
import {
  ApiKeyService,
  API_KEY_PLAINTEXT_PREFIX,
} from '../api-key.service';

/**
 * Minimal in-memory fake of the Supabase query builder covering only the calls
 * ApiKeyService makes: insert().select().single(), and
 * select().eq().is().maybeSingle().
 */
interface FakeRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  rate_limit_per_hour: number;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

class FakeSupabase {
  rows: FakeRow[] = [];
  private idCounter = 1;

  getServiceClient() {
    const store = this;
    return {
      from(table: string) {
        if (table !== 'api_keys') throw new Error(`unexpected table ${table}`);
        return {
          insert(payload: Record<string, unknown>) {
            const row: FakeRow = {
              id: `key-${store.idCounter++}`,
              user_id: payload.user_id as string,
              name: payload.name as string,
              key_prefix: payload.key_prefix as string,
              key_hash: payload.key_hash as string,
              scopes: payload.scopes as string[],
              rate_limit_per_hour: payload.rate_limit_per_hour as number,
              last_used_at: null,
              expires_at: (payload.expires_at as string) ?? null,
              revoked_at: null,
              created_at: new Date().toISOString(),
            };
            // Enforce the UNIQUE(key_prefix) constraint.
            if (store.rows.some((r) => r.key_prefix === row.key_prefix)) {
              return {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'duplicate' },
                  }),
                }),
              };
            }
            store.rows.push(row);
            return {
              select: () => ({
                single: async () => ({ data: row, error: null }),
              }),
            };
          },
          select() {
            const filters: Array<(r: FakeRow) => boolean> = [];
            const builder = {
              eq(col: keyof FakeRow, val: unknown) {
                filters.push((r) => r[col] === val);
                return builder;
              },
              is(col: keyof FakeRow, val: null) {
                filters.push((r) => r[col] === val);
                return builder;
              },
              order() {
                return builder;
              },
              async maybeSingle() {
                const match = store.rows.find((r) =>
                  filters.every((f) => f(r)),
                );
                return { data: match ?? null, error: null };
              },
            };
            return builder;
          },
          update(patch: Record<string, unknown>) {
            const filters: Array<(r: FakeRow) => boolean> = [];
            const builder = {
              eq(col: keyof FakeRow, val: unknown) {
                filters.push((r) => r[col] === val);
                return builder;
              },
              is(col: keyof FakeRow, val: null) {
                filters.push((r) => r[col] === val);
                return builder;
              },
              select() {
                return {
                  maybeSingle: async () => {
                    const match = store.rows.find((r) =>
                      filters.every((f) => f(r)),
                    );
                    if (match) Object.assign(match, patch);
                    return { data: match ?? null, error: null };
                  },
                };
              },
              then: undefined,
            };
            // Allow `await update(...).eq(...)` style (no select) used by touch.
            return new Proxy(builder, {
              get(target, prop) {
                if (prop === 'then') {
                  return (resolve: (v: unknown) => void) => {
                    const match = store.rows.find((r) =>
                      filters.every((f) => f(r)),
                    );
                    if (match) Object.assign(match, patch);
                    resolve({ data: null, error: null });
                  };
                }
                return (target as Record<string, unknown>)[prop as string];
              },
            });
          },
        };
      },
    };
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('ApiKeyService', () => {
  let fake: FakeSupabase;
  let service: ApiKeyService;

  beforeEach(() => {
    fake = new FakeSupabase();
    service = new ApiKeyService(fake as never);
  });

  describe('createKey', () => {
    it('returns a trnd_ key and stores prefix + SHA-256 hash (not plaintext)', async () => {
      const created = await service.createKey('user-1', { name: 'CI Key' });

      expect(created.plaintextKey.startsWith(API_KEY_PLAINTEXT_PREFIX)).toBe(
        true,
      );
      expect(created.keyPrefix).toBe(created.plaintextKey.slice(0, 12));

      const stored = fake.rows[0];
      // The full plaintext is never persisted; only its hash is.
      expect(stored.key_hash).toBe(sha256(created.plaintextKey));
      expect(stored.key_hash).not.toContain(created.plaintextKey);
      expect(stored.user_id).toBe('user-1');
    });

    it('applies plan-based rate limits', async () => {
      const solo = await service.createKey('u', {
        name: 'k',
        planType: 'free',
      });
      const agency = await service.createKey('u', {
        name: 'k2',
        planType: 'agency',
      });
      expect(solo.rateLimitPerHour).toBe(30);
      expect(agency.rateLimitPerHour).toBe(300);
    });

    it('defaults to safe scopes when none supplied', async () => {
      const created = await service.createKey('u', { name: 'k' });
      expect(created.scopes).toEqual(
        expect.arrayContaining(['posts:read', 'posts:write', 'media:write']),
      );
    });
  });

  describe('validateKey', () => {
    it('resolves the owning user for a valid key', async () => {
      const created = await service.createKey('user-42', { name: 'k' });
      const result = await service.validateKey(created.plaintextKey);
      expect(result).not.toBeNull();
      expect(result?.userId).toBe('user-42');
      expect(result?.keyId).toBe(created.id);
    });

    it('returns null for an unknown/garbage key', async () => {
      await service.createKey('u', { name: 'k' });
      expect(await service.validateKey('trnd_not-a-real-key')).toBeNull();
      expect(await service.validateKey('no-prefix')).toBeNull();
      expect(await service.validateKey('')).toBeNull();
    });

    it('returns null after the key is revoked', async () => {
      const created = await service.createKey('user-9', { name: 'k' });
      expect(await service.validateKey(created.plaintextKey)).not.toBeNull();

      const ok = await service.revokeKey('user-9', created.id);
      expect(ok).toBe(true);
      expect(await service.validateKey(created.plaintextKey)).toBeNull();
    });

    it('returns null for an expired key', async () => {
      const created = await service.createKey('user-7', {
        name: 'k',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(await service.validateKey(created.plaintextKey)).toBeNull();
    });
  });
});
