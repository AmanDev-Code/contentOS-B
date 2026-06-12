-- PROD-APPLY: user_published_posts (Sprint 1.6, task #1132)
--
-- Standalone, self-contained, ADDITIVE-ONLY migration for the PRODUCTION
-- database. Unlike staging, prod does NOT have the phase-1-social schema
-- applied, so the shared `trndinn_touch_updated_at()` trigger helper does not
-- exist there yet. This file bundles a `CREATE OR REPLACE FUNCTION` for that
-- helper (additive: creates a brand-new function) with the table DDL so it can
-- be applied to prod on its own.
--
-- VERIFIED ADDITIVE (Jun 7 2026): `public.user_published_posts` does not exist
-- in prod and `trndinn_touch_updated_at` does not exist in prod. This script
-- only CREATEs new objects (function, table, index, trigger, policies). It does
-- NOT alter, drop, or modify any existing table, column, policy, or relation.
--
-- NOTE: could not be applied via the Supabase MCP because the prod MCP server
-- runs in read-only mode. Apply manually (Supabase SQL editor / CLI) with a
-- role that has DDL privileges.

BEGIN;

-- Idempotent touch-updated-at helper (shared convention across phase-1-social).
CREATE OR REPLACE FUNCTION public.trndinn_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.user_published_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content_id UUID NOT NULL,
    platform TEXT NOT NULL DEFAULT 'linkedin',
    caption TEXT NOT NULL,
    visual_type TEXT,
    linkedin_post_id TEXT,
    char_count INTEGER,
    reactions INTEGER,
    comments INTEGER,
    engagement_score NUMERIC,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_published_posts_content_unique UNIQUE (content_id)
);

COMMENT ON TABLE public.user_published_posts
    IS 'Per-user corpus of captions the user actually published. Feeds the "learn from your past posts" style block in custom-topic generation (Sprint 1.6, task #1132).';
COMMENT ON COLUMN public.user_published_posts.caption
    IS 'Final published caption text (after manual edits). This is the ground truth of what the user likes.';
COMMENT ON COLUMN public.user_published_posts.content_id
    IS 'Source generated_content.id. Unique so publish retries upsert instead of duplicating.';
COMMENT ON COLUMN public.user_published_posts.engagement_score
    IS 'reactions + comments*2, populated by the post-engagement-sync cron 24h+ after publish; ranks top performers for style learning.';

CREATE INDEX IF NOT EXISTS idx_user_published_posts_user_recent
    ON public.user_published_posts(user_id, platform, published_at DESC);

DROP TRIGGER IF EXISTS trg_user_published_posts_touch_updated_at ON public.user_published_posts;
CREATE TRIGGER trg_user_published_posts_touch_updated_at
    BEFORE UPDATE ON public.user_published_posts
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.user_published_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_published_posts_select_own ON public.user_published_posts;
CREATE POLICY user_published_posts_select_own
    ON public.user_published_posts
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_published_posts_delete_own ON public.user_published_posts;
CREATE POLICY user_published_posts_delete_own
    ON public.user_published_posts
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_published_posts_service_all ON public.user_published_posts;
CREATE POLICY user_published_posts_service_all
    ON public.user_published_posts
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
