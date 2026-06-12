-- Rollback: 20260607000001 — scheduled_posts actor columns
--
-- Drops only the two columns this migration added. Safe because nothing else
-- depends on them (readers tolerate their absence via BullMQ-job fallback).

BEGIN;

ALTER TABLE public.scheduled_posts DROP COLUMN IF EXISTS organization_urn;
ALTER TABLE public.scheduled_posts DROP COLUMN IF EXISTS actor_type;

COMMIT;
