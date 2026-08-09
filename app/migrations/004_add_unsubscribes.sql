-- CAN-SPAM opt-out tracking.
-- A row means "this customer has opted out of reminders for this merchant".
-- Idempotent (CREATE TABLE IF NOT EXISTS) so it is safe even if schema.sql
-- already created the table on a fresh database.
CREATE TABLE IF NOT EXISTS unsubscribes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  customer_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(merchant_id, customer_email)
);

CREATE INDEX IF NOT EXISTS idx_unsubscribes_merchant ON unsubscribes(merchant_id);
