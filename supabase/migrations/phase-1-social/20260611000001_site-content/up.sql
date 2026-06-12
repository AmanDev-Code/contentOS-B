-- Migration: 20260611000001 — site-content (Phase 1.5 GTM marketing/legal/admin CMS)
--
-- ADDITIVE-ONLY. Introduces three new tables that power the public marketing
-- site, legal pages, and the admin-managed announcement marquee. Touches NO
-- existing table, policy, column, or relation.
--
-- New objects (all new):
--   * public.site_announcements  — admin-managed announcement marquee (superset:
--       severity variant, schedule window, link, dismissible, sort_order, active)
--   * public.legal_pages         — admin-editable legal page bodies (markdown),
--       keyed by slug; public reads only published rows
--   * public.site_content        — key/value JSONB blocks for editable marketing
--       copy + pricing display metadata (NOT prices, which come from Polar)
--
-- Reads from the backend go through the service role (RLS bypassed); the public
-- SELECT policies below are defensive so anon/auth reads only ever see
-- active/published rows if accessed directly.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) site_announcements — announcement marquee (above the marketing header)
-- ---------------------------------------------------------------------------
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

COMMENT ON TABLE public.site_announcements IS
    'Phase 1.5: admin-managed announcement marquee rendered above the marketing header. Superset of Postiz pattern (severity + detail modal) plus scheduling, linking, dismiss, sort_order, active.';

CREATE INDEX IF NOT EXISTS idx_site_announcements_active
    ON public.site_announcements (is_active, sort_order);

DROP TRIGGER IF EXISTS trg_site_announcements_touch_updated_at ON public.site_announcements;
CREATE TRIGGER trg_site_announcements_touch_updated_at
    BEFORE UPDATE ON public.site_announcements
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.site_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_announcements_public_read ON public.site_announcements;
CREATE POLICY site_announcements_public_read
    ON public.site_announcements
    FOR SELECT
    USING (
        is_active = true
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at >= now())
    );

DROP POLICY IF EXISTS site_announcements_service_all ON public.site_announcements;
CREATE POLICY site_announcements_service_all
    ON public.site_announcements
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 2) legal_pages — admin-editable legal page bodies (markdown), by slug
-- ---------------------------------------------------------------------------
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

COMMENT ON TABLE public.legal_pages IS
    'Phase 1.5: admin-editable legal page bodies (markdown). Slugs: privacy, terms, cookies, aup, dpa, subprocessors, refund, data-rights. Code holds template defaults; this table overrides them. TEMPLATES — pending legal review.';

DROP TRIGGER IF EXISTS trg_legal_pages_touch_updated_at ON public.legal_pages;
CREATE TRIGGER trg_legal_pages_touch_updated_at
    BEFORE UPDATE ON public.legal_pages
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.legal_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_pages_public_read ON public.legal_pages;
CREATE POLICY legal_pages_public_read
    ON public.legal_pages
    FOR SELECT
    USING (is_published = true);

DROP POLICY IF EXISTS legal_pages_service_all ON public.legal_pages;
CREATE POLICY legal_pages_service_all
    ON public.legal_pages
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 3) site_content — key/value JSONB editable marketing + pricing-display copy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_content (
    section_key  TEXT PRIMARY KEY,
    content      JSONB NOT NULL DEFAULT '{}'::jsonb,
    description  TEXT,
    is_published BOOLEAN NOT NULL DEFAULT true,
    updated_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.site_content IS
    'Phase 1.5: editable marketing copy blocks + pricing display metadata (feature bullets, plan descriptions, highlights — NOT prices). Keys e.g. landing_hero, landing_pillars, features_page, pricing_meta. Code holds defaults; this table overrides them.';

DROP TRIGGER IF EXISTS trg_site_content_touch_updated_at ON public.site_content;
CREATE TRIGGER trg_site_content_touch_updated_at
    BEFORE UPDATE ON public.site_content
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_content_public_read ON public.site_content;
CREATE POLICY site_content_public_read
    ON public.site_content
    FOR SELECT
    USING (is_published = true);

DROP POLICY IF EXISTS site_content_service_all ON public.site_content;
CREATE POLICY site_content_service_all
    ON public.site_content
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
