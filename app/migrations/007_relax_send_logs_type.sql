-- 007_relax_send_logs_type.sql
--
-- Relax the send_logs.type CHECK constraint so merchant account notifications
-- (type 'merchant_notification' and any future types) can be logged.
--
-- Original schema pinned type to CHECK(type IN ('reminder', 'weekly_summary')).
-- SQLite cannot alter a CHECK constraint in place, so rebuild the table
-- (data-preserving). Runs at most once via the schema_migrations tracker.
--
-- NOTE: after this migration the type column is free-form TEXT
-- (NOT NULL DEFAULT 'reminder', no CHECK) — arbitrary strings are allowed.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE send_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_task_id INTEGER REFERENCES reminder_tasks(id),
  type TEXT NOT NULL DEFAULT 'reminder',
  status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'skipped')),
  provider_message TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO send_logs_new (id, reminder_task_id, type, status, provider_message, created_at)
  SELECT id, reminder_task_id, type, status, provider_message, created_at FROM send_logs;

DROP TABLE send_logs;

ALTER TABLE send_logs_new RENAME TO send_logs;

COMMIT;

PRAGMA foreign_keys=ON;
