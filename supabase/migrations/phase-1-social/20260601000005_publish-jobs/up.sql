-- Migration: 20260601000005 — publish_jobs
-- Sprint 1.2. Durable companion to BullMQ for every publish attempt.
--
-- Why we keep BOTH BullMQ and a DB row:
--   * BullMQ holds the live job (delays, retries, concurrency limits).
--   * publish_jobs holds the durable history that survives Redis flushes,
--     answers "is this stuck?" for the missed-job sweeper, and gives Support
--     a single source of truth without scraping Redis.
--
-- `bullmq_job_id` is intentionally TEXT, not a FK — Redis is the only authority
-- for that id and we never want a DB-level join to it.

BEGIN;

CREATE TABLE IF NOT EXISTS public.publish_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_target_id UUID NOT NULL REFERENCES public.post_targets(id) ON DELETE CASCADE,
    bullmq_job_id TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
    attempt SMALLINT NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    error_message TEXT,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.publish_jobs
    IS 'Durable history of every publish attempt. One row per attempt — successive retries create new rows with incrementing `attempt`.';
COMMENT ON COLUMN public.publish_jobs.bullmq_job_id
    IS 'BullMQ job id (Redis key). NOT a foreign key — Redis is the source of truth for live state.';
COMMENT ON COLUMN public.publish_jobs.status
    IS 'queued | running | succeeded | failed | dead_letter. dead_letter is terminal: human intervention required.';
COMMENT ON COLUMN public.publish_jobs.next_retry_at
    IS 'When set, the missed-job sweeper will re-enqueue if BullMQ has lost the delayed job (e.g. after a Redis restart).';

-- Sweeper index: scan only rows that have a future retry scheduled.
CREATE INDEX IF NOT EXISTS idx_publish_jobs_sweeper
    ON public.publish_jobs(next_retry_at)
    WHERE status IN ('queued', 'failed') AND next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_publish_jobs_target_attempt
    ON public.publish_jobs(post_target_id, attempt DESC);

ALTER TABLE public.publish_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS publish_jobs_service_all ON public.publish_jobs;
CREATE POLICY publish_jobs_service_all
    ON public.publish_jobs
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
