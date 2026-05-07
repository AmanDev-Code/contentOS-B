-- Migration: Create onboarding_questions and onboarding_responses tables
-- This enables admin-managed onboarding questions and tracks user responses

-- ============================================================================
-- Table: onboarding_questions
-- Stores admin-configurable onboarding questions
-- ============================================================================
CREATE TABLE IF NOT EXISTS onboarding_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    step_number INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    question_key TEXT NOT NULL UNIQUE,
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_required BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for ordering questions
CREATE INDEX IF NOT EXISTS idx_onboarding_questions_step_number 
    ON onboarding_questions(step_number);

-- Index for filtering active questions
CREATE INDEX IF NOT EXISTS idx_onboarding_questions_active 
    ON onboarding_questions(is_active) WHERE is_active = true;

-- ============================================================================
-- Table: onboarding_responses
-- Stores user responses to onboarding questions
-- ============================================================================
CREATE TABLE IF NOT EXISTS onboarding_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES onboarding_questions(id) ON DELETE CASCADE,
    selected_option JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, question_id)
);

-- Index for fetching user's responses
CREATE INDEX IF NOT EXISTS idx_onboarding_responses_user_id 
    ON onboarding_responses(user_id);

-- Index for analytics on specific questions
CREATE INDEX IF NOT EXISTS idx_onboarding_responses_question_id 
    ON onboarding_responses(question_id);

-- ============================================================================
-- RLS Policies
-- ============================================================================

-- Enable RLS on both tables
ALTER TABLE onboarding_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_responses ENABLE ROW LEVEL SECURITY;

-- onboarding_questions: Anyone can read active questions (for the wizard)
CREATE POLICY "Anyone can read active onboarding questions"
    ON onboarding_questions
    FOR SELECT
    USING (is_active = true);

-- onboarding_responses: Users can read their own responses
CREATE POLICY "Users can read own onboarding responses"
    ON onboarding_responses
    FOR SELECT
    USING (auth.uid() = user_id);

-- onboarding_responses: Users can insert their own responses
CREATE POLICY "Users can insert own onboarding responses"
    ON onboarding_responses
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- onboarding_responses: Users can update their own responses
CREATE POLICY "Users can update own onboarding responses"
    ON onboarding_responses
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- Trigger: Auto-update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_onboarding_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_onboarding_questions_updated_at
    BEFORE UPDATE ON onboarding_questions
    FOR EACH ROW
    EXECUTE FUNCTION update_onboarding_updated_at();

CREATE TRIGGER trigger_onboarding_responses_updated_at
    BEFORE UPDATE ON onboarding_responses
    FOR EACH ROW
    EXECUTE FUNCTION update_onboarding_updated_at();

-- ============================================================================
-- Seed: Insert default onboarding questions (matching current hardcoded ones)
-- ============================================================================
INSERT INTO onboarding_questions (step_number, question_text, question_key, options, is_required, is_active)
VALUES
    (1, 'Who are you?', 'role', '[
        {"value": "founder", "label": "Founder / Entrepreneur"},
        {"value": "marketer", "label": "Marketer"},
        {"value": "creator", "label": "Creator"},
        {"value": "agency", "label": "Agency"},
        {"value": "student", "label": "Student / Learner"}
    ]'::jsonb, true, true),
    
    (2, 'Why are you using Trndinn?', 'goal', '[
        {"value": "brand_growth", "label": "Grow personal or company brand"},
        {"value": "lead_generation", "label": "Generate leads"},
        {"value": "consistency", "label": "Post consistently"},
        {"value": "team_output", "label": "Scale team content output"}
    ]'::jsonb, true, true),
    
    (3, 'What is your team size?', 'teamSize', '[
        {"value": "solo", "label": "Solo"},
        {"value": "2_5", "label": "2 - 5 people"},
        {"value": "6_20", "label": "6 - 20 people"},
        {"value": "20_plus", "label": "20+ people"}
    ]'::jsonb, true, true),
    
    (4, 'How often do you want to publish?', 'postingFrequency', '[
        {"value": "daily", "label": "Daily"},
        {"value": "3_per_week", "label": "3 times a week"},
        {"value": "weekly", "label": "Weekly"},
        {"value": "flexible", "label": "Flexible / not sure yet"}
    ]'::jsonb, true, true),
    
    (5, 'Which content type do you want to focus on first?', 'focusArea', '[
        {"value": "text_posts", "label": "Text posts"},
        {"value": "image_posts", "label": "Image posts"},
        {"value": "carousel", "label": "Carousel posts"},
        {"value": "mixed", "label": "Mix of all formats"}
    ]'::jsonb, true, true),
    
    (6, 'How did you hear about us?', 'referralSource', '[
        {"value": "search", "label": "Search / SEO"},
        {"value": "social", "label": "Social media"},
        {"value": "friend", "label": "Friend / colleague"},
        {"value": "community", "label": "Community / group"},
        {"value": "other", "label": "Other"}
    ]'::jsonb, false, true)
ON CONFLICT (question_key) DO NOTHING;

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE onboarding_questions IS 'Admin-managed onboarding questions shown to new users';
COMMENT ON COLUMN onboarding_questions.step_number IS 'Order in which questions appear (1-based)';
COMMENT ON COLUMN onboarding_questions.question_key IS 'Unique identifier used in code (e.g., role, goal)';
COMMENT ON COLUMN onboarding_questions.options IS 'JSON array of {value, label, icon?} objects';
COMMENT ON COLUMN onboarding_questions.is_required IS 'Whether user must answer to proceed';
COMMENT ON COLUMN onboarding_questions.is_active IS 'Soft delete - inactive questions are hidden';

COMMENT ON TABLE onboarding_responses IS 'User responses to onboarding questions';
COMMENT ON COLUMN onboarding_responses.selected_option IS 'The selected option value (string or object)';
