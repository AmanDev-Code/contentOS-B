-- Rollback for 20260601000002_create_social_tokens.sql
-- WARNING: dropping this table does NOT delete the underlying vault.secrets
-- rows. The token service must enumerate vault_secret_id / refresh_vault_secret_id
-- and call vault.delete_secret() BEFORE running this rollback.

BEGIN;

DROP TABLE IF EXISTS public.social_tokens CASCADE;

COMMIT;
