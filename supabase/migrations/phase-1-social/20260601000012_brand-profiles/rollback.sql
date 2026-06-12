-- Rollback for 20260601000012_create_brand_profiles.sql

BEGIN;

DROP TABLE IF EXISTS public.brand_profiles CASCADE;

COMMIT;
