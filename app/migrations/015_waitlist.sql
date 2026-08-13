-- Waitlist email capture for the landing page (replaces the /stripe/connect
-- CTAs with a permanent signup-interest list). Applied once via the
-- schema_migrations tracker; CREATE TABLE IF NOT EXISTS keeps a re-run a
-- clean no-op.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
