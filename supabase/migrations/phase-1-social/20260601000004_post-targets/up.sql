-- Migration: 20260601000004 — post_targets
-- Sprint 1.2. Per-platform target row for a post.
--
-- One `posts` row may fan out to N `post_targets` rows (one per
-- (post, social_account) pair). The publish pipeline operates ON post_targets,
-- not on `posts` directly, so partial success is naturally representable: the
-- LinkedIn target can be `published` while a hypothetical X target is `failed`
-- without inventing a compensating transaction.
--
-- RLS is computed by walking up to posts.user_id rather than duplicating
-- user_id here. Keeping the user identity in one place avoids drift if a post
-- is ever transferred (which Sprint 1.x doesn't support, but we want the
-- option later).

BEGIN;

CREATE TABLE IF NOT EXISTS public.post_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    social_account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'publishing', 'published', 'failed', 'skipped')),
    platform_post_id TEXT,
    platform_post_url TEXT,
    error_code TEXT,
    error_message TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT post_targets_unique_per_post_account UNIQUE (post_id, social_account_id)
);

COMMENT ON TABLE public.post_targets
    IS 'Per-platform publish target. One row per (post, social_account). Enables partial-success multi-channel publishing.';
COMMENT ON COLUMN public.post_targets.platform_post_id
    IS 'Identifier returned by the platform once published. For LinkedIn: the URN from the x-restli-id response header.';
COMMENT ON COLUMN public.post_targets.error_code
    IS 'Stable, machine-readable error code derived from ProviderError subclass + platform code. Use for grouping and alerting.';

CREATE INDEX IF NOT EXISTS idx_post_targets_state_post
    ON public.post_targets(state, post_id);
CREATE INDEX IF NOT EXISTS idx_post_targets_account_published_at
    ON public.post_targets(social_account_id, published_at DESC);

DROP TRIGGER IF EXISTS trg_post_targets_touch_updated_at ON public.post_targets;
CREATE TRIGGER trg_post_targets_touch_updated_at
    BEFORE UPDATE ON public.post_targets
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.post_targets ENABLE ROW LEVEL SECURITY;

-- Walk up to posts.user_id rather than denormalizing user_id here.
DROP POLICY IF EXISTS post_targets_select_own ON public.post_targets;
CREATE POLICY post_targets_select_own
    ON public.post_targets
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.posts p
            WHERE p.id = post_targets.post_id
              AND p.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS post_targets_modify_own ON public.post_targets;
CREATE POLICY post_targets_modify_own
    ON public.post_targets
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1
            FROM public.posts p
            WHERE p.id = post_targets.post_id
              AND p.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS post_targets_delete_own ON public.post_targets;
CREATE POLICY post_targets_delete_own
    ON public.post_targets
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1
            FROM public.posts p
            WHERE p.id = post_targets.post_id
              AND p.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS post_targets_service_all ON public.post_targets;
CREATE POLICY post_targets_service_all
    ON public.post_targets
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
