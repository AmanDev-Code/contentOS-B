-- Add `redacted_output` to `generation_training_candidates` so opt-in carousel
-- generations can persist a sanitized snapshot of the structured output (slide
-- titles, visual style, render meta) alongside the redacted prompt.
--
-- Privacy: only rows where the user explicitly opted in (handled application-side
-- in CarouselTrainingCaptureService.record) reach this table. RLS remains
-- service-role-only.

alter table public.generation_training_candidates
  add column if not exists redacted_output text;

comment on column public.generation_training_candidates.redacted_output is
  'Sanitized JSON-serialized output summary (slide titles sample, render meta). NULL on legacy rows.';
