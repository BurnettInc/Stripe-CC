-- Phase B (2026-08-18): subscriptions now record their billing interval so the
-- dashboard can show an honest plan card ("Pro plan — $250/yr" for a yearly
-- subscriber instead of the misleading monthly "$29/mo"). The checkout session
-- carries metadata[interval] and the customer.subscription.updated webhook
-- derives it from the price id. Applied once by the schema_migrations tracker;
-- every pre-Phase-B subscription was monthly, so the default is 'month'.
ALTER TABLE subscriptions ADD COLUMN interval TEXT NOT NULL DEFAULT 'month';
