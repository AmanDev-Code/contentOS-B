-- Rollback: Remove is_test_user column from profiles table
-- Date: 2026-06-30

-- Drop the index
DROP INDEX IF EXISTS idx_profiles_is_test_user;

-- Drop the column
ALTER TABLE profiles 
DROP COLUMN IF EXISTS is_test_user;
