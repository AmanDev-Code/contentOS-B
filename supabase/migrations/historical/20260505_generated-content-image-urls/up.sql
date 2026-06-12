-- Store multiple generated image URLs for custom-topic image posts.
-- Users pick the best image(s) from this array in the modal.
ALTER TABLE generated_content
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';
