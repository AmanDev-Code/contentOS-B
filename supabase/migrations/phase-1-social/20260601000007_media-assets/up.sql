-- Migration: 20260601000007 — media_assets
-- Sprint 1.2. Trndinn-side media library for the social publishing pipeline.
--
-- IMPORTANT (corrected May 31, 2026): the original draft of this file
-- mistakenly described `storage_path` as a "Supabase Storage object path".
-- That was wrong. Trndinn has always stored binary media on self-hosted MinIO.
-- See `MinioService` (`backend/src/services/minio.service.ts`) and the
-- pre-existing `public.media_files` table (`minio_path`, `minio_bucket`
-- defaulting to `contentos-media`) for the real pipeline. The follow-up
-- migration `20260601000013_media_assets_minio_default.sql` adds explicit
-- `storage_provider` / `bucket` / `object_key` / `source_media_file_id`
-- columns to make this reality visible in the schema.
--
-- Coexistence note: the existing `media_files` table is NOT touched. The
-- social publisher reuses the same MinIO bucket; `media_assets` may FK back
-- to `media_files` via `source_media_file_id` to avoid duplicate uploads.

BEGIN;

CREATE TABLE IF NOT EXISTS public.media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document', 'pdf')),
    storage_path TEXT NOT NULL,
    original_filename TEXT,
    mime_type TEXT,
    size_bytes BIGINT,
    width INT,
    height INT,
    duration_seconds NUMERIC(10, 3),
    processing_status TEXT NOT NULL DEFAULT 'ready'
        CHECK (processing_status IN ('uploading', 'processing', 'ready', 'failed')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.media_assets
    IS 'Media library entries. May be referenced by multiple posts via posts.media_asset_ids[].';
COMMENT ON COLUMN public.media_assets.storage_path
    IS 'LEGACY column. New code MUST use object_key + bucket + storage_provider (added by migration 20260601000013). Bytes live in self-hosted MinIO, not Supabase Storage.';
COMMENT ON COLUMN public.media_assets.processing_status
    IS 'uploading | processing | ready | failed. Posts must not be queued referencing assets that are not `ready`.';

CREATE INDEX IF NOT EXISTS idx_media_assets_user_created_at
    ON public.media_assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_kind_status
    ON public.media_assets(kind, processing_status);

DROP TRIGGER IF EXISTS trg_media_assets_touch_updated_at ON public.media_assets;
CREATE TRIGGER trg_media_assets_touch_updated_at
    BEFORE UPDATE ON public.media_assets
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_assets_select_own ON public.media_assets;
CREATE POLICY media_assets_select_own
    ON public.media_assets
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS media_assets_insert_own ON public.media_assets;
CREATE POLICY media_assets_insert_own
    ON public.media_assets
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS media_assets_update_own ON public.media_assets;
CREATE POLICY media_assets_update_own
    ON public.media_assets
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS media_assets_delete_own ON public.media_assets;
CREATE POLICY media_assets_delete_own
    ON public.media_assets
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS media_assets_service_all ON public.media_assets;
CREATE POLICY media_assets_service_all
    ON public.media_assets
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
