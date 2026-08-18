-- Stripe review round-2 fix #2: 'uncollectible' becomes a first-class
-- invoice status (reviewer's listing claim: "reminders halt automatically
-- when an invoice status changes to paid, void, disputed, or uncollectible").
--
-- The invoices.status CHECK previously allowed only ('open','paid','void',
-- 'overdue'), so Stripe's 'uncollectible' collapsed into 'void' on sync and
-- was indistinguishable from a true void. SQLite cannot ALTER a CHECK
-- constraint — the table must be rebuilt with the widened CHECK
-- ('open','paid','void','overdue','uncollectible').
--
-- The rebuild copies EVERY existing column (including the migration-added
-- ones: trust_mode_override, dispute_id, paid_notified, refund_id,
-- reply_paused_at, reply_opt_out_at, manually_paused_at, ever_overdue) and
-- re-creates idx_invoices_merchant (DROP TABLE drops it with the old table).
-- foreign_keys must be OFF during the swap: invoices is a parent of
-- reminder_tasks / inbound_replies / recovery_events, and DROP TABLE would
-- fail (or be unsafe) with FK enforcement on.
--
-- Backfill note (conservative, per review): existing 'void' rows were ALREADY
-- stopped by the scheduler path (isInvoiceSequenceStopped / reconcile treat
-- 'void' as terminal) — no row-level backfill is needed; the rebuild is
-- byte-for-byte data-preserving. Applied at most once via the
-- schema_migrations tracker (same pattern as 011/020).
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE invoices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  customer_name TEXT NOT NULL DEFAULT 'Unknown',
  customer_email TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  due_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'paid', 'void', 'overdue', 'uncollectible')),
  trust_mode_override TEXT DEFAULT NULL CHECK(trust_mode_override IN ('draft', 'semi', 'full')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dispute_id TEXT DEFAULT NULL,
  paid_notified INTEGER NOT NULL DEFAULT 0,
  refund_id TEXT DEFAULT NULL,
  reply_paused_at TEXT DEFAULT NULL,
  reply_opt_out_at TEXT DEFAULT NULL,
  manually_paused_at TEXT DEFAULT NULL,
  ever_overdue INTEGER NOT NULL DEFAULT 0
);
INSERT INTO invoices_new (id, stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, trust_mode_override, created_at, dispute_id, paid_notified, refund_id, reply_paused_at, reply_opt_out_at, manually_paused_at, ever_overdue)
  SELECT id, stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, trust_mode_override, created_at, dispute_id, paid_notified, refund_id, reply_paused_at, reply_opt_out_at, manually_paused_at, ever_overdue FROM invoices;
DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;
CREATE INDEX IF NOT EXISTS idx_invoices_merchant ON invoices(merchant_id);
COMMIT;
PRAGMA foreign_keys=ON;
