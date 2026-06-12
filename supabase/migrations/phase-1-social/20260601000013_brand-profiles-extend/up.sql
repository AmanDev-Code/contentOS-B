-- Migration: 20260601000013 — brand_profiles: additional_information + assets
-- Sprint 1.5 Stage B. Adds:
--   * additional_information — free-form catch-all the user can paste (or that
--     the AI Smart Import places leftover context into). Feeds the AI system
--     prompt in Stage B generation.
--   * assets — gallery of brand resource images (screenshots, marks, etc.),
--     separate from the single primary `logo_url`. JSONB array of
--     { url, label?, kind? }. App layer caps at 20 items / 10MB each.

BEGIN;

ALTER TABLE public.brand_profiles
    ADD COLUMN IF NOT EXISTS additional_information TEXT;

ALTER TABLE public.brand_profiles
    ADD COLUMN IF NOT EXISTS assets JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.brand_profiles.additional_information
    IS 'Free-form extra brand context (pasted or AI-extracted). Injected into AI generation prompt.';
COMMENT ON COLUMN public.brand_profiles.assets
    IS 'Brand resource images beyond the primary logo. JSONB array of {url,label?,kind?}. App-capped at 20.';

COMMIT;
