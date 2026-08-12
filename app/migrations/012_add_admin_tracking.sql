-- Internal admin-only customer tracking (owner request 2026-08-12) —
-- backend-only, no stripe-app changes. Two additive tables, applied at most
-- once via the schema_migrations tracker (pattern of 008–011). Both use
-- CREATE TABLE IF NOT EXISTS so they are also idempotent on their own.
--
-- 1. page_visits — first-party, privacy-minimal landing-page visit tracking.
--    POST /api/track stores one row per page load: visitor_id (a random UUID
--    the landing-page snippet generates and keeps in localStorage), page,
--    referrer, utm_source/medium/campaign and ts (client ISO timestamp). No
--    IP, no UA, no cookies are ever sent or stored. The UNIQUE(visitor_id,
--    page, ts) index makes the endpoint idempotent-ish: a retried beacon with
--    the same payload (ts is generated per page load, so identical ts means
--    the same visit) is a no-op instead of a duplicate row.
--
-- 2. subscription_events — append-only lifecycle log for OUR OWN Stripe
--    Billing subscriptions ($15 Standard / $29 Pro). Every
--    checkout.session.completed ('created'), customer.subscription.updated
--    ('updated') and customer.subscription.deleted ('cancelled') webhook
--    writes a row here with tier/status and a timestamp, so subscription
--    created / updated / cancelled each carry their own time (the
--    subscriptions table itself only has created_at). Existing rows in
--    subscriptions/merchants/etc are never modified — this is purely additive.
CREATE TABLE IF NOT EXISTS page_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  page TEXT NOT NULL,
  referrer TEXT DEFAULT '',
  utm_source TEXT DEFAULT '',
  utm_medium TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_visits_visitor ON page_visits(visitor_id);
CREATE INDEX IF NOT EXISTS idx_page_visits_ts ON page_visits(ts);
CREATE UNIQUE INDEX IF NOT EXISTS uq_page_visits_dedupe ON page_visits(visitor_id, page, ts);

CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  stripe_subscription_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('created', 'updated', 'cancelled')),
  tier TEXT DEFAULT NULL,
  status TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_merchant ON subscription_events(merchant_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_ts ON subscription_events(created_at);
