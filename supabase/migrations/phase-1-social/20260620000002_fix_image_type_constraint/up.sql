-- Fix image_type constraint to include new visual types
ALTER TABLE post_images DROP CONSTRAINT IF EXISTS post_images_image_type_check;
ALTER TABLE post_images ADD CONSTRAINT post_images_image_type_check 
  CHECK (image_type IN ('featured', 'section', 'infographic', 'social_preview', 'og_image', 'comparison', 'workflow', 'chart'));
