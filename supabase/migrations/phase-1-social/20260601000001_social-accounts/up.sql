-- Migration: 20260601000001 — social_accounts
-- Sprint 1.2 (Phase 1 LOCKED PLAN v2). Creates the connected social account table.
--
-- Coexistence note: this table does NOT replace `profiles.linkedin_*` columns
-- in this sprint. Sprint 1.4 will introduce a dual-read bridge service so the
-- existing `linkedin.service.ts` keeps working while new code uses this table.
-- DO NOT modify `profiles` or `scheduled_posts` here.
--
-- One row per connected account. A LinkedIn user with a personal profile and
-- two admin'd organization pages will eventually have three rows here, all
-- sharing a single OAuth token via the `oneTimeToken` pattern (Sprint 1.3).

BEGIN;

-- Shared utility: keeps `updated_at` accurate on UPDATE without per-table copies.
CREATE OR REPLACE FUNCTION public.trndinn_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.social_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('linkedin')),
    platform_account_id TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (account_type IN ('personal', 'organization')),
    display_name TEXT,
    profile_url TEXT,
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reauth_required', 'disabled', 'deleted')),
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT social_accounts_unique_per_user UNIQUE (user_id, platform, platform_account_id)
);

COMMENT ON TABLE public.social_accounts
    IS 'Connected social platform accounts (one row per LinkedIn personal profile or organization page).';
COMMENT ON COLUMN public.social_accounts.platform_account_id
    IS 'Platform-side identifier. For LinkedIn: the OIDC `sub` for personal, or `urn:li:organization:{id}` for org pages.';
COMMENT ON COLUMN public.social_accounts.status
    IS 'Lifecycle: active | reauth_required | disabled | deleted. See backend integrations/social/types.ts.';
COMMENT ON COLUMN public.social_accounts.metadata
    IS 'Provider-specific extras (org admin role, oneTimeToken sibling ids, etc.). Schema-versioned via the `_version` key.';

CREATE INDEX IF NOT EXISTS idx_social_accounts_user_status
    ON public.social_accounts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform_status
    ON public.social_accounts(platform, status);

DROP TRIGGER IF EXISTS trg_social_accounts_touch_updated_at ON public.social_accounts;
CREATE TRIGGER trg_social_accounts_touch_updated_at
    BEFORE UPDATE ON public.social_accounts
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_accounts_select_own ON public.social_accounts;
CREATE POLICY social_accounts_select_own
    ON public.social_accounts
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS social_accounts_update_own ON public.social_accounts;
CREATE POLICY social_accounts_update_own
    ON public.social_accounts
    FOR UPDATE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS social_accounts_delete_own ON public.social_accounts;
CREATE POLICY social_accounts_delete_own
    ON public.social_accounts
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS social_accounts_service_all ON public.social_accounts;
CREATE POLICY social_accounts_service_all
    ON public.social_accounts
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
