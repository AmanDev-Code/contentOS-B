-- Rollback for 20260601000011_create_api_keys.sql
-- WARNING: revoking via DROP TABLE invalidates every API key issued so far.

BEGIN;

DROP TABLE IF EXISTS public.api_keys CASCADE;

COMMIT;
