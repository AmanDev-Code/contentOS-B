-- Rollback for 20260601000003_create_posts.sql
-- Cascades into post_targets, publish_jobs, publish_logs via their FKs.

BEGIN;

DROP TABLE IF EXISTS public.posts CASCADE;

COMMIT;
