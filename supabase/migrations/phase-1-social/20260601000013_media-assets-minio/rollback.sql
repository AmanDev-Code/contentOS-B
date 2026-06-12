-- Rollback for 20260601000013 — media_assets MinIO default
-- Removes the storage_provider / bucket / object_key columns and their constraint.
-- storage_path is left untouched (it's a pre-existing column).

BEGIN;

ALTER TABLE public.media_assets
    DROP CONSTRAINT IF EXISTS media_assets_storage_provider_check;

DROP INDEX IF EXISTS public.idx_media_assets_provider_bucket;

ALTER TABLE public.media_assets
    DROP COLUMN IF EXISTS object_key,
    DROP COLUMN IF EXISTS bucket,
    DROP COLUMN IF EXISTS storage_provider;

COMMIT;
