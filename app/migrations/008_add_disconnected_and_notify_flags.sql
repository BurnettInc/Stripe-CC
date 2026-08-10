-- 008_add_disconnected_and_notify_flags.sql
--
-- Webhooks & notifications (part 2) — homepage-parity build queue items
-- (3) account.application.deauthorized, (4) payment-received notifications,
-- and dispute idempotency.
--
-- 1. merchants.disconnected: set to 1 when the merchant deauthorizes /
--    disconnects their Stripe account (account.application.deauthorized
--    event). While disconnected, ALL automatic sends are skipped (same
--    behavior as paused) and GET /settings surfaces the flag so the UI can
--    show a reconnect prompt. Read-only from the API — only webhook
--    handling writes it.
--
-- 2. invoices.dispute_id: id of the most recent dispute handled for the
--    invoice — idempotency guard so a replayed charge.dispute.created does
--    not double-notify the merchant. A genuinely NEW dispute (different id)
--    re-notifies.
--
-- 3. invoices.paid_notified: 1 once the merchant has been emailed the
--    payment-received notification for this invoice, so a replayed
--    invoice.paid does not double-notify.
--
-- Data-preserving: adds columns with defaults only, applied at most once via
-- the schema_migrations tracker (same pattern as 006/007).
ALTER TABLE merchants ADD COLUMN disconnected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN dispute_id TEXT DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN paid_notified INTEGER NOT NULL DEFAULT 0;
