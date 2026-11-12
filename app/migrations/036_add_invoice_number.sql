-- Customer-facing invoice number (Stripe's invoice.number, e.g. "INV-0042").
--
-- Reminder subjects and bodies used to quote Stripe's INTERNAL id (in_1UMHv…),
-- a token the customer has never seen. Stripe assigns `number` only when an
-- invoice is finalized, so it is NULL for drafts and for any row not yet
-- re-synced: customer copy must then OMIT the number entirely rather than fall
-- back to the id (see invoiceNumberFor in src/db.ts).
ALTER TABLE invoices ADD COLUMN invoice_number TEXT DEFAULT NULL;
