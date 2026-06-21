-- Rollback Newsletter System Migration

-- Drop foreign key constraint first
ALTER TABLE newsletter_campaigns DROP CONSTRAINT IF EXISTS fk_newsletter_campaigns_template;

-- Drop policies
DROP POLICY IF EXISTS "Public can subscribe" ON newsletter_subscribers;
DROP POLICY IF EXISTS "Admin full access on newsletter_subscribers" ON newsletter_subscribers;
DROP POLICY IF EXISTS "Admin full access on newsletter_campaigns" ON newsletter_campaigns;
DROP POLICY IF EXISTS "Admin full access on newsletter_templates" ON newsletter_templates;
DROP POLICY IF EXISTS "Admin full access on newsletter_imports" ON newsletter_imports;

-- Drop indexes
DROP INDEX IF EXISTS idx_newsletter_subscribers_email;
DROP INDEX IF EXISTS idx_newsletter_subscribers_status;
DROP INDEX IF EXISTS idx_newsletter_subscribers_source;
DROP INDEX IF EXISTS idx_newsletter_subscribers_listmonk_id;
DROP INDEX IF EXISTS idx_newsletter_campaigns_status;
DROP INDEX IF EXISTS idx_newsletter_campaigns_blog_post;
DROP INDEX IF EXISTS idx_newsletter_campaigns_scheduled;
DROP INDEX IF EXISTS idx_newsletter_templates_default;

-- Drop tables
DROP TABLE IF EXISTS newsletter_imports;
DROP TABLE IF EXISTS newsletter_campaigns;
DROP TABLE IF EXISTS newsletter_templates;
DROP TABLE IF EXISTS newsletter_subscribers;
