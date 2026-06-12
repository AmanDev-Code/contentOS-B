-- Rollback for 20260601000015_vault-token-helpers
-- Drops the public wrappers. Does NOT touch vault.secrets contents.
BEGIN;
DROP FUNCTION IF EXISTS public.trndinn_vault_create_secret(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.trndinn_vault_read_secret(UUID);
DROP FUNCTION IF EXISTS public.trndinn_vault_delete_secret(UUID);
COMMIT;
