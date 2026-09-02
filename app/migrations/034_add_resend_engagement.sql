-- Resend open/click engagement tracking (2026-09): per sent reminder, record
-- whether the recipient opened it and/or clicked a link inside it, surfaced as
-- a small status in the /reminders dashboard history.
--
-- Columns on send_logs:
--   resend_message_id — the id Resend returned from POST /emails (the API
--       email id, `data.email_id` in Resend webhook events; `data.message_id`
--       is the RFC Message-ID header and is only used as a fallback key). NULL
--       for non-Resend sends, stub sends, and any send logged before this
--       migration (those rows honestly show "No data" rather than a fabricated
--       "Not opened").
--   opened_at / clicked_at — ISO timestamps, set ONLY on the first event of
--       that kind (the guard against double-setting on webhook retries).
--   open_count / click_count — incrementing counters, safe to bump once per
--       event even when Resend redelivers.
-- UNIQUE on resend_message_id (partial index — SQLite has no partial UNIQUE
-- syntax for the column itself, and NULLs must stay non-unique so the many
-- non-Resend rows can't collide). Applied once via the schema_migrations
-- tracker (same pattern as 033's ADD COLUMN — SQLite has no ADD COLUMN IF NOT
-- EXISTS, so a re-run fails loudly rather than silently corrupting).
ALTER TABLE send_logs ADD COLUMN resend_message_id TEXT;
ALTER TABLE send_logs ADD COLUMN opened_at TEXT;
ALTER TABLE send_logs ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_logs ADD COLUMN clicked_at TEXT;
ALTER TABLE send_logs ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_send_logs_resend_message_id
  ON send_logs(resend_message_id)
  WHERE resend_message_id IS NOT NULL AND resend_message_id != '';