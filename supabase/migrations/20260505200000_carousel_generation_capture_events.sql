-- Internal product-side capture for carousel / custom-topic improving & evaluation datasets.
-- Writes use the service role from the backend; RLS blocks direct client access.

create table if not exists public.carousel_generation_capture_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  generation_job_id uuid references public.generation_jobs (id) on delete set null,
  event_type text not null,
  consent_opt_in boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.carousel_generation_capture_events is
  'Internal events for curating in-app training/eval data; not automatic vendor retraining.';

create index if not exists idx_carousel_capture_job
  on public.carousel_generation_capture_events (generation_job_id);

create index if not exists idx_carousel_capture_user_created
  on public.carousel_generation_capture_events (user_id, created_at desc);

alter table public.carousel_generation_capture_events enable row level security;
