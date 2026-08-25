-- Tool Feedback table — stores star ratings + optional messages per tool per user.
-- One feedback per tool per person (user ID or stable IP hash).

CREATE TABLE IF NOT EXISTS tool_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_slug TEXT NOT NULL,
  identifier TEXT NOT NULL,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('user', 'anonymous')),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  message TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tool_slug, identifier)
);

CREATE INDEX IF NOT EXISTS idx_tool_feedback_slug ON tool_feedback(tool_slug);
CREATE INDEX IF NOT EXISTS idx_tool_feedback_identifier ON tool_feedback(identifier);
CREATE INDEX IF NOT EXISTS idx_tool_feedback_created_at ON tool_feedback(created_at DESC);

-- RLS: service role only (no direct client access)
ALTER TABLE tool_feedback ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (bypasses RLS by default, but explicit for clarity)
CREATE POLICY "service_role_all" ON tool_feedback
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
