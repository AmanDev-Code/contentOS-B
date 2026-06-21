-- Image Engine: post_images table
CREATE TABLE IF NOT EXISTS post_images (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  image_type TEXT NOT NULL CHECK (image_type IN ('featured', 'section', 'infographic', 'social_preview', 'og_image', 'comparison', 'workflow', 'chart')),
  prompt TEXT NOT NULL,
  image_url TEXT,
  alt_text TEXT,
  caption TEXT,
  placement_after_heading TEXT,
  sort_order INT DEFAULT 0,
  status TEXT DEFAULT 'prompt_ready' CHECK (status IN ('prompt_ready', 'generating', 'generated', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_post_images_post ON post_images(post_id);
ALTER TABLE post_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin full access on post_images" ON post_images FOR ALL USING (true) WITH CHECK (true);

-- Schema Engine: json_ld_schemas column on blog_posts
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS json_ld_schemas JSONB;
