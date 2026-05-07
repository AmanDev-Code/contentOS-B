-- Migration: Create referral system tables
-- Enables affiliate referral program with admin controls

-- ============================================================================
-- Table: referral_settings
-- Admin-controlled settings for the referral program
-- ============================================================================
CREATE TABLE IF NOT EXISTS referral_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credits_per_referral INTEGER NOT NULL DEFAULT 50,
    min_actions_to_complete INTEGER NOT NULL DEFAULT 1,
    is_program_active BOOLEAN NOT NULL DEFAULT true,
    terms_and_conditions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert default settings (singleton row)
INSERT INTO referral_settings (credits_per_referral, min_actions_to_complete, is_program_active, terms_and_conditions)
VALUES (50, 1, true, 'Refer friends to Trndinn and earn credits! When your referred user completes their first content generation, you''ll receive bonus credits.')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Table: referral_codes
-- Stores unique referral codes for each user
-- ============================================================================
CREATE TABLE IF NOT EXISTS referral_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id)
);

-- Index for looking up codes
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);

-- ============================================================================
-- Table: referrals
-- Tracks who referred whom and the status of each referral
-- ============================================================================
CREATE TYPE referral_status AS ENUM ('pending', 'completed', 'credited', 'expired');

CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    referred_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    referral_code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
    status referral_status NOT NULL DEFAULT 'pending',
    credits_awarded INTEGER DEFAULT 0,
    actions_completed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    credited_at TIMESTAMPTZ,
    UNIQUE(referred_user_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_user_id ON referrals(referred_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_created_at ON referrals(created_at DESC);

-- ============================================================================
-- Table: referral_banners
-- Promotional banners for the referral program
-- ============================================================================
CREATE TABLE IF NOT EXISTS referral_banners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    image_url TEXT NOT NULL,
    link_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for ordering banners
CREATE INDEX IF NOT EXISTS idx_referral_banners_order ON referral_banners(display_order, created_at);

-- ============================================================================
-- RLS Policies
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE referral_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_banners ENABLE ROW LEVEL SECURITY;

-- referral_settings: Anyone can read (for displaying terms, checking if active)
CREATE POLICY "Anyone can read referral settings"
    ON referral_settings
    FOR SELECT
    USING (true);

-- referral_codes: Users can read their own code
CREATE POLICY "Users can read own referral code"
    ON referral_codes
    FOR SELECT
    USING (auth.uid() = user_id);

-- referral_codes: Anyone can validate a code (for signup)
CREATE POLICY "Anyone can validate referral codes"
    ON referral_codes
    FOR SELECT
    USING (is_active = true);

-- referrals: Users can read referrals where they are the referrer
CREATE POLICY "Users can read referrals they made"
    ON referrals
    FOR SELECT
    USING (auth.uid() = referrer_id);

-- referrals: Users can see if they were referred
CREATE POLICY "Users can see their own referral"
    ON referrals
    FOR SELECT
    USING (auth.uid() = referred_user_id);

-- referral_banners: Anyone can read active banners
CREATE POLICY "Anyone can read active referral banners"
    ON referral_banners
    FOR SELECT
    USING (is_active = true);

-- ============================================================================
-- Triggers: Auto-update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_referral_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_referral_settings_updated_at
    BEFORE UPDATE ON referral_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_referral_updated_at();

CREATE TRIGGER trigger_referral_codes_updated_at
    BEFORE UPDATE ON referral_codes
    FOR EACH ROW
    EXECUTE FUNCTION update_referral_updated_at();

CREATE TRIGGER trigger_referral_banners_updated_at
    BEFORE UPDATE ON referral_banners
    FOR EACH ROW
    EXECUTE FUNCTION update_referral_updated_at();

-- ============================================================================
-- Function: Generate unique referral code
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_referral_code(p_user_id UUID, p_username TEXT DEFAULT NULL)
RETURNS TEXT AS $$
DECLARE
    v_code TEXT;
    v_attempts INTEGER := 0;
    v_max_attempts INTEGER := 10;
BEGIN
    -- Try username-based code first if username provided
    IF p_username IS NOT NULL AND length(p_username) >= 2 THEN
        v_code := upper(p_username) || '-' || substring(md5(random()::text) from 1 for 4);
        -- Check if unique
        IF NOT EXISTS (SELECT 1 FROM referral_codes WHERE code = v_code) THEN
            RETURN v_code;
        END IF;
    END IF;
    
    -- Fall back to TRND-XXXXX format
    LOOP
        v_code := 'TRND-' || upper(substring(md5(random()::text || p_user_id::text) from 1 for 5));
        
        -- Check if unique
        IF NOT EXISTS (SELECT 1 FROM referral_codes WHERE code = v_code) THEN
            RETURN v_code;
        END IF;
        
        v_attempts := v_attempts + 1;
        IF v_attempts >= v_max_attempts THEN
            -- Use longer code if having trouble
            v_code := 'TRND-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
            RETURN v_code;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function: Get or create referral code for user
-- ============================================================================
CREATE OR REPLACE FUNCTION get_or_create_referral_code(p_user_id UUID, p_username TEXT DEFAULT NULL)
RETURNS TABLE (
    id UUID,
    user_id UUID,
    code TEXT,
    is_active BOOLEAN,
    usage_count INTEGER,
    created_at TIMESTAMPTZ
) AS $$
DECLARE
    v_code TEXT;
    v_record referral_codes%ROWTYPE;
BEGIN
    -- Check if user already has a code
    SELECT * INTO v_record FROM referral_codes rc WHERE rc.user_id = p_user_id;
    
    IF FOUND THEN
        RETURN QUERY SELECT v_record.id, v_record.user_id, v_record.code, 
                            v_record.is_active, v_record.usage_count, v_record.created_at;
        RETURN;
    END IF;
    
    -- Generate new code
    v_code := generate_referral_code(p_user_id, p_username);
    
    -- Insert new code
    INSERT INTO referral_codes (user_id, code)
    VALUES (p_user_id, v_code)
    RETURNING * INTO v_record;
    
    RETURN QUERY SELECT v_record.id, v_record.user_id, v_record.code, 
                        v_record.is_active, v_record.usage_count, v_record.created_at;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function: Process referral completion
-- Called when referred user completes qualifying action
-- ============================================================================
CREATE OR REPLACE FUNCTION process_referral_completion(p_referred_user_id UUID)
RETURNS TABLE (
    success BOOLEAN,
    referrer_id UUID,
    credits_awarded INTEGER,
    message TEXT
) AS $$
DECLARE
    v_referral referrals%ROWTYPE;
    v_settings referral_settings%ROWTYPE;
    v_new_actions INTEGER;
BEGIN
    -- Get referral record
    SELECT * INTO v_referral FROM referrals r 
    WHERE r.referred_user_id = p_referred_user_id AND r.status IN ('pending', 'completed');
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::UUID, 0, 'No pending referral found for this user';
        RETURN;
    END IF;
    
    -- Get settings
    SELECT * INTO v_settings FROM referral_settings LIMIT 1;
    
    IF NOT v_settings.is_program_active THEN
        RETURN QUERY SELECT false, NULL::UUID, 0, 'Referral program is currently inactive';
        RETURN;
    END IF;
    
    -- Increment actions completed
    v_new_actions := v_referral.actions_completed + 1;
    
    -- Check if enough actions to complete
    IF v_new_actions >= v_settings.min_actions_to_complete AND v_referral.status = 'pending' THEN
        -- Mark as completed
        UPDATE referrals 
        SET status = 'completed', 
            actions_completed = v_new_actions,
            completed_at = now()
        WHERE id = v_referral.id;
        
        -- Award credits to referrer
        UPDATE referrals 
        SET status = 'credited',
            credits_awarded = v_settings.credits_per_referral,
            credited_at = now()
        WHERE id = v_referral.id;
        
        -- Increment usage count on referral code
        UPDATE referral_codes 
        SET usage_count = usage_count + 1 
        WHERE id = v_referral.referral_code_id;
        
        RETURN QUERY SELECT true, v_referral.referrer_id, v_settings.credits_per_referral, 
                            'Referral completed and credits awarded';
    ELSE
        -- Just update actions count
        UPDATE referrals 
        SET actions_completed = v_new_actions
        WHERE id = v_referral.id;
        
        RETURN QUERY SELECT true, v_referral.referrer_id, 0, 
                            format('Action recorded (%s/%s)', v_new_actions, v_settings.min_actions_to_complete);
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- View: Referral stats for a user
-- ============================================================================
CREATE OR REPLACE VIEW user_referral_stats AS
SELECT 
    rc.user_id,
    rc.code,
    rc.usage_count,
    rc.is_active,
    COALESCE(stats.total_referred, 0) as total_referred,
    COALESCE(stats.pending_count, 0) as pending_count,
    COALESCE(stats.completed_count, 0) as completed_count,
    COALESCE(stats.total_credits_earned, 0) as total_credits_earned
FROM referral_codes rc
LEFT JOIN (
    SELECT 
        referrer_id,
        COUNT(*) as total_referred,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status IN ('completed', 'credited')) as completed_count,
        COALESCE(SUM(credits_awarded), 0) as total_credits_earned
    FROM referrals
    GROUP BY referrer_id
) stats ON stats.referrer_id = rc.user_id;

-- ============================================================================
-- View: Admin referral analytics
-- ============================================================================
CREATE OR REPLACE VIEW admin_referral_analytics AS
SELECT 
    (SELECT COUNT(*) FROM referrals) as total_referrals,
    (SELECT COUNT(*) FROM referrals WHERE created_at >= date_trunc('month', now())) as referrals_this_month,
    (SELECT COUNT(*) FROM referrals WHERE status = 'pending') as pending_referrals,
    (SELECT COUNT(*) FROM referrals WHERE status IN ('completed', 'credited')) as completed_referrals,
    (SELECT COALESCE(SUM(credits_awarded), 0) FROM referrals) as total_credits_awarded,
    (SELECT COUNT(*) FROM referral_codes) as total_referral_codes,
    CASE 
        WHEN (SELECT COUNT(*) FROM referrals) > 0 
        THEN ROUND(
            (SELECT COUNT(*) FROM referrals WHERE status IN ('completed', 'credited'))::numeric / 
            (SELECT COUNT(*) FROM referrals)::numeric * 100, 2
        )
        ELSE 0 
    END as conversion_rate;

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE referral_settings IS 'Admin-controlled settings for the referral program (singleton)';
COMMENT ON TABLE referral_codes IS 'Unique referral codes for each user';
COMMENT ON TABLE referrals IS 'Tracks referral relationships and their status';
COMMENT ON TABLE referral_banners IS 'Promotional banners displayed on the referral page';

COMMENT ON COLUMN referral_settings.credits_per_referral IS 'Credits awarded to referrer when referral completes';
COMMENT ON COLUMN referral_settings.min_actions_to_complete IS 'Number of qualifying actions (e.g., generations) needed to complete referral';

COMMENT ON COLUMN referrals.status IS 'pending=signed up, completed=did qualifying action, credited=credits awarded, expired=timed out';
COMMENT ON COLUMN referrals.actions_completed IS 'Number of qualifying actions the referred user has completed';
