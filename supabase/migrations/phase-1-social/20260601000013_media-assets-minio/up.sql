-- Migration: 20260601000013 — media_assets MinIO storage columns (reality alignment)
-- Founder clarification (May 31, 2026): Trndinn has ALWAYS stored media on
-- self-hosted MinIO. The original Sprint 1.2 migration
-- (`20260601000007_create_media_assets.sql`) drafted the table with a single
-- opaque `storage_path` column and a (now-corrected) misleading comment that
-- referenced "Supabase Storage". This follow-up makes the real storage backend
-- explicit so the publisher and media library code can route correctly and the
-- next engineer reading the schema isn't misled.
--
-- The pre-existing `public.media_files` table already uses MinIO with columns
-- `minio_path` + `minio_bucket DEFAULT 'contentos-media'` + `public_url`. This
-- migration keeps `media_assets` consistent with that pattern: same bucket
-- (`contentos-media`), same object-keying convention, served through the same
-- `MinioService` + `MinioProxyController` pipeline.
--
-- Allowed providers:
--   * 'minio'    — self-hosted MinIO (DEFAULT; the only first-class backend)
--   * 's3'       — escape hatch for future S3 / R2 / Wasabi (not used today)
--   * 'cdn_url'  — external public URL already hosted somewhere else (e.g. user
--                  pasted an Unsplash link in the composer); `object_key` then
--                  holds the absolute URL.
--
-- Supabase Storage is intentionally NOT a valid value — Trndinn does not and
-- will not use Supabase Storage for binary media.

BEGIN;

ALTER TABLE public.media_assets
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'minio',
    ADD COLUMN IF NOT EXISTS bucket TEXT NOT NULL DEFAULT 'contentos-media',
    ADD COLUMN IF NOT EXISTS object_key TEXT,
    ADD COLUMN IF NOT EXISTS source_media_file_id UUID
        REFERENCES public.media_files(id) ON DELETE SET NULL;

UPDATE public.media_assets
SET object_key = storage_path
WHERE object_key IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.media_assets'::regclass
          AND conname = 'media_assets_storage_provider_check'
    ) THEN
        ALTER TABLE public.media_assets
            ADD CONSTRAINT media_assets_storage_provider_check
            CHECK (storage_provider IN ('minio', 's3', 'cdn_url'));
    END IF;
END $$;

COMMENT ON COLUMN public.media_assets.storage_provider IS
    'Backend the bytes physically live on. ''minio'' is the default (self-hosted). ''s3'' reserved for future external object-store providers. ''cdn_url'' for external URLs we did not host. Supabase Storage is intentionally not allowed.';
COMMENT ON COLUMN public.media_assets.bucket IS
    'MinIO bucket (or S3 bucket) name. Defaults to ''contentos-media'' to match the existing media_files.minio_bucket default and the MINIO_BUCKET env var. Ignored when storage_provider=''cdn_url''.';
COMMENT ON COLUMN public.media_assets.source_media_file_id IS
    'Optional link to the row in public.media_files that originally landed the bytes via the legacy upload pipeline (MediaController.upload / media-generation.service.uploadToMinio). Lets the social publisher reuse already-uploaded media without re-uploading, and gives us a single audit trail per byte.';
COMMENT ON COLUMN public.media_assets.object_key IS
    'Object key within the bucket (storage_provider=minio|s3) OR absolute URL (storage_provider=cdn_url). Backfilled from legacy storage_path.';
COMMENT ON COLUMN public.media_assets.storage_path IS
    'DEPRECATED. Kept for backward compatibility with the original Sprint 1.2 migration. New code MUST read storage_provider + bucket + object_key. Removal scheduled for Sprint 1.4 cutover.';

CREATE INDEX IF NOT EXISTS idx_media_assets_provider_bucket
    ON public.media_assets(storage_provider, bucket);

COMMIT;
