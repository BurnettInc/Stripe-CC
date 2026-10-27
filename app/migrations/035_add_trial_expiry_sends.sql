-- Free-trial expiry email engine: per-merchant, per-touchpoint send ledger.
--
-- The trial-expiry pass (pipeline/trial-expiry.ts) fires a short arc of
-- reminder emails as a merchant's 30-day free trial runs out (T-7 / T-3 / T-1 /
-- T-0, a day-10 check-in on the idle track, and an optional T+3 win-back).
-- Each (merchant, touchpoint) may be sent AT MOST ONCE EVER, so the pass needs
-- its own ledger — send_logs rows cannot carry this: type='trial_expiry' rows
-- are a mail trail, and every digest-style query over send_logs must stay
-- unaffected by dedupe bookkeeping.
--
--   merchant_id — the merchant the email belongs to
--   touchpoint  — mid_trial_checkin | t_minus_7 | t_minus_3 | t_minus_1 |
--                 t_zero | t_plus_3
--   status      — 'reserved' while a send is in flight, 'sent' once it went
--                 out. A FAILED send deletes its reservation (delete is scoped
--                 to status='reserved') so a later tick may retry; a sent row
--                 is never removed, which is what makes the UNIQUE pair
--                 "at most once, ever".
--   sent_at     — when the row was last written (SQLite datetime, UTC)
--   detail      — the provider's result message (audit trail)
--
-- Data-preserving: plain additive table, applied at most once via the
-- schema_migrations tracker (same pattern as 019/034). purgeMerchantData
-- deletes this merchant's rows, so the FK can never block a data-rights purge.
CREATE TABLE IF NOT EXISTS trial_expiry_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  touchpoint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'sent')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  detail TEXT NOT NULL DEFAULT '',
  UNIQUE(merchant_id, touchpoint)
);
CREATE INDEX IF NOT EXISTS idx_trial_expiry_sends_merchant ON trial_expiry_sends(merchant_id);
