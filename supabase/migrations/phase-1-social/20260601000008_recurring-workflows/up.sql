-- Migration: 20260601000008 — recurring_workflows
-- Sprint 1.2. Proper RFC 5545 RRULE recurrence (NOT the intervalInDays
-- shortcut that republishes the same row indefinitely).
--
-- Each occurrence is materialized as a fresh `posts` row CLONED from
-- `template_post_id`. That keeps history queryable per occurrence and lets a
-- user edit a single occurrence without affecting future ones.

BEGIN;

CREATE TABLE IF NOT EXISTS public.recurring_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    template_post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    rrule TEXT NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    occurrences_max INT,
    occurrences_run INT NOT NULL DEFAULT 0 CHECK (occurrences_run >= 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recurring_workflows_end_after_start
        CHECK (end_at IS NULL OR end_at > start_at)
);

COMMENT ON TABLE public.recurring_workflows
    IS 'RFC 5545 RRULE-based recurring post schedule. Each occurrence clones template_post_id into a new posts row.';
COMMENT ON COLUMN public.recurring_workflows.rrule
    IS 'RFC 5545 RRULE string, e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12. Validated client-side; server stores opaque.';
COMMENT ON COLUMN public.recurring_workflows.next_run_at
    IS 'Materialization time of the next occurrence. Cron worker selects WHERE status=''active'' AND next_run_at <= NOW().';
COMMENT ON COLUMN public.recurring_workflows.occurrences_max
    IS 'Optional hard cap. When occurrences_run >= occurrences_max, status flips to ''completed''.';

CREATE INDEX IF NOT EXISTS idx_recurring_workflows_status_next_run
    ON public.recurring_workflows(status, next_run_at)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recurring_workflows_user
    ON public.recurring_workflows(user_id);

DROP TRIGGER IF EXISTS trg_recurring_workflows_touch_updated_at ON public.recurring_workflows;
CREATE TRIGGER trg_recurring_workflows_touch_updated_at
    BEFORE UPDATE ON public.recurring_workflows
    FOR EACH ROW
    EXECUTE FUNCTION public.trndinn_touch_updated_at();

ALTER TABLE public.recurring_workflows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_workflows_select_own ON public.recurring_workflows;
CREATE POLICY recurring_workflows_select_own
    ON public.recurring_workflows
    FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS recurring_workflows_insert_own ON public.recurring_workflows;
CREATE POLICY recurring_workflows_insert_own
    ON public.recurring_workflows
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS recurring_workflows_update_own ON public.recurring_workflows;
CREATE POLICY recurring_workflows_update_own
    ON public.recurring_workflows
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS recurring_workflows_delete_own ON public.recurring_workflows;
CREATE POLICY recurring_workflows_delete_own
    ON public.recurring_workflows
    FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS recurring_workflows_service_all ON public.recurring_workflows;
CREATE POLICY recurring_workflows_service_all
    ON public.recurring_workflows
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
