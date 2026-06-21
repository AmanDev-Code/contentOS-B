-- Sync site_content CMS blocks to agentic copy defaults (June 20, 2026)
--
-- When site_content rows exist, the API merges DB JSON over code defaults in
-- backend/src/config/site-content-defaults.ts. After updating code defaults,
-- delete stale overrides so the new agentic copy is served.
--
-- Safe to run on staging/prod. Idempotent. Does NOT touch pricing_meta or
-- custom admin edits you want to keep outside landing/features blocks.
--
-- Alternative: Admin UI → /admin/site → Reset to defaults per section_key.

DELETE FROM public.site_content
WHERE section_key IN (
  'landing_hero',
  'landing_backers',
  'landing_pillars',
  'landing_how',
  'landing_audiences',
  'landing_comparison',
  'landing_secondary_features',
  'landing_stats',
  'landing_integrations',
  'landing_trust',
  'landing_pricing_teaser',
  'landing_faq',
  'features_page',
  'features_roadmap',
  'about_us'
);
