-- Migration: 20260607000001 — scheduled_posts actor columns
-- Follow-up to Sprint 1.6 (memory #1161/#1162).
--
-- Makes the DB the source of truth for the publishing ACTOR of a scheduled
-- post. Until now `actorType` ('member' | 'organization') and `organizationUrn`
-- lived ONLY in the BullMQ job payload. On reschedule the actor was recovered
-- from the old delayed job, and the missed-post sweeper already SELECTed
-- actor_type / organization_urn from this table — but the columns did not exist,
-- so an org-scheduled post whose Redis job was evicted (restart/flush/TTL) would
-- silently fall back to publishing as the member's personal profile.
--
-- ADDITIVE ONLY: this migration adds two nullable TEXT columns. It does NOT
-- alter, drop, or modify any existing column, constraint, index, policy, or
-- relation. Existing rows keep NULLs (back-compat: readers fall back to the
-- BullMQ job data when the columns are NULL).

BEGIN;

ALTER TABLE public.scheduled_posts
    ADD COLUMN IF NOT EXISTS actor_type TEXT;

ALTER TABLE public.scheduled_posts
    ADD COLUMN IF NOT EXISTS organization_urn TEXT;

COMMENT ON COLUMN public.scheduled_posts.actor_type
    IS 'Publishing actor for this scheduled post: ''member'' (personal profile) or ''organization'' (company page). NULL for rows created before this migration — readers fall back to BullMQ job data.';
COMMENT ON COLUMN public.scheduled_posts.organization_urn
    IS 'LinkedIn organization URN (urn:li:organization:NNN) when actor_type = ''organization''. NULL for member posts or pre-migration rows.';

COMMIT;
