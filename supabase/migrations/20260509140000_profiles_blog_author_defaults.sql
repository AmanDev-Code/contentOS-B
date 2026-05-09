-- Blog author defaults stored on profile (per-user reusable defaults for CMS).
-- Display name continues to use full_name; avatar fallback is avatar_url when author_avatar_url is null.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS author_bio text,
  ADD COLUMN IF NOT EXISTS author_role text,
  ADD COLUMN IF NOT EXISTS author_avatar_url text,
  ADD COLUMN IF NOT EXISTS author_linkedin_url text;

COMMENT ON COLUMN public.profiles.author_bio IS 'Default author bio for blog posts (CMS)';
COMMENT ON COLUMN public.profiles.author_role IS 'Default author role/title for blog posts (CMS)';
COMMENT ON COLUMN public.profiles.author_avatar_url IS 'Optional blog-specific author photo URL; if null, UI falls back to avatar_url';
COMMENT ON COLUMN public.profiles.author_linkedin_url IS 'Default author LinkedIn profile URL for blog posts (CMS)';
