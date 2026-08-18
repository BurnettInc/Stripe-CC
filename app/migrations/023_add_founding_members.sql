-- Founding Member Offer (owner direction 8/13+8/14+8/17, Phase A 2026-08-18):
-- the FIRST 50 subscriptions EVER (across both plans) earn lifetime 50% off
-- both plans (live coupon BIywdq7e, percent_off=50, duration=forever) plus 90
-- days of priority support. Eligibility is by SUBSCRIPTION CREATION ORDER —
-- no claim race. Slots are earned atomically: the webhook inserts rows with a
-- single guarded INSERT ... SELECT (WHERE COUNT(*) < 50), so concurrent
-- checkout completions can never oversubscribe beyond 50. A merchant gets at
-- most ONE row (merchant_id PRIMARY KEY — the benefit is per-merchant,
-- lifetime, and follows them across plan changes).
--
--   merchant_id            PK — one row per founding merchant
--   subscription_id        UNIQUE — the Stripe subscription that earned the slot
--   created_at             when the slot was earned (subscription creation time)
--   priority_support_until support-lookup marker: created_at + 90 days
CREATE TABLE IF NOT EXISTS founding_members (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id),
  subscription_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  priority_support_until TEXT NOT NULL
);
