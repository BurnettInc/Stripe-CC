-- Reply-pause + AI reply handling (owner spec 2026-08-12; D1a backend).
--
-- Two pieces:
--   1. invoices.reply_paused_at / invoices.reply_opt_out_at — per-invoice
--      sequence pause/opt-out flags. reply_paused_at is set the moment a
--      customer reply is captured (D1a); reply_opt_out_at is set by the D1b
--      opt_out classification and stops THIS invoice's reminders only (never
--      the global unsubscribe table). Both are TEXT (ISO timestamps) and both
--      are written from the inbound pipeline, never the API.
--   2. inbound_replies — one row per captured customer reply to the tracked
--      Reply-To (reply+{invoice_id}@replies.getcollectionscopilot.com). D1a
--      writes rows with reply_status 'captured'; the D1b AI layer fills the
--      classification/confidence/draft columns and advances reply_status.
--      The idempotency_key UNIQUE index makes the inbound webhook retry-safe
--      (the worker may re-deliver; INSERT OR IGNORE + changes==0 detects the
--      duplicate).
--
-- reply_status state machine (D1b transitions documented here so the AI layer
-- needs no schema change):
--   captured          -> initial state, set by D1a when the reply is stored.
--   pending_approval  -> D1b classified the reply (question-low-confidence /
--                        other) and drafted a response held for merchant
--                        approve/edit/reject.
--   auto_sent         -> D1b question + high confidence + Full Auto: the
--                        drafted response was sent automatically.
--   sent              -> D1b draft sent after merchant approval (or the
--                        merchant approved an auto-draft).
--   rejected          -> D1b merchant rejected the drafted response.
--   handled           -> terminal: merchant resolved the thread / opt-out
--                        confirmation sent / no response needed.
--
-- Data-preserving: CREATE TABLE IF NOT EXISTS + plain ALTERs, applied at most
-- once via the schema_migrations tracker (same pattern as 008/009/010).
ALTER TABLE invoices ADD COLUMN reply_paused_at TEXT DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN reply_opt_out_at TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS inbound_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  sequence_key TEXT NOT NULL,               -- the reply+ tag as string (invoice internal DB id)
  received_at TEXT NOT NULL,                -- ISO timestamp of the customer's reply
  from_email TEXT NOT NULL,
  from_name TEXT DEFAULT NULL,
  subject TEXT DEFAULT NULL,
  body TEXT NOT NULL,                       -- plain-text reply body
  raw_message TEXT DEFAULT NULL,            -- JSON string: full original message the worker captured (optional)
  idempotency_key TEXT NOT NULL UNIQUE,     -- provider_message_id if the worker sent one, else derived hash
  classification TEXT DEFAULT NULL,         -- D1b: payment_claim | dispute | question | opt_out | other
  confidence REAL DEFAULT NULL,             -- D1b: 0..1 classification confidence
  draft_reply_subject TEXT DEFAULT NULL,    -- D1b: AI-drafted response subject
  draft_reply_body TEXT DEFAULT NULL,       -- D1b: AI-drafted response body
  reply_status TEXT NOT NULL DEFAULT 'captured'
    CHECK(reply_status IN ('captured','pending_approval','auto_sent','rejected','sent','handled')),
  handled_at TEXT DEFAULT NULL,             -- D1b: when the reply reached a terminal state
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbound_replies_invoice ON inbound_replies(invoice_id);
CREATE INDEX IF NOT EXISTS idx_inbound_replies_status ON inbound_replies(reply_status);
