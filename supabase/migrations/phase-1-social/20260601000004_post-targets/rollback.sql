-- Rollback for 20260601000004_create_post_targets.sql

BEGIN;

DROP TABLE IF EXISTS public.post_targets CASCADE;

COMMIT;
