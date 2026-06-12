-- Migration: 20260605000001 — user_published_posts
-- Sprint 1.6. "Learn from your past published posts" (Postiz-inspired, task #1132).
--
-- Captures the EXACT caption a user actually published (after any manual edits)
-- so the custom-topic generation pipeline can learn their personal hook style,
-- sentence rhythm, vocabulary, emoji + formatting habits and reproduce them on
-- the next generation. Only successfully-published posts land here — this is a
-- clean, opt-out-able style corpus distinct from the brand-kit voice examples.
--
-- Engagement columns (reactions/comments/engagement_score) are nullable and
-- reserved for a later phase that ranks samples by performance.

BEGIN;

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
    IS 'Reserved for a later phase: rank samples by reactions + comments to pick top performers.';

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
