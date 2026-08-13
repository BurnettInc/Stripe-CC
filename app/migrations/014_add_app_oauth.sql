-- Stripe Apps OAuth v2 install flow (marketplace install): state + token store.
-- oauth_install_states: CSRF-safe state rows for the marketplace authorize hop.
--   One row per GET /oauth/install/start; consumed (deleted) on callback so a
--   state can never be replayed. TTL enforced at read (expired rows treated as
--   missing and purged opportunistically).
-- oauth_tokens: the token pair Stripe returns for a marketplace install
--   (scope stripe_apps). access_token expires ~1h; refresh_token expires ~1yr
--   and ROLLS on every refresh — the latest pair lives here. Tokens are
--   encrypted at rest with the same TOKEN_ENCRYPTION_KEY as stripe_connections
--   (see middleware/auth.ts). link_type (test|live) records which app
--   developer key minted the pair — the refresh call must use the same key.
CREATE TABLE IF NOT EXISTS oauth_install_states (
  state TEXT PRIMARY KEY,
  link_type TEXT NOT NULL CHECK(link_type IN ('test', 'live')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  stripe_user_id TEXT PRIMARY KEY,              -- Stripe account id (acct_xxx)
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  access_token TEXT NOT NULL,                   -- scope stripe_apps access token
  refresh_token TEXT,                           -- rolling refresh token (may be null)
  stripe_publishable_key TEXT NOT NULL DEFAULT '',
  livemode INTEGER NOT NULL DEFAULT 0,
  link_type TEXT NOT NULL DEFAULT 'test' CHECK(link_type IN ('test', 'live')),
  expires_at TEXT NOT NULL,                     -- SQLite datetime, ~1h after mint
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_merchant ON oauth_tokens(merchant_id);
