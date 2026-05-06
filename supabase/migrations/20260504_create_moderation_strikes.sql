-- Moderation strikes table for the 3-strike profanity detection system.
-- Stores hashed input text (never plaintext profanity) and matched terms.
CREATE TABLE IF NOT EXISTS moderation_strikes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  attempted_text_hash TEXT NOT NULL,
  matched_terms TEXT[] NOT NULL DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('ui', 'api')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_strikes_user_recent
  ON moderation_strikes (user_id, created_at DESC);
