-- Live/Test mode isolation (reviewer fix #5, 2026-08-18).
--
-- Every invoices row is tagged with the Stripe mode it came from so the app
-- drawer can render ONLY the active mode's data (Live vs Test). Stripe's
-- reviewer: "when opened from the Stripe Dashboard app drawer, the app fetches
-- records without isolating by mode, combining Live and Test invoices/customers
-- in one view."
--
--   livemode INTEGER NOT NULL DEFAULT 1  — 1 = live (the default: ALL existing
--     rows were written before the mode concept and are live — correct), 0 = test.
--
-- The (merchant_id, livemode) index makes every mode-scoped drawer query
-- (WHERE merchant_id = ? AND livemode = ?) index-covered, and it is the
-- natural key for the sync pass which now pulls each mode separately.
ALTER TABLE invoices ADD COLUMN livemode INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_invoices_merchant_livemode ON invoices(merchant_id, livemode);
