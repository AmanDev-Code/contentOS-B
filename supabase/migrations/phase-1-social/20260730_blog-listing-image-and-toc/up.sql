-- Separate listing image for blog index cards (16:10 aspect, falls back to featured_image_url)
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS listing_image_url TEXT;

-- Table of Contents structured data (auto-extracted from headings or manually curated)
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS toc_json JSONB;

-- Object position for listing image (same format as featured_image_object_position)
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS listing_image_object_position TEXT;

COMMENT ON COLUMN public.blog_posts.listing_image_url IS
  'Optimized image for blog index/listing cards (16:10 ~1200x750). Falls back to featured_image_url when null.';

COMMENT ON COLUMN public.blog_posts.toc_json IS
  'Array of {label, anchor} for Table of Contents sidebar. Auto-extracted from H2 headings or manually edited.';

COMMENT ON COLUMN public.blog_posts.listing_image_object_position IS
  'CSS object-position for listing image crop. Same format as featured_image_object_position: preset keyword or x,y percentages.';
