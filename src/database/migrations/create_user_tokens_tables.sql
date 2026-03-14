-- Create user_verification_tokens table
CREATE TABLE IF NOT EXISTS user_verification_tokens (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    type VARCHAR(50) NOT NULL, -- 'email_verification', 'password_reset'
    used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create user_invitations table
CREATE TABLE IF NOT EXISTS user_invitations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    inviter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    token VARCHAR(255) NOT NULL UNIQUE,
    accepted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_verification_tokens_user_id ON user_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_verification_tokens_token ON user_verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_user_verification_tokens_type ON user_verification_tokens(type);
CREATE INDEX IF NOT EXISTS idx_user_verification_tokens_expires_at ON user_verification_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_user_invitations_inviter_id ON user_invitations(inviter_id);
CREATE INDEX IF NOT EXISTS idx_user_invitations_email ON user_invitations(email);
CREATE INDEX IF NOT EXISTS idx_user_invitations_token ON user_invitations(token);
CREATE INDEX IF NOT EXISTS idx_user_invitations_expires_at ON user_invitations(expires_at);

-- Enable RLS
ALTER TABLE user_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;

-- Policies for user_verification_tokens
CREATE POLICY "Service role can manage verification tokens" ON user_verification_tokens
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view their own verification tokens" ON user_verification_tokens
    FOR SELECT USING (user_id = auth.uid());

-- Policies for user_invitations  
CREATE POLICY "Service role can manage invitations" ON user_invitations
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view their own invitations" ON user_invitations
    FOR SELECT USING (inviter_id = auth.uid());

CREATE POLICY "Users can view invitations sent to their email" ON user_invitations
    FOR SELECT USING (email = auth.jwt() ->> 'email');

-- Function to clean up expired tokens (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void AS $$
BEGIN
    DELETE FROM user_verification_tokens WHERE expires_at < NOW();
    DELETE FROM user_invitations WHERE expires_at < NOW() AND accepted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;