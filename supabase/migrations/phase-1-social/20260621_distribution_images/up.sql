-- Distribution Images Enhancement Migration
-- Adds image support and engagement metrics to blog_distributions

-- 1. Add new columns to blog_distributions
ALTER TABLE blog_distributions 
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS inline_images JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hashtags TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS character_count INT,
  ADD COLUMN IF NOT EXISTS seo_score INT,
  ADD COLUMN IF NOT EXISTS engagement_score INT,
  ADD COLUMN IF NOT EXISTS platform_title TEXT,
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false;

-- 2. Add new platforms to the constraint (if not already present)
-- First drop the old constraint
ALTER TABLE blog_distributions DROP CONSTRAINT IF EXISTS blog_distributions_platform_check;

-- Add updated constraint with all platforms
ALTER TABLE blog_distributions ADD CONSTRAINT blog_distributions_platform_check 
  CHECK (platform IN (
    -- Tier 1: Auto-publish
    'linkedin_article', 'linkedin_post', 'medium', 'hashnode', 'devto',
    'ghost', 'beehiiv', 'telegraph', 'blogger',
    -- Tier 2: Submit for review
    'hackernoon', 'towards_ai', 'analytics_vidhya', 'freecodecamp',
    'smashing_magazine', 'sitepoint', 'readwrite', 'yourstory',
    'startuptalky', 'inc42', 'techstory',
    -- Tier 3: Discussion
    'reddit', 'indiehackers', 'producthunt_discussions', 'growthhackers',
    'hackernews', 'huggingface_community',
    -- Legacy/Social
    'substack', 'newsletter', 'twitter_thread', 'facebook', 'instagram'
  ));

-- 3. Create index for faster image lookups
CREATE INDEX IF NOT EXISTS idx_blog_distributions_cover_image 
  ON blog_distributions(post_id) 
  WHERE cover_image_url IS NOT NULL;

-- 4. Add comment for documentation
COMMENT ON COLUMN blog_distributions.cover_image_url IS 'MinIO URL for platform-specific cover/hero image';
COMMENT ON COLUMN blog_distributions.inline_images IS 'Array of {position: number, url: string, alt: string} for section images';
COMMENT ON COLUMN blog_distributions.hashtags IS 'Platform-specific hashtags extracted from content';
COMMENT ON COLUMN blog_distributions.character_count IS 'Total character count of adapted content';
COMMENT ON COLUMN blog_distributions.seo_score IS 'SEO optimization score (0-100)';
COMMENT ON COLUMN blog_distributions.engagement_score IS 'Predicted engagement score (0-100)';
COMMENT ON COLUMN blog_distributions.platform_title IS 'Platform-specific title (may differ from original)';
COMMENT ON COLUMN blog_distributions.is_manual IS 'Whether this platform requires manual posting';
