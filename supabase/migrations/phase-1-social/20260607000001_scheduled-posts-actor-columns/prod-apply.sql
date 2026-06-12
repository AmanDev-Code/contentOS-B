-- PROD-APPLY: scheduled_posts actor columns (follow-up to Sprint 1.6)
--
-- Standalone, self-contained, ADDITIVE-ONLY migration for the PRODUCTION
-- database. `scheduled_posts` already exists in prod (it predates phase-1-social
-- and was created by the historical UPDATED_SCHEMA.sql). This script only ADDs
-- two nullable TEXT columns guarded by IF NOT EXISTS — it does NOT alter, drop,
-- or modify any existing column, constraint, index, policy, or relation.
--
-- Apply via plugin-supabase-supabase apply_migration(project_id=pfrhlcmkgpfiuyrfdmee).
-- The workspace project-0-SaaS-supabase-prod MCP is read-only (see memory #1160).
-- When applied through apply_migration, omit the BEGIN/COMMIT wrapper (the tool
-- runs the body in its own transaction).

ALTER TABLE public.scheduled_posts
    ADD COLUMN IF NOT EXISTS actor_type TEXT;

ALTER TABLE public.scheduled_posts
    ADD COLUMN IF NOT EXISTS organization_urn TEXT;

COMMENT ON COLUMN public.scheduled_posts.actor_type
    IS 'Publishing actor for this scheduled post: ''member'' (personal profile) or ''organization'' (company page). NULL for rows created before this migration — readers fall back to BullMQ job data.';
COMMENT ON COLUMN public.scheduled_posts.organization_urn
    IS 'LinkedIn organization URN (urn:li:organization:NNN) when actor_type = ''organization''. NULL for member posts or pre-migration rows.';
