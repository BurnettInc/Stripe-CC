CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_merchant ON sessions(merchant_id);
