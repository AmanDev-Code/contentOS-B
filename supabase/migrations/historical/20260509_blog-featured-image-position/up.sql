-- Optional crop focal point for featured image on listings and hero (CSS object-position).
alter table public.blog_posts
  add column if not exists featured_image_object_position text;

comment on column public.blog_posts.featured_image_object_position is
  'CSS object-position preset for featured image crops: left, center, right, top, bottom; null uses product defaults (listings anchor right).';
