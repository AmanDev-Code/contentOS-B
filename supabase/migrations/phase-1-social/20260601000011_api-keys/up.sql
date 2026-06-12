-- Migration: 20260601000011 — api_keys
-- Sprint 1.2. Public API keys with scopes + rotation metadata.
--
-- Storage shape:
--   * `key_prefix` — 8 chars, INDEXED for O(1) lookup ('trnd_a1b').
--   * `key_hash`   — SHA-256 of the FULL key (prefix + secret). Constant-time
--                   compared in middleware. The plaintext key is shown ONCE at
--                   creation and never again.

BEGIN;

CREATE TABLE IF NOT EXISTS public.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    scopes TEXT[] NOT NULL
        DEFAULT ARRAY['posts:read', 'posts:write', 'accounts:read']::TEXT[],
    last_used_at TIMESTAMPTZ,
    rate_limit_per_hour INT NOT NULL DEFAULT 100 CHECK (rate_limit_per_hour > 0),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT api_keys_key_prefix_unique UNIQUE (key_prefix)
);

COMMENT ON TABLE public.api_keys
    IS 'Public API keys. Plaintext is shown once at creation. Lookup goes prefix -> hash compare.';
COMMENT ON COLUMN public.api_keys.key_prefix
    IS '8-character public prefix (e.g. trnd_a1b) for fast indexed lookup. NOT secret on its own.';
COMMENT ON COLUMN public.api_keys.key_hash
    IS 'SHA-256 of the full key (prefix + secret). Compared constant-time in middleware. Never reversible.';
COMMENT ON COLUMN public.api_keys.scopes
    IS 'Capability scopes: posts:read, posts:write, accounts:read, accounts:write, media:write, webhooks:write, etc.';
COMMENT ON COLUMN public.api_keys.revoked_at
    IS 'Soft-revocation timestamp. Set, do not delete — preserves audit trail and usage history.';

CREATE INDEX IF NOT EXISTS idx_api_keys_user_revoked
    ON public.api_keys(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_active_lookup
    ON public.api_keys(key_prefix)
    WHERE revoked_at IS NULL;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Authenticated users can list and revoke their own keys via the dashboard.
-- They CANNOT see key_hash because the column is excluded at the API layer
-- (PostgREST view or NestJS DTO mapping); RLS still allows the row, but the
-- service layer is the secret-handling seam.
DROP POLICY IF EXISTS api_keys_select_own ON public.api_keys;
CREATE POLICY api_keys_select_own
    ON public.api_keys
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS api_keys_update_own ON public.api_keys;
CREATE POLICY api_keys_update_own
    ON public.api_keys
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS api_keys_delete_own ON public.api_keys;
CREATE POLICY api_keys_delete_own
    ON public.api_keys
    FOR DELETE
    USING (user_id = auth.uid());

-- INSERT must go through service role: we generate the key + hash server-side.
DROP POLICY IF EXISTS api_keys_service_all ON public.api_keys;
CREATE POLICY api_keys_service_all
    ON public.api_keys
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
