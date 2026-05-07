-- General user feedback table (allows multiple submissions per user)
-- Separate from product_feedback which is one-time first-post feedback

CREATE TYPE feedback_type AS ENUM ('bug', 'feature', 'general', 'other');
CREATE TYPE feedback_status AS ENUM ('new', 'reviewed', 'resolved');

CREATE TABLE IF NOT EXISTS public.user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  type feedback_type NOT NULL DEFAULT 'general',
  message text NOT NULL,
  rating integer CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  status feedback_status NOT NULL DEFAULT 'new',
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_feedback_user_id_idx ON public.user_feedback (user_id);
CREATE INDEX IF NOT EXISTS user_feedback_created_at_idx ON public.user_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS user_feedback_status_idx ON public.user_feedback (status);
CREATE INDEX IF NOT EXISTS user_feedback_type_idx ON public.user_feedback (type);

COMMENT ON TABLE public.user_feedback IS 'General user feedback submissions - users can submit multiple times';

-- Enable RLS
ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;

-- Users can insert their own feedback
CREATE POLICY "Users can insert own feedback"
  ON public.user_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own feedback
CREATE POLICY "Users can view own feedback"
  ON public.user_feedback
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role has full access (for admin operations)
CREATE POLICY "Service role full access"
  ON public.user_feedback
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_user_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_feedback_updated_at_trigger
  BEFORE UPDATE ON public.user_feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_user_feedback_updated_at();
