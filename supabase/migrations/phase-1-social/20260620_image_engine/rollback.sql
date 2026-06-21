DROP POLICY IF EXISTS "Admin full access on post_images" ON post_images;
DROP INDEX IF EXISTS idx_post_images_post;
DROP TABLE IF EXISTS post_images;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS json_ld_schemas;
