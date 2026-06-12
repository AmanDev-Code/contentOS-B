-- Rollback for 20260601000005_create_publish_jobs.sql

BEGIN;

DROP TABLE IF EXISTS public.publish_jobs CASCADE;

COMMIT;
