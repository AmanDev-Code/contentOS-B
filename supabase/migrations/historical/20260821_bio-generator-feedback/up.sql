-- Bio Generator feedback — anonymous thumbs-up / thumbs-down per generated bio.
--
-- Design notes:
--   * No FK to auth.users — the bio-generator is a public, anonymous tool.
--     We key on a SHA-256 hash of (client_ip + daily_salt) so we can rate-
--     limit and dedupe without ever storing raw IPs.
--   * The full dimensional context of the generation (platform, angle, tone,
--     focus_areas, emojis, bio_type) is denormalized onto every row so admin
--     analytics can cross-tab "which angle wins on LinkedIn with emojis on?"
--     with a single indexed query — no joins to a generations table.
--   * `bio_text` is nullable and truncated in the service layer; we keep a
--     snapshot so admins can eyeball what people are voting on. RLS is service-
--     role only, so it never leaks back to the anon client.

CREATE TYPE bio_feedback_vote AS ENUM ('up', 'down');
CREATE TYPE bio_feedback_platform AS ENUM (
  'linkedin', 'instagram', 'twitter', 'tiktok', 'github', 'youtube', 'general'
);
CREATE TYPE bio_feedback_angle AS ENUM (
  'credibility', 'outcome', 'positioning', 'direction'
);
CREATE TYPE bio_feedback_bio_type AS ENUM ('personal', 'brand');

CREATE TABLE IF NOT EXISTS public.bio_generator_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Rotating daily salt + client IP hashed with SHA-256. Service layer computes
  -- this — the raw IP never lands in Postgres.
  ip_hash text NOT NULL,

  -- Client-supplied generation id so a browser session can undo/change a vote.
  -- Nullable because we don't require it (older clients may omit it).
  generation_id text,

  -- Dimensional context — all denormalized for fast admin roll-ups.
  vote          bio_feedback_vote     NOT NULL,
  platform      bio_feedback_platform NOT NULL,
  angle         bio_feedback_angle    NOT NULL,
  tone          text                  NOT NULL,
  bio_type      bio_feedback_bio_type NOT NULL DEFAULT 'personal',
  variation_index integer CHECK (variation_index IS NULL OR (variation_index >= 0 AND variation_index <= 3)),
  focus_areas   text[]                NOT NULL DEFAULT ARRAY[]::text[],
  emojis        boolean               NOT NULL DEFAULT false,

  -- Snapshot of the actual bio being voted on. Truncated at 500 chars server-side.
  bio_text      text,
  bio_length    integer,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Query patterns the admin dashboard uses:
--   * WHERE platform = ? GROUP BY vote           → per-platform up/down counts
--   * WHERE platform = ? AND angle = ?           → angle × platform cross-tab
--   * WHERE focus_areas @> ARRAY['credibility']  → per-focus performance
--   * ORDER BY created_at DESC LIMIT 50          → recent feedback stream
CREATE INDEX IF NOT EXISTS bio_feedback_platform_idx     ON public.bio_generator_feedback (platform);
CREATE INDEX IF NOT EXISTS bio_feedback_angle_idx        ON public.bio_generator_feedback (angle);
CREATE INDEX IF NOT EXISTS bio_feedback_tone_idx         ON public.bio_generator_feedback (tone);
CREATE INDEX IF NOT EXISTS bio_feedback_vote_idx         ON public.bio_generator_feedback (vote);
CREATE INDEX IF NOT EXISTS bio_feedback_created_at_idx   ON public.bio_generator_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS bio_feedback_ip_hash_idx      ON public.bio_generator_feedback (ip_hash);
CREATE INDEX IF NOT EXISTS bio_feedback_generation_idx   ON public.bio_generator_feedback (generation_id) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bio_feedback_focus_areas_gin  ON public.bio_generator_feedback USING gin (focus_areas);

-- One vote per (ip_hash, generation_id, variation_index). Flipping a thumb
-- results in an UPDATE, not a duplicate INSERT — service uses an upsert on
-- this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS bio_feedback_unique_vote
  ON public.bio_generator_feedback (ip_hash, generation_id, variation_index)
  WHERE generation_id IS NOT NULL AND variation_index IS NOT NULL;

COMMENT ON TABLE public.bio_generator_feedback IS
  'Anonymous thumbs-up/thumbs-down feedback on bio-generator output. IP is hashed with a daily salt before storage. Only surfaced to admin dashboards, never to end users.';

-- RLS: service role only. Anon users write via the NestJS controller which
-- uses the service key; they never touch this table directly.
ALTER TABLE public.bio_generator_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON public.bio_generator_feedback
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
