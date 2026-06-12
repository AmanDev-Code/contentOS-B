-- Migration: 20260601000009 — webhooks
-- Sprint 1.2. User-configured outbound webhooks. HMAC-SHA256 signed.
--
-- Spec deviation note: the original spec listed BOTH `secret TEXT` and a later
-- rename to `vault_secret_id`. We skip the deprecated column entirely and
-- ship the Vault-backed shape from day one, since this migration creates the
-- table fresh. Storing HMAC secrets in plaintext was never an acceptable
-- intermediate state. Documented in README.

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    vault_secret_id UUID NOT NULL,
    events TEXT[] NOT NULL
        DEFAULT ARRAY['post.published', 'post.failed', 'post.scheduled']::TEXT[],
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.webhooks
    IS 'User-configured outbound HTTP webhooks. HMAC-SHA256 signed using the secret stored in vault.secrets[vault_secret_id].';
COMMENT ON COLUMN public.webhooks.vault_secret_id
    IS 'UUID of the per-webhook signing secret in vault.secrets. Plain-text secrets are NEVER stored on this row.';
COMMENT ON COLUMN public.webhooks.url
    IS 'Outbound URL. Validated SSRF-safe at insert time (no localhost / private CIDRs / file:).';
COMMENT ON COLUMN public.webhooks.events
    IS 'Subset of supported events: post.published | post.failed | post.scheduled | post.cancelled (extensible).';

CREATE INDEX IF NOT EXISTS idx_webhooks_user
    ON public.webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_enabled
    ON public.webhooks(enabled) WHERE enabled = TRUE;

DROP TRIGGER IF EXISTS trg_webhooks_touch_updated_at ON public.webhooks;
CREATE TRIGGER trg_webhooks_touch_updated_at
    BEFORE UPDATE ON public.webhooks
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhooks_select_own ON public.webhooks;
CREATE POLICY webhooks_select_own
    ON public.webhooks
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS webhooks_insert_own ON public.webhooks;
CREATE POLICY webhooks_insert_own
    ON public.webhooks
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS webhooks_update_own ON public.webhooks;
CREATE POLICY webhooks_update_own
    ON public.webhooks
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS webhooks_delete_own ON public.webhooks;
CREATE POLICY webhooks_delete_own
    ON public.webhooks
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS webhooks_service_all ON public.webhooks;
CREATE POLICY webhooks_service_all
    ON public.webhooks
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
