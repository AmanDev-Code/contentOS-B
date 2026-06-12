-- Migration: 20260601000002 — social_tokens
-- Sprint 1.2. Encrypted OAuth tokens, stored in Supabase Vault (libsodium AES-256-GCM).
--
-- Why a SEPARATE table from `social_accounts`:
--   * Rotation: rewriting a token must not bump the parent row's metadata.
--   * Audit: secret reads are scoped to a single, narrow surface.
--   * Encryption boundary: the application can read `social_accounts` freely
--     but every secret read goes through `vault.decrypted_secrets` and is
--     gated to the service role.
--
-- Vault usage pattern (referenced in the Sprint 1.2 README):
--   -- Store an access token:
--   --   SELECT vault.create_secret(
--   --     'eyJhbGciOiJI...the.actual.token...',
--   --     'linkedin:user_<userId>:access:<rotationCounter>',
--   --     'LinkedIn access token for user <userId>'
--   --   );
--   -- The returned UUID is what we INSERT into vault_secret_id below.
--   --
--   -- Read at publish-time:
--   --   SELECT decrypted_secret
--   --   FROM vault.decrypted_secrets
--   --   WHERE id = <vault_secret_id>;
--   --
--   -- Rotate:
--   --   1. vault.create_secret(new_token, ...)
--   --   2. UPDATE social_tokens SET vault_secret_id = <new>, updated_at = NOW() ...
--   --   3. SELECT vault.delete_secret(<old_id>) (or schedule via Sprint 1.3 worker)

BEGIN;

-- Vault is built into Supabase but the extension may not be enabled on a brand-
-- new project. CREATE EXTENSION is idempotent.
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE TABLE IF NOT EXISTS public.social_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    social_account_id UUID NOT NULL UNIQUE
        REFERENCES public.social_accounts(id) ON DELETE CASCADE,
    vault_secret_id UUID NOT NULL,
    refresh_vault_secret_id UUID,
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ,
    last_refreshed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FKs into vault.secrets are deliberately NOT enforced at the DB layer:
-- vault.secrets has its own access controls and we do not want a user-level
-- DELETE on `social_accounts` to silently bypass secret cleanup. The token
-- service is responsible for vault.delete_secret() on cascade.
COMMENT ON TABLE public.social_tokens
    IS 'Encrypted OAuth token set per social_account. Secret material lives in vault.secrets, referenced by *_vault_secret_id. NEVER add a plaintext token column here.';
COMMENT ON COLUMN public.social_tokens.vault_secret_id
    IS 'UUID of the access-token row in vault.secrets. Read via SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = vault_secret_id.';
COMMENT ON COLUMN public.social_tokens.refresh_vault_secret_id
    IS 'Optional. UUID of the refresh-token row in vault.secrets. Null when the platform issues only short-lived tokens.';
COMMENT ON COLUMN public.social_tokens.scopes
    IS 'OAuth scopes actually granted (NOT requested). Used by ScopeInsufficientError checks.';

CREATE INDEX IF NOT EXISTS idx_social_tokens_expires_at
    ON public.social_tokens(expires_at);

DROP TRIGGER IF EXISTS trg_social_tokens_touch_updated_at ON public.social_tokens;
CREATE TRIGGER trg_social_tokens_touch_updated_at
    BEFORE UPDATE ON public.social_tokens
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.social_tokens ENABLE ROW LEVEL SECURITY;

-- Service role only. No anon/authenticated policies are created on purpose:
-- the absence of a SELECT policy means PostgREST will deny every non-service
-- role read. Defense in depth on top of the bypass-RLS service JWT.
DROP POLICY IF EXISTS social_tokens_service_all ON public.social_tokens;
CREATE POLICY social_tokens_service_all
    ON public.social_tokens
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
