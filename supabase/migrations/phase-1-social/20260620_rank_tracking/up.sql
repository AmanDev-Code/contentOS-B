-- Rank Tracking & Backlink Engine Migration
-- Adds keyword rank tracking and backlink opportunity management

-- 1. Keyword Rank Tracking
CREATE TABLE IF NOT EXISTS keyword_rankings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword_id UUID REFERENCES seo_keywords(id) ON DELETE CASCADE,
  post_id UUID REFERENCES blog_posts(id) ON DELETE SET NULL,
  position INT,
  previous_position INT,
  search_engine TEXT DEFAULT 'google' CHECK (search_engine IN ('google', 'bing', 'duckduckgo')),
  country TEXT DEFAULT 'US',
  tracked_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_keyword_rankings_keyword ON keyword_rankings(keyword_id);
CREATE INDEX idx_keyword_rankings_tracked ON keyword_rankings(tracked_at);
CREATE INDEX idx_keyword_rankings_position ON keyword_rankings(position);

-- 2. Backlink Profiles (platforms where we have profiles)
CREATE TABLE IF NOT EXISTS backlink_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL,
  profile_url TEXT,
  status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'created', 'verified', 'inactive')),
  domain_authority INT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_backlink_profiles_status ON backlink_profiles(status);
CREATE INDEX idx_backlink_profiles_platform ON backlink_profiles(platform);

-- 3. Backlink Opportunities
CREATE TABLE IF NOT EXISTS backlink_opportunities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_domain TEXT NOT NULL,
  source_url TEXT,
  opportunity_type TEXT CHECK (opportunity_type IN ('guest_post', 'resource_page', 'broken_link', 'competitor_backlink', 'directory', 'mention')),
  target_post_id UUID REFERENCES blog_posts(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'identified' CHECK (status IN ('identified', 'outreach_sent', 'in_progress', 'acquired', 'rejected', 'expired')),
  domain_authority INT,
  contact_email TEXT,
  notes TEXT,
  outreach_sent_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_backlink_opps_status ON backlink_opportunities(status);
CREATE INDEX idx_backlink_opps_type ON backlink_opportunities(opportunity_type);
CREATE INDEX idx_backlink_opps_domain ON backlink_opportunities(source_domain);

-- 4. RLS Policies
ALTER TABLE keyword_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access on keyword_rankings"
  ON keyword_rankings FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admin full access on backlink_profiles"
  ON backlink_profiles FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admin full access on backlink_opportunities"
  ON backlink_opportunities FOR ALL
  USING (true)
  WITH CHECK (true);

-- 5. Updated_at triggers
CREATE OR REPLACE FUNCTION update_backlink_profiles_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_backlink_profiles_updated_at ON backlink_profiles;
CREATE TRIGGER trigger_backlink_profiles_updated_at
  BEFORE UPDATE ON backlink_profiles
  FOR EACH ROW EXECUTE FUNCTION update_backlink_profiles_updated_at();

CREATE OR REPLACE FUNCTION update_backlink_opportunities_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_backlink_opportunities_updated_at ON backlink_opportunities;
CREATE TRIGGER trigger_backlink_opportunities_updated_at
  BEFORE UPDATE ON backlink_opportunities
  FOR EACH ROW EXECUTE FUNCTION update_backlink_opportunities_updated_at();
