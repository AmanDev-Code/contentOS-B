-- Rollback for 20260601000007_create_media_assets.sql
-- WARNING: storage objects in Supabase Storage are NOT deleted by this script.

BEGIN;

DROP TABLE IF EXISTS public.media_assets CASCADE;

COMMIT;
