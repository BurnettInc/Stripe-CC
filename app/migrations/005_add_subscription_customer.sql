-- Store the Stripe customer ID on subscriptions so the Customer Portal
-- (POST /billing/portal) can create billing portal sessions without an extra
-- Stripe round-trip. Captured from checkout.session.completed webhooks.
ALTER TABLE subscriptions ADD COLUMN stripe_customer_id TEXT;
