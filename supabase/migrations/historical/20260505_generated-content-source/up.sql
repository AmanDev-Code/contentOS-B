-- Add source discriminator to generated_content for Custom Topic vs Viral Post.
ALTER TABLE generated_content
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'viral'
  CHECK (source IN ('viral', 'custom'));

CREATE INDEX IF NOT EXISTS idx_generated_content_source
  ON generated_content (user_id, source, created_at DESC);
