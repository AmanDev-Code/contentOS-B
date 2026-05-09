-- Add extended author fields to blog_posts
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author_bio TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author_avatar_url TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author_role TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author_linkedin_url TEXT;
