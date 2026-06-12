-- Migration: 20260601000015 — vault token helper functions
-- Sprint 1.3. The `vault` schema is not exposed through PostgREST, so the Nest
-- backend (supabase-js) cannot call vault.create_secret / read decrypted_secrets
-- directly. These SECURITY DEFINER wrappers live in `public`, are callable via
-- supabase-js `.rpc(...)`, and are locked to the service_role only.
--
-- Security:
--   * SECURITY DEFINER so the function owner's vault access is used, not the
--     caller's. Owner is the migration role (postgres / supabase_admin).
--   * search_path pinned to prevent schema-poisoning.
--   * EXECUTE granted ONLY to service_role. anon/authenticated cannot call these.
--   * No plaintext secret is ever logged or returned except by the explicit
--     read function, which the backend calls only at publish time.

BEGIN;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- Create a secret, return its UUID.
CREATE OR REPLACE FUNCTION public.trndinn_vault_create_secret(
    p_secret TEXT,
    p_name TEXT DEFAULT NULL,
    p_description TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    v_id := vault.create_secret(p_secret, p_name, p_description);
    RETURN v_id;
END;
$$;

-- Read and decrypt a secret by id. Returns NULL if not found.
CREATE OR REPLACE FUNCTION public.trndinn_vault_read_secret(p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public, pg_temp
AS $$
DECLARE
    v_secret TEXT;
BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE id = p_id;
    RETURN v_secret;
END;
$$;

-- Delete a secret by id. Idempotent.
CREATE OR REPLACE FUNCTION public.trndinn_vault_delete_secret(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public, pg_temp
AS $$
BEGIN
    DELETE FROM vault.secrets WHERE id = p_id;
END;
$$;

-- Lock execution to the service role only. The backend uses the service-role
-- key; no browser/anon client can reach these.
REVOKE ALL ON FUNCTION public.trndinn_vault_create_secret(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trndinn_vault_read_secret(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trndinn_vault_delete_secret(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.trndinn_vault_create_secret(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.trndinn_vault_read_secret(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.trndinn_vault_delete_secret(UUID) TO service_role;

COMMIT;
