-- Anonymized training dataset candidates (append-only).
--
-- PR / compliance note: Do NOT enable storage of user prompts or outputs for model
-- training without explicit product + legal review. Writes MUST satisfy BOTH:
--   (1) env TRAINING_CAPTURE_ENABLED=true (default false in deployment), AND
--   (2) per-request user opt-in (e.g. trainingDataCaptureOptIn / future profile.training_consent).
-- Silent logging of all generations is intentionally NOT implemented.
--
-- RLS: enabled with NO policies for authenticated users — only service_role (backend)
-- should insert/select. Add read policies only for locked-down staff roles if needed.

create table if not exists public.generation_training_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id_hash text not null,
  generation_id_hash text,
  redacted_prompt text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.generation_training_candidates is
  'Hashed identifiers + redacted topic/prompt for opt-in, env-gated training corpus candidates.';

create index if not exists idx_generation_training_candidates_created
  on public.generation_training_candidates (created_at desc);

alter table public.generation_training_candidates enable row level security;
