-- Freemium draft cap: durable per-merchant counter of lifetime drafts used.
-- Replaces the derived task-status count, which was silently reset whenever
-- tasks got cancelled on invoice escalation (createReminderTask cancels prior
-- tasks for the same invoice). Backfill counts every task that ever reached a
-- drafted state, including ones later cancelled by escalation.

ALTER TABLE merchants ADD COLUMN drafts_used INTEGER NOT NULL DEFAULT 0;

UPDATE merchants SET drafts_used = (
  SELECT COUNT(DISTINCT rt.id) FROM reminder_tasks rt
  JOIN invoices i ON i.id = rt.invoice_id
  WHERE i.merchant_id = merchants.id
    AND rt.status IN ('drafted', 'reviewed', 'sent', 'cancelled')
) WHERE drafts_used = 0;
