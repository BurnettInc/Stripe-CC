-- Lifetime Pro giveaway (owner direction 2026-08): the owner can grant exactly
-- 10 lifetime free Pro accounts by handing out ONE special checkout link that
-- carries promo=LIFETIME10. Whoever completes that checkout earns a real Pro
-- subscription at $0 forever (live coupon EiubBz3c, percent_off=100,
-- duration=forever, nickname "Lifetime 100% (10 giveaway)"). This is the
-- sibling of the founding-quota pattern (migrations/023): eligibility is by
-- SUBSCRIPTION CREATION ORDER, earned atomically with a single guarded
-- INSERT ... SELECT (WHERE COUNT(*) < 10), so concurrent checkout
-- completions can never oversubscribe beyond 10. A merchant gets at most ONE
-- row (merchant_id PRIMARY KEY — the benefit is per-merchant, lifetime, and
-- follows them across plan changes).
--
--   merchant_id            PK — one row per free-Pro merchant
--   subscription_id        UNIQUE — the Stripe subscription that earned the slot
--   account_email          the merchant's Stripe account email at grant time
--   created_at             when the slot was earned (subscription creation time)
CREATE TABLE IF NOT EXISTS lifetime_members (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id),
  subscription_id TEXT NOT NULL UNIQUE,
  account_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
