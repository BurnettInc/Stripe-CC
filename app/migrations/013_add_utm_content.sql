-- Capture utm_content on landing-page visits (channel attribution follow-up,
-- owner request 2026-08-13). The tracked-links cheat sheet tags URLs with
-- utm_content=<post-name> (e.g. reddit-saas vs reddit-entrepreneur) so the
-- owner can see post-level detail in the admin raw-visits table. Applied at
-- most once via the schema_migrations tracker (pattern of 008-012); the
-- column is nullable-with-default so pre-existing rows are untouched and the
-- UNIQUE(visitor_id, page, ts) dedupe index is unaffected.
ALTER TABLE page_visits ADD COLUMN utm_content TEXT DEFAULT '';
