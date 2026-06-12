-- Rollback for 20260601000006_create_publish_logs.sql

BEGIN;

DROP TABLE IF EXISTS public.publish_logs CASCADE;

COMMIT;
