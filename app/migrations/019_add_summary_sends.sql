-- Scheduler: per-merchant weekly-summary send ledger (PROMISES_AUDIT #26).
--
-- The weekly-recovery-report promise ("Weekly recovery reports" on Standard
-- and Pro) needs a per-merchant cadence state: send_logs rows for weekly
-- summaries carry reminder_task_id = NULL (merchant-level notifications) so
-- they cannot be attributed to a merchant. This table records every
-- scheduled send attempt (scheduler pass only) keyed by merchant, so the
-- summary pass can enforce "at most once per 7 days" and stagger merchants
-- by their actual send history.
--
--   merchant_id  — the merchant the summary was generated for
--   sent_at      — when the scheduler attempted the send (SQLite datetime)
--   status       — 'sent' | 'failed' (send_email result; 'sent' even in
--                  log-only provider mode — the send path executed)
--   detail       — sendResult.message / error text
--
-- Data-preserving: plain additive table, applied at most once via the
-- schema_migrations tracker (same pattern as 014/017/018).
CREATE TABLE IF NOT EXISTS summary_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent', 'failed')),
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_summary_sends_merchant ON summary_sends(merchant_id);
