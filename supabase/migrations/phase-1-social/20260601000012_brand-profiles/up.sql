-- Migration: 20260601000012 — brand_profiles
-- Sprint 1.2. Brand Kit MVP. Trndinn-original feature with no upstream parallel.
--
-- This is the data backing the "Your AI posts in YOUR voice" hero feature.
-- The AI generation pipeline (Sprint 1.5) reads `tone`, `voice_examples`,
-- `do_use`, `do_not_use` to assemble its system prompt + few-shot exemplars.

BEGIN;

CREATE TABLE IF NOT EXISTS public.brand_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    logo_url TEXT,
    primary_color TEXT,
    secondary_color TEXT,
    accent_color TEXT,
    tone TEXT,
    target_audience TEXT,
    voice_examples TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    do_use TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    do_not_use TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT brand_profiles_color_format_primary
        CHECK (primary_color IS NULL OR primary_color ~* '^#[0-9a-f]{6}([0-9a-f]{2})?$'),
    CONSTRAINT brand_profiles_color_format_secondary
        CHECK (secondary_color IS NULL OR secondary_color ~* '^#[0-9a-f]{6}([0-9a-f]{2})?$'),
    CONSTRAINT brand_profiles_color_format_accent
        CHECK (accent_color IS NULL OR accent_color ~* '^#[0-9a-f]{6}([0-9a-f]{2})?$')
);

COMMENT ON TABLE public.brand_profiles
    IS 'Brand Kit MVP. Drives AI generation tone, do/dont vocabulary, and visual identity hints.';
COMMENT ON COLUMN public.brand_profiles.tone
    IS 'Free-form description of the desired voice (e.g. "warm but expert; second-person; no jargon"). Injected into the AI system prompt.';
COMMENT ON COLUMN public.brand_profiles.voice_examples
    IS 'Up to N past posts that exemplify the brand voice. Used as few-shot exemplars in generation.';
COMMENT ON COLUMN public.brand_profiles.do_not_use
    IS 'Banned words/phrases. Enforced in the AI output filter (moderation-engineer).';

CREATE INDEX IF NOT EXISTS idx_brand_profiles_user_name
    ON public.brand_profiles(user_id, name);

DROP TRIGGER IF EXISTS trg_brand_profiles_touch_updated_at ON public.brand_profiles;
CREATE TRIGGER trg_brand_profiles_touch_updated_at
    BEFORE UPDATE ON public.brand_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.brand_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS brand_profiles_select_own ON public.brand_profiles;
CREATE POLICY brand_profiles_select_own
    ON public.brand_profiles
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS brand_profiles_insert_own ON public.brand_profiles;
CREATE POLICY brand_profiles_insert_own
    ON public.brand_profiles
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS brand_profiles_update_own ON public.brand_profiles;
CREATE POLICY brand_profiles_update_own
    ON public.brand_profiles
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS brand_profiles_delete_own ON public.brand_profiles;
CREATE POLICY brand_profiles_delete_own
    ON public.brand_profiles
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS brand_profiles_service_all ON public.brand_profiles;
CREATE POLICY brand_profiles_service_all
    ON public.brand_profiles
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
