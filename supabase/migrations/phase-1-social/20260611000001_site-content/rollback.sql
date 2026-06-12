-- ROLLBACK: site-content (Phase 1.5 GTM marketing/legal/admin CMS)
--
-- Drops only the objects introduced by this migration. Code-level template
-- defaults keep the public marketing/legal pages rendering after rollback.
--
-- WARNING: dropping these tables discards admin-saved announcements, legal page
-- overrides, and marketing copy overrides. Only run to fully revert.

BEGIN;

DROP TABLE IF EXISTS public.site_announcements;
DROP TABLE IF EXISTS public.legal_pages;
DROP TABLE IF EXISTS public.site_content;

COMMIT;
