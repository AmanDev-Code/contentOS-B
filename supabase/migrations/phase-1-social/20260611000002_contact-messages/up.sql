-- Migration: 20260611000002 — contact-messages (Phase 1.5 GTM contact form)
--
-- ADDITIVE-ONLY. Introduces a single new table that stores public contact-form
-- submissions from /contact. Touches NO existing table, policy, column, or
-- relation.
--
-- New objects (all new):
--   * public.contact_messages — inbound contact-form submissions. Written by the
--       backend service role (RLS bypassed). No public read; anon/auth cannot
--       select rows directly. Notification + acknowledgement emails are sent via
--       the existing SMTP2GO EmailService; this table is the durable record.

BEGIN;

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

COMMENT ON TABLE public.contact_messages IS
    'Phase 1.5: inbound contact-form submissions from the public /contact page. Written by the backend service role; no public read. Notification emails go out via SMTP2GO EmailService.';

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
    ON public.contact_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_messages_status
    ON public.contact_messages (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_contact_messages_touch_updated_at ON public.contact_messages;
CREATE TRIGGER trg_contact_messages_touch_updated_at
    BEFORE UPDATE ON public.contact_messages
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- Service role only. No public SELECT/INSERT policies: anon/auth cannot read or
-- write directly; all writes flow through the backend service client.
DROP POLICY IF EXISTS contact_messages_service_all ON public.contact_messages;
CREATE POLICY contact_messages_service_all
    ON public.contact_messages
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
