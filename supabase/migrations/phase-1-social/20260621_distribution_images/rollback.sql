-- Distribution Images Enhancement Rollback

-- Remove new columns
ALTER TABLE blog_distributions 
  DROP COLUMN IF EXISTS cover_image_url,
  DROP COLUMN IF EXISTS inline_images,
  DROP COLUMN IF EXISTS hashtags,
  DROP COLUMN IF EXISTS character_count,
  DROP COLUMN IF EXISTS seo_score,
  DROP COLUMN IF EXISTS engagement_score,
  DROP COLUMN IF EXISTS platform_title,
  DROP COLUMN IF EXISTS is_manual;

-- Drop index
DROP INDEX IF EXISTS idx_blog_distributions_cover_image;

-- Restore original platform constraint
ALTER TABLE blog_distributions DROP CONSTRAINT IF EXISTS blog_distributions_platform_check;
ALTER TABLE blog_distributions ADD CONSTRAINT blog_distributions_platform_check 
  CHECK (platform IN (
    'linkedin_article', 'linkedin_post', 'medium', 'hashnode', 'devto',
    'substack', 'newsletter', 'indiehackers', 'reddit', 'hackernews',
    'twitter_thread', 'facebook', 'instagram'
  ));
