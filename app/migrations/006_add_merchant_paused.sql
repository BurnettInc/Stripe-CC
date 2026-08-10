-- Merchant-level pause flag. When a merchant pauses collections, AUTOMATIC
-- sends (Semi-Auto Stage 1 and Full Auto) are skipped — the task stays in
-- place (status 'reviewed') so it resumes when unpaused. Manual actions
-- (POST /tasks/:id/approve, POST /summary/send) are NOT blocked by pause.
ALTER TABLE merchants ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
