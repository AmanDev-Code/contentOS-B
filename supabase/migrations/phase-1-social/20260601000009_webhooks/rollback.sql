-- Rollback for 20260601000009_create_webhooks.sql
-- WARNING: vault.secrets rows referenced by vault_secret_id are NOT deleted.

BEGIN;

DROP TABLE IF EXISTS public.webhooks CASCADE;

COMMIT;
