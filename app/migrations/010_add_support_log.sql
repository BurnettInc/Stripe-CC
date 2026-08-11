-- Support first-response log (support backend pack): lets the Support agent
-- record inbound support mail and outbound replies so the Pro
-- same-business-day first-response promise can be measured honestly.
-- Idempotent (CREATE TABLE IF NOT EXISTS) — the schema_migrations tracker
-- also ensures this file runs at most once per database.
CREATE TABLE IF NOT EXISTS support_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
  note TEXT DEFAULT NULL,
  responded_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_log_email ON support_log(email);
