-- Content Engine Phase 1 Rollback

DROP POLICY IF EXISTS "Admin full access on blog_distributions" ON blog_distributions;
DROP POLICY IF EXISTS "Admin full access on content_cluster_articles" ON content_cluster_articles;
DROP POLICY IF EXISTS "Admin full access on content_clusters" ON content_clusters;

DROP TABLE IF EXISTS blog_distributions;
DROP TABLE IF EXISTS content_cluster_articles;
DROP TABLE IF EXISTS content_clusters;

ALTER TABLE blog_posts DROP COLUMN IF EXISTS seo_score;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS aeo_score;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS geo_score;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS eeat_score;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS readability_score;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS quality_score;
