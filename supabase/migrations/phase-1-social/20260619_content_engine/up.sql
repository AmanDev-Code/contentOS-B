-- Content Engine Phase 1 Migration
-- Adds content clusters, distribution tracking, and quality scores

-- 1. Content Clusters
CREATE TABLE IF NOT EXISTS content_clusters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  pillar_keyword TEXT NOT NULL,
  pillar_post_id UUID REFERENCES blog_posts(id) ON DELETE SET NULL,
  description TEXT,
  status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'in_progress', 'complete')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_content_clusters_status ON content_clusters(status);

-- 2. Content Cluster Articles (supporting articles per cluster)
CREATE TABLE IF NOT EXISTS content_cluster_articles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cluster_id UUID NOT NULL REFERENCES content_clusters(id) ON DELETE CASCADE,
  post_id UUID REFERENCES blog_posts(id) ON DELETE SET NULL,
  keyword TEXT NOT NULL,
  title_suggestion TEXT,
  sort_order INT DEFAULT 0,
  is_pillar BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'writing', 'published', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_cluster_articles_cluster ON content_cluster_articles(cluster_id);
CREATE INDEX idx_cluster_articles_post ON content_cluster_articles(post_id);

-- 3. Blog Distributions (multi-platform publishing)
CREATE TABLE IF NOT EXISTS blog_distributions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN (
    'linkedin_article', 'linkedin_post', 'medium', 'hashnode', 'devto',
    'substack', 'newsletter', 'indiehackers', 'reddit', 'hackernews',
    'twitter_thread', 'facebook', 'instagram'
  )),
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'generating', 'ready', 'published', 'failed', 'skipped'
  )),
  adapted_content TEXT,
  published_url TEXT,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  canonical_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(post_id, platform)
);

CREATE INDEX idx_blog_distributions_post ON blog_distributions(post_id);
CREATE INDEX idx_blog_distributions_status ON blog_distributions(status);

-- 4. Quality Score Columns on blog_posts
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS seo_score INT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS aeo_score INT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS geo_score INT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS eeat_score INT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS readability_score INT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS quality_score INT;

-- 5. RLS Policies (admin-only for all content engine tables)
ALTER TABLE content_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_cluster_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_distributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access on content_clusters"
  ON content_clusters FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admin full access on content_cluster_articles"
  ON content_cluster_articles FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admin full access on blog_distributions"
  ON blog_distributions FOR ALL
  USING (true)
  WITH CHECK (true);
