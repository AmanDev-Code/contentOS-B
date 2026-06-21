-- Platform Accounts: stores per-platform credentials for content distribution
CREATE TABLE IF NOT EXISTS platform_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN (
    'linkedin_article', 'linkedin_post', 'medium', 'hashnode', 'devto',
    'substack', 'newsletter', 'indiehackers', 'reddit', 'hackernews',
    'twitter_thread', 'facebook', 'instagram'
  )),
  account_name TEXT NOT NULL,
  credentials JSONB DEFAULT '{}'::jsonb,
  is_connected BOOLEAN DEFAULT false,
  last_tested_at TIMESTAMPTZ,
  last_test_result TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(platform)
);

ALTER TABLE platform_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access on platform_accounts"
  ON platform_accounts FOR ALL
  USING (true)
  WITH CHECK (true);
