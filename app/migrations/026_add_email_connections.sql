-- Per-merchant email OAuth connections (sender-identity project, Phase 1, 8/18).
-- A SECOND per-merchant OAuth connection — same architectural pattern as the
-- Stripe marketplace install (oauth_tokens, migration 014) — so reminders can
-- eventually send from the merchant's OWN Gmail/Outlook mailbox instead of our
-- shared Resend domain. Phase 1 = plumbing only (connect/callback/disconnect +
-- encrypted storage + provider seam). Sender routing + drawer/settings UI +
-- the actual gmail.send call are Phase 2 (a later delegation).
--
-- email_connections:
--   One row per merchant per provider. Tokens encrypted at rest with the SAME
--   AES-256-GCM scheme as Stripe OAuth tokens (middleware/auth.ts
--   encryptValue/decryptValue under TOKEN_ENCRYPTION_KEY) — reuse, don't
--   reinvent. Gmail access_token ~1h; refresh_token long-lived + non-rotating
--   (feasibility memo §2, same storage model as Stripe). account_email is the
--   connected mailbox address (best-effort from the token exchange in Phase 1;
--   the send path can resolve it precisely in Phase 2). scopes stores the OAuth
--   scope string granted (gmail.send). UNIQUE(merchant_id, provider) so a
--   merchant holds at most one connection per provider — reconnect = upsert.
--   provider is 'gmail' | 'microsoft' (Microsoft is a Phase-2 stub, schema
--   already future-proofed for it).
--
-- email_oauth_states:
--   CSRF-safe one-time state rows for the /email/oauth/start authorize hop —
--   mirrors oauth_install_states (migration 014). One row per start; consumed
--   (deleted) on callback so a state can never be replayed. TTL enforced at
--   read (expired rows treated as missing and purged opportunistically). Tied
--   to the merchant_id that started the flow so the callback stores the
--   connection against the right merchant.
CREATE TABLE IF NOT EXISTS email_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  provider TEXT NOT NULL CHECK(provider IN ('gmail', 'microsoft')),
  account_email TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(merchant_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_email_connections_merchant ON email_connections(merchant_id);

CREATE TABLE IF NOT EXISTS email_oauth_states (
  state TEXT PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  provider TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/dashboard',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_oauth_states_merchant ON email_oauth_states(merchant_id);
