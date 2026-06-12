-- Rollback for 20260601000010_create_webhook_deliveries.sql

BEGIN;

DROP TABLE IF EXISTS public.webhook_deliveries CASCADE;

COMMIT;
