-- Migration: 20260601000010 — webhook_deliveries
-- Sprint 1.2. Per-attempt delivery log + retry state for outbound webhooks.

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
    id BIGSERIAL PRIMARY KEY,
    webhook_id UUID NOT NULL REFERENCES public.webhooks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    request_signature TEXT,
    attempt SMALLINT NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'succeeded', 'failed', 'dead_letter')),
    response_status_code SMALLINT,
    response_body_truncated TEXT,
    next_retry_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.webhook_deliveries
    IS 'Per-attempt delivery log. One row per attempt; retries create new rows. dead_letter is terminal.';
COMMENT ON COLUMN public.webhook_deliveries.request_signature
    IS 'HMAC-SHA256 signature emitted in the X-Trndinn-Signature header for this delivery. Stored for audit.';
COMMENT ON COLUMN public.webhook_deliveries.response_body_truncated
    IS 'First 4 KiB of response body, for forensics. Truncate at insert time, not at read.';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next_retry
    ON public.webhook_deliveries(status, next_retry_at)
    WHERE status IN ('pending', 'failed') AND next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_created_at
    ON public.webhook_deliveries(webhook_id, created_at DESC);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_deliveries_service_all ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_service_all
    ON public.webhook_deliveries
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
