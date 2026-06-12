-- PROD-APPLY: site-content (Phase 1.5 GTM marketing/legal/admin CMS)
--
-- Standalone, self-contained, ADDITIVE-ONLY migration for PRODUCTION. Bundles
-- the shared `trndinn_touch_updated_at()` helper (CREATE OR REPLACE = additive)
-- so it can be applied to prod on its own, mirroring the existing prod-apply
-- pattern (see 20260610000001_credit-buckets/prod-apply.sql).
--
-- VERIFY ADDITIVE on staging before prod: site_announcements / legal_pages /
-- site_content must not already exist. This script only CREATEs new objects and
-- new RLS policies. It does NOT alter, drop, or modify any existing table, data,
-- column, policy, or relation.
--
-- The prod Supabase MCP is read-only; apply manually (SQL editor / CLI) with a
-- DDL-capable role. No backfill required — code provides template defaults until
-- an admin saves overrides.

BEGIN;

CREATE OR REPLACE FUNCTION public.trndinn_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- 1) site_announcements -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_announcements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message      TEXT NOT NULL,
    title        TEXT,
    detail       TEXT,
    variant      TEXT NOT NULL DEFAULT 'info'
                 CHECK (variant IN ('info', 'success', 'warning', 'error', 'promo')),
    link_url     TEXT,
    link_label   TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    dismissible  BOOLEAN NOT NULL DEFAULT true,
    starts_at    TIMESTAMPTZ,
    ends_at      TIMESTAMPTZ,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_site_announcements_active
    ON public.site_announcements (is_active, sort_order);
DROP TRIGGER IF EXISTS trg_site_announcements_touch_updated_at ON public.site_announcements;
CREATE TRIGGER trg_site_announcements_touch_updated_at
    BEFORE UPDATE ON public.site_announcements
    FOR EACH ROW EXECUTE FUNCTION public.trndinn_touch_updated_at();
ALTER TABLE public.site_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_announcements_public_read ON public.site_announcements;
CREATE POLICY site_announcements_public_read ON public.site_announcements
    FOR SELECT USING (
        is_active = true
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at >= now())
    );
DROP POLICY IF EXISTS site_announcements_service_all ON public.site_announcements;
CREATE POLICY site_announcements_service_all ON public.site_announcements
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 2) legal_pages --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_pages (
    slug            TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    summary         TEXT,
    body            TEXT NOT NULL DEFAULT '',
    seo_description  TEXT,
    version         TEXT,
    effective_date  DATE,
    is_published    BOOLEAN NOT NULL DEFAULT true,
    sort_order      INT NOT NULL DEFAULT 0,
    updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_legal_pages_touch_updated_at ON public.legal_pages;
CREATE TRIGGER trg_legal_pages_touch_updated_at
    BEFORE UPDATE ON public.legal_pages
    FOR EACH ROW EXECUTE FUNCTION public.trndinn_touch_updated_at();
ALTER TABLE public.legal_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_pages_public_read ON public.legal_pages;
CREATE POLICY legal_pages_public_read ON public.legal_pages
    FOR SELECT USING (is_published = true);
DROP POLICY IF EXISTS legal_pages_service_all ON public.legal_pages;
CREATE POLICY legal_pages_service_all ON public.legal_pages
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 3) site_content -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_content (
    section_key  TEXT PRIMARY KEY,
    content      JSONB NOT NULL DEFAULT '{}'::jsonb,
    description  TEXT,
    is_published BOOLEAN NOT NULL DEFAULT true,
    updated_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_site_content_touch_updated_at ON public.site_content;
CREATE TRIGGER trg_site_content_touch_updated_at
    BEFORE UPDATE ON public.site_content
    FOR EACH ROW EXECUTE FUNCTION public.trndinn_touch_updated_at();
ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_content_public_read ON public.site_content;
CREATE POLICY site_content_public_read ON public.site_content
    FOR SELECT USING (is_published = true);
DROP POLICY IF EXISTS site_content_service_all ON public.site_content;
CREATE POLICY site_content_service_all ON public.site_content
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMIT;
