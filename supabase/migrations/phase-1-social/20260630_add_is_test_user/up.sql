-- Migration: Add is_test_user column to profiles table
-- Purpose: Enable user-level mock publishing for soak test users only
-- Author: AI Assistant
-- Date: 2026-06-30

-- Add is_test_user column to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS is_test_user BOOLEAN DEFAULT FALSE;

-- Add index for efficient querying of test users
CREATE INDEX IF NOT EXISTS idx_profiles_is_test_user 
ON profiles(is_test_user) 
WHERE is_test_user = TRUE;

-- Add comment explaining the column
COMMENT ON COLUMN profiles.is_test_user IS 
'Flags soak test users. When TRUE, LinkedIn publishing uses mock mode regardless of MOCK_LINKEDIN_PUBLISH env var.';
