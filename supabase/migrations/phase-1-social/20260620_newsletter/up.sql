-- Newsletter System Migration
-- Adds newsletter subscribers, campaigns, templates, and import tracking

-- 1. Newsletter Subscribers (synced with Listmonk)
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled', 'blocklisted')),
  listmonk_id INTEGER,
  subscribed_at TIMESTAMPTZ DEFAULT now(),
  source TEXT DEFAULT 'website',
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Newsletter Campaigns
CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  preview_text TEXT,
  body_html TEXT,
  body_text TEXT,
  template_id UUID,
  blog_post_id UUID REFERENCES blog_posts(id) ON DELETE SET NULL,
  listmonk_campaign_id INTEGER,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'sent', 'cancelled')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  total_sent INTEGER DEFAULT 0,
  opens INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  unsubscribes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Newsletter Templates
CREATE TABLE IF NOT EXISTS newsletter_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  html_template TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Newsletter Import History
CREATE TABLE IF NOT EXISTS newsletter_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  total_rows INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_email ON newsletter_subscribers(email);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status ON newsletter_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_source ON newsletter_subscribers(source);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_listmonk_id ON newsletter_subscribers(listmonk_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_campaigns_status ON newsletter_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_newsletter_campaigns_blog_post ON newsletter_campaigns(blog_post_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_campaigns_scheduled ON newsletter_campaigns(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_templates_default ON newsletter_templates(is_default);

-- 6. RLS Policies
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_imports ENABLE ROW LEVEL SECURITY;

-- Public can subscribe (INSERT only)
CREATE POLICY "Public can subscribe" ON newsletter_subscribers
  FOR INSERT WITH CHECK (true);

-- Admin full access on all newsletter tables
CREATE POLICY "Admin full access on newsletter_subscribers" ON newsletter_subscribers
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Admin full access on newsletter_campaigns" ON newsletter_campaigns
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Admin full access on newsletter_templates" ON newsletter_templates
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Admin full access on newsletter_imports" ON newsletter_imports
  FOR ALL USING (true) WITH CHECK (true);

-- 7. Add foreign key constraint for template_id after table creation
ALTER TABLE newsletter_campaigns
  ADD CONSTRAINT fk_newsletter_campaigns_template
  FOREIGN KEY (template_id) REFERENCES newsletter_templates(id) ON DELETE SET NULL;

-- 8. Insert default email template
INSERT INTO newsletter_templates (name, html_template, is_default) VALUES (
  'Default Newsletter',
  '<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ .Subject }}</title>
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; }
    .wrapper { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; }
    .header img { max-width: 150px; height: auto; }
    .header h1 { color: #ffffff; margin: 16px 0 0; font-size: 24px; font-weight: 600; }
    .content { background: #ffffff; padding: 32px 24px; border-radius: 0 0 12px 12px; }
    .content h2 { color: #18181b; font-size: 20px; margin: 0 0 16px; }
    .content p { color: #3f3f46; font-size: 16px; line-height: 1.6; margin: 0 0 16px; }
    .content a { color: #6366f1; text-decoration: none; }
    .content a:hover { text-decoration: underline; }
    .button { display: inline-block; background: #6366f1; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; margin: 16px 0; }
    .button:hover { background: #4f46e5; }
    .footer { text-align: center; padding: 24px; color: #71717a; font-size: 14px; }
    .footer a { color: #71717a; text-decoration: underline; }
    .divider { border: none; border-top: 1px solid #e4e4e7; margin: 24px 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <img src="{{ .LogoURL }}" alt="Trndinn" />
      <h1>{{ .Subject }}</h1>
    </div>
    <div class="content">
      {{ .Body }}
    </div>
    <div class="footer">
      <p>You received this email because you subscribed to Trndinn updates.</p>
      <p><a href="{{ .UnsubscribeURL }}">Unsubscribe</a> | <a href="{{ .PreferencesURL }}">Manage Preferences</a></p>
      <p>&copy; {{ .Year }} Trndinn. All rights reserved.</p>
    </div>
  </div>
</body>
</html>',
  true
) ON CONFLICT DO NOTHING;
