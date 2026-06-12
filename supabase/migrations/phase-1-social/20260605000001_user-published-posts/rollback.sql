-- Rollback: 20260605000001 — user_published_posts

BEGIN;

DROP TABLE IF EXISTS public.user_published_posts CASCADE;

COMMIT;
