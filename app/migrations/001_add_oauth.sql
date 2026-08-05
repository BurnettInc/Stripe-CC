-- Stripe OAuth Connect: stripe_connections table
-- Stores OAuth tokens for merchants who connect via Stripe Connect.

CREATE TABLE IF NOT EXISTS stripe_connections (
  id TEXT PRIMARY KEY,                          -- Stripe account ID (acct_xxx)
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  access_token TEXT NOT NULL,                   -- OAuth access token (for Stripe API calls)
  refresh_token TEXT,                           -- OAuth refresh token (may be null)
  stripe_publishable_key TEXT NOT NULL,         -- Publishable key for the connected account
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_connections_merchant ON stripe_connections(merchant_id);
