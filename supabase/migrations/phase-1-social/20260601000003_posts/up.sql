-- Migration: 20260601000003 — posts
-- Sprint 1.2. Unified post entity.
--
-- Coexistence note: the existing `generated_content` and `scheduled_posts`
-- tables are NOT touched. Sprint 1.4 introduces a dual-read bridge so user
-- visible state remains consistent while we cut over.
--
-- The `state` lifecycle distinguishes CANCELLED (user action) from FAILED
-- (every retry exhausted). The publish_jobs row carries per-attempt detail
-- so we don't need to overload `state` to record retry history.

BEGIN;

CREATE TABLE IF NOT EXISTS public.posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    group_id UUID,
    parent_post_id UUID REFERENCES public.posts(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'draft'
        CHECK (state IN ('draft', 'queued', 'publishing', 'published', 'failed', 'cancelled')),
    creation_method TEXT
        CHECK (creation_method IS NULL OR creation_method IN ('api', 'web', 'ai', 'import')),
    content TEXT NOT NULL DEFAULT '',
    media_asset_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    scheduled_for TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.posts
    IS 'Unified post entity. Lifecycle: draft -> queued -> publishing -> published | failed | cancelled.';
COMMENT ON COLUMN public.posts.group_id
    IS 'Shared UUID for atomic multi-channel fan-out. All `post_targets` of a multi-platform post share one parent posts row plus this group.';
COMMENT ON COLUMN public.posts.parent_post_id
    IS 'Self-FK for thread/carousel chains. Null for standalone posts.';
COMMENT ON COLUMN public.posts.media_asset_ids
    IS 'Ordered array of media_assets.id used by this post. Order matters (carousel sequence).';

CREATE INDEX IF NOT EXISTS idx_posts_user_state_scheduled
    ON public.posts(user_id, state, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_posts_group_id
    ON public.posts(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_parent
    ON public.posts(parent_post_id) WHERE parent_post_id IS NOT NULL;
-- Partial index for the missed-job sweeper: it only ever scans queued posts
-- whose scheduled_for is in the past. Keeping the index narrow keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_posts_sweeper_queued
    ON public.posts(scheduled_for)
    WHERE state = 'queued';

DROP TRIGGER IF EXISTS trg_posts_touch_updated_at ON public.posts;
CREATE TRIGGER trg_posts_touch_updated_at
    BEFORE UPDATE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posts_select_own ON public.posts;
CREATE POLICY posts_select_own
    ON public.posts
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS posts_insert_own ON public.posts;
CREATE POLICY posts_insert_own
    ON public.posts
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS posts_update_own ON public.posts;
CREATE POLICY posts_update_own
    ON public.posts
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS posts_delete_own ON public.posts;
CREATE POLICY posts_delete_own
    ON public.posts
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS posts_service_all ON public.posts;
CREATE POLICY posts_service_all
    ON public.posts
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
