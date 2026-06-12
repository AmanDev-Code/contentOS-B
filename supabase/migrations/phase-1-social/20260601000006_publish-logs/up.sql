-- Migration: 20260601000006 — publish_logs
-- Sprint 1.2. Append-only event log for every publish-related action.
--
-- Logs successes AND failures. The chaos soak in Sprint 1.10 needs end-to-end
-- timing data, and Support needs "what exactly did we send to LinkedIn?"
-- without re-running a publish.

BEGIN;

CREATE TABLE IF NOT EXISTS public.publish_logs (
    id BIGSERIAL PRIMARY KEY,
    post_target_id UUID REFERENCES public.post_targets(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.publish_logs
    IS 'Append-only event log: job_started, http_request, http_response, platform_error, success, retry_scheduled, dead_lettered.';
COMMENT ON COLUMN public.publish_logs.event_type
    IS 'Stable enum-ish string. Add new values via migration; never rename existing ones (downstream alerting subscribes by exact value).';
COMMENT ON COLUMN public.publish_logs.payload
    IS 'Per-event structured data. SCRUB sensitive headers (Authorization) before insert.';

CREATE INDEX IF NOT EXISTS idx_publish_logs_target_created_at
    ON public.publish_logs(post_target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_logs_event_type_created_at
    ON public.publish_logs(event_type, created_at DESC);

ALTER TABLE public.publish_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS publish_logs_service_all ON public.publish_logs;
CREATE POLICY publish_logs_service_all
    ON public.publish_logs
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
