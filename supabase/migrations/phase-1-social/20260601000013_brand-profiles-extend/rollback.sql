-- Rollback for 20260601000013_brand-profiles-extend

BEGIN;

ALTER TABLE public.brand_profiles DROP COLUMN IF EXISTS assets;
ALTER TABLE public.brand_profiles DROP COLUMN IF EXISTS additional_information;

COMMIT;
