-- Recovery/response-rate outcome tracking (owner direction 2026-08-17:
-- "start the habit at the first real user — the plumbing must exist BEFORE
-- launch"). Admin-side telemetry ONLY: no merchant-facing UI, no behavior
-- change to any existing flow. Applied at most once via the schema_migrations
-- tracker (same pattern as 014/017/018).
--
-- 1. invoices.ever_overdue — a sticky flag (0/1) recording that an invoice
--    EVER appeared in the overdue pipeline locally (upserted with status
--    'overdue' by the webhook overdue path, the invoice-sync pass, or the
--    install backfill). The flag is monotonic: once set it is never cleared
--    (the status column itself only holds the CURRENT status, so 'paid' rows
--    would otherwise lose all evidence they were ever chased). Set inside
--    upsertInvoice whenever the incoming status is 'overdue'; the migration
--    backfills it for invoices that are overdue at migration time so metrics
--    are accurate from the moment the column exists.
--
-- 2. recovery_events — one row per invoice that (a) was EVER overdue
--    (ever_overdue = 1) and (b) later became PAID (recorded by the webhook
--    invoice.paid handler with source 'webhook', or by the scheduler's
--    invoice-sync status reconciliation with source 'sync'). Each row freezes
--    the outcome facts at payment time:
--      merchant_id       — which merchant recovered the money
--      invoice_id        — local invoices.id (UNIQUE → idempotent per invoice)
--      stripe_invoice_id — denormalized Stripe id for human debugging
--      amount_cents/currency — the invoice amount as stored locally
--      due_date          — YYYY-MM-DD (the watcher's date convention)
--      paid_at           — ISO timestamp of when we observed the payment
--                          (webhook: Stripe's status_transitions.paid_at when
--                          present, else event-received time; sync: the sync
--                          run time)
--      days_to_payment   — paid_at − due_date in whole days (NULL when the
--                          due_date is missing/unparseable)
--      reminder_sent     — 1 if ≥1 reminder email was successfully sent for
--                          this invoice before payment (send_logs type
--                          'reminder' status 'success'), else 0
--      stage_reached     — highest escalation stage reached (1/2/3; 0 if no
--                          task was ever created — e.g. cap/draft-blocked)
--      source            — 'webhook' | 'sync'
--    Idempotent per invoice: the UNIQUE(invoice_id) constraint + INSERT OR
--    IGNORE in recordRecoveryEvent (db.ts) make webhook replays, double
--    delivery (webhook AND sync both observing the same payment), and
--    scheduler re-runs all no-ops — the first writer wins.
--
-- Data-preserving: plain additive column + new table, applied at most once.
ALTER TABLE invoices ADD COLUMN ever_overdue INTEGER NOT NULL DEFAULT 0;
-- Backfill the sticky flag for invoices already overdue when this lands, so
-- their future payment records a recovery event (nothing is ever deleted or
-- modified on existing rows — this only sets a brand-new column).
UPDATE invoices SET ever_overdue = 1 WHERE status = 'overdue';
CREATE TABLE IF NOT EXISTS recovery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id),
  stripe_invoice_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  due_date TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL,
  days_to_payment INTEGER,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  stage_reached INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'webhook' CHECK(source IN ('webhook', 'sync')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_events_merchant ON recovery_events(merchant_id);
CREATE INDEX IF NOT EXISTS idx_recovery_events_paid_at ON recovery_events(paid_at);
CREATE INDEX IF NOT EXISTS idx_recovery_events_currency ON recovery_events(currency);
