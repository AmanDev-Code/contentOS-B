-- PROD-APPLY: contact-messages (Phase 1.5 GTM contact form)
--
-- Standalone, self-contained, ADDITIVE-ONLY migration for PRODUCTION. Bundles
-- the shared `trndinn_touch_updated_at()` helper (CREATE OR REPLACE = additive)
-- so it can be applied to prod on its own, mirroring the existing prod-apply
-- pattern (see 20260611000001_site-content/prod-apply.sql).
--
-- VERIFY ADDITIVE on staging before prod: contact_messages must not already
-- exist. This script only CREATEs new objects and a new RLS policy. It does NOT
-- alter, drop, or modify any existing table, data, column, policy, or relation.
--
-- The prod Supabase MCP is read-only; apply manually (SQL editor / CLI) with a
-- DDL-capable role. No backfill required.

BEGIN;

CREATE OR REPLACE FUNCTION public.trndinn_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.contact_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT,
    email       TEXT NOT NULL,
    company     TEXT,
    message     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'contact_page',
    status      TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'read', 'replied', 'archived', 'spam')),
    meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
    handled_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
    ON public.contact_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_messages_status
    ON public.contact_messages (status, created_at DESC);
DROP TRIGGER IF EXISTS trg_contact_messages_touch_updated_at ON public.contact_messages;
CREATE TRIGGER trg_contact_messages_touch_updated_at
    BEFORE UPDATE ON public.contact_messages
    FOR EACH ROW EXECUTE FUNCTION public.trndinn_touch_updated_at();
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_messages_service_all ON public.contact_messages;
CREATE POLICY contact_messages_service_all ON public.contact_messages
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMIT;
