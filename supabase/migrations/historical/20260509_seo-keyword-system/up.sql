-- seo_keywords: central keyword library
CREATE TABLE IF NOT EXISTS seo_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL UNIQUE,
  intent TEXT CHECK (intent IN ('informational','commercial','transactional','navigational')) DEFAULT 'informational',
  cluster TEXT,
  priority INTEGER DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
  language TEXT DEFAULT 'en',
  status TEXT DEFAULT 'active' CHECK (status IN ('active','paused','archived','banned')),
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- seo_keyword_assignments: link keywords to pages/routes/blogs
CREATE TABLE IF NOT EXISTS seo_keyword_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id UUID NOT NULL REFERENCES seo_keywords(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('route','page_type','blog_post','template')),
  target_ref TEXT NOT NULL,
  weight INTEGER DEFAULT 50,
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(keyword_id, target_type, target_ref)
);

-- seo_keyword_changes: audit log
CREATE TABLE IF NOT EXISTS seo_keyword_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  payload JSONB,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_seo_keywords_status ON seo_keywords(status);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_cluster ON seo_keywords(cluster);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_intent ON seo_keywords(intent);
CREATE INDEX IF NOT EXISTS idx_seo_keyword_assignments_target ON seo_keyword_assignments(target_type, target_ref);

-- RLS
ALTER TABLE seo_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_keyword_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_keyword_changes ENABLE ROW LEVEL SECURITY;

-- RLS policies: service role can do everything, authenticated users can read
CREATE POLICY "service_role_seo_keywords" ON seo_keywords
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_seo_keyword_assignments" ON seo_keyword_assignments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_seo_keyword_changes" ON seo_keyword_changes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_seo_keywords_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_seo_keywords_updated_at ON seo_keywords;
CREATE TRIGGER trigger_seo_keywords_updated_at
  BEFORE UPDATE ON seo_keywords
  FOR EACH ROW EXECUTE FUNCTION update_seo_keywords_updated_at();
