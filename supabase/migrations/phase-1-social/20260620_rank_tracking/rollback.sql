-- Rollback: Rank Tracking & Backlink Engine

-- Drop triggers
DROP TRIGGER IF EXISTS trigger_backlink_opportunities_updated_at ON backlink_opportunities;
DROP TRIGGER IF EXISTS trigger_backlink_profiles_updated_at ON backlink_profiles;

-- Drop functions
DROP FUNCTION IF EXISTS update_backlink_opportunities_updated_at();
DROP FUNCTION IF EXISTS update_backlink_profiles_updated_at();

-- Drop policies
DROP POLICY IF EXISTS "Admin full access on backlink_opportunities" ON backlink_opportunities;
DROP POLICY IF EXISTS "Admin full access on backlink_profiles" ON backlink_profiles;
DROP POLICY IF EXISTS "Admin full access on keyword_rankings" ON keyword_rankings;

-- Drop indexes
DROP INDEX IF EXISTS idx_backlink_opps_domain;
DROP INDEX IF EXISTS idx_backlink_opps_type;
DROP INDEX IF EXISTS idx_backlink_opps_status;
DROP INDEX IF EXISTS idx_backlink_profiles_platform;
DROP INDEX IF EXISTS idx_backlink_profiles_status;
DROP INDEX IF EXISTS idx_keyword_rankings_position;
DROP INDEX IF EXISTS idx_keyword_rankings_tracked;
DROP INDEX IF EXISTS idx_keyword_rankings_keyword;

-- Drop tables
DROP TABLE IF EXISTS backlink_opportunities;
DROP TABLE IF EXISTS backlink_profiles;
DROP TABLE IF EXISTS keyword_rankings;
