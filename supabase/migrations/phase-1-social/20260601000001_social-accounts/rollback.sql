-- Rollback for 20260601000001_create_social_accounts.sql
-- WARNING: destructive. Drops the social_accounts table and the shared
-- `trndinn_touch_updated_at` helper IF no other table still depends on it.
-- Subsequent migrations recreate the helper idempotently with CREATE OR REPLACE,
-- so dropping it here is only safe when rolling back THE WHOLE Sprint 1.2 batch.

BEGIN;

DROP TABLE IF EXISTS public.social_accounts CASCADE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.triggers
        WHERE action_statement LIKE '%trndinn_touch_updated_at%'
    ) THEN
        DROP FUNCTION IF EXISTS public.trndinn_touch_updated_at();
    END IF;
END $$;

COMMIT;
