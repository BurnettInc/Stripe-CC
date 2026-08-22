-- Beta-code redemption (owner 8/21) — self-serve tester unlock. A merchant who
-- redeems a valid, single-use code is granted the dev-only Pro preview flag
-- (merchants.dev_pro=1) so they get an active Pro plan with no subscription row
-- and no card (the whole app already treats dev_pro=1 as Pro). This lets the
-- team distribute test access by minting codes (POST /api/beta/mint) instead of
-- hand-editing the DB, and gives testers a user-facing redeem flow
-- (POST /api/beta/redeem + the dashboard "Beta tester?" card).
--
-- beta_codes:
--   code        UNIQUE, exact (trimmed) match on redeem. Mint is idempotent.
--   label       optional human note (e.g. tester name) for admin bookkeeping.
--   max_uses    how many redemptions this code allows (default 1 = single-use).
--   used        how many redemptions have been claimed (atomic, guarded).
--   expires_at  optional UTC datetime 'YYYY-MM-DD HH:MM:SS'; NULL = never.
--   active      1 = redeemable. Hard-deactivating (0) reads as "invalid".
--
-- beta_redemptions: append-only audit trail of every redemption
--   (which code -> which merchant, when). No FK cascade by design so the
--   audit survives even if a merchant/code row is later removed.
CREATE TABLE IF NOT EXISTS beta_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS beta_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beta_code_id INTEGER NOT NULL REFERENCES beta_codes(id),
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
