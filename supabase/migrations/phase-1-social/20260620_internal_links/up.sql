-- Internal Link Suggestions table for the Content Engine Internal Linking feature
CREATE TABLE IF NOT EXISTS internal_link_suggestions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  target_post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  anchor_text TEXT NOT NULL,
  context_sentence TEXT,
  relevance_score FLOAT DEFAULT 0,
  status TEXT DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'rejected', 'inserted')),
  inserted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_post_id, target_post_id, anchor_text)
);

CREATE INDEX idx_internal_links_source ON internal_link_suggestions(source_post_id);
CREATE INDEX idx_internal_links_target ON internal_link_suggestions(target_post_id);
CREATE INDEX idx_internal_links_status ON internal_link_suggestions(status);

ALTER TABLE internal_link_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin full access on internal_link_suggestions" ON internal_link_suggestions FOR ALL USING (true) WITH CHECK (true);
