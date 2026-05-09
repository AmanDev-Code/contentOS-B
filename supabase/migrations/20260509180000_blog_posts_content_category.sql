-- Editorial / marketing taxonomy for blog cards (distinct from post_kind structural type).
alter table public.blog_posts
  add column if not exists content_category text null;

comment on column public.blog_posts.content_category is
  'Marketing category label shown on cards (Product, Growth, SEO, etc.); nullable.';
