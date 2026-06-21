DROP POLICY IF EXISTS "Admin full access on internal_link_suggestions" ON internal_link_suggestions;
DROP INDEX IF EXISTS idx_internal_links_status;
DROP INDEX IF EXISTS idx_internal_links_target;
DROP INDEX IF EXISTS idx_internal_links_source;
DROP TABLE IF EXISTS internal_link_suggestions;
