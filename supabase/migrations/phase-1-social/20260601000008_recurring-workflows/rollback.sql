-- Rollback for 20260601000008_create_recurring_workflows.sql

BEGIN;

DROP TABLE IF EXISTS public.recurring_workflows CASCADE;

COMMIT;
