-- Platform accounts for the Stripe marketplace install flow (owner decision
-- 2026-08-13, responding to the Stripe reviewer's round-2 CHANGES REQUESTED:
-- the reviewer's expected flow is marketplace → listing → Install → user logs
-- in or signs up on our platform → connect Stripe → install → sync → subscribe).
--
-- accounts: one row per sign-in email. NO passwords — sign-in is a one-time
-- magic link emailed to the address (see routes/accounts.ts). created_at is
-- the signup time; last_login_at is updated on every successful verify.
--
-- account_magic_links: one-time, 15-minute sign-in tokens. used_at marks
-- consumption (atomic single-statement UPDATE in the verify handler), so a
-- token can never be replayed; expired rows are treated as missing.
--
-- account_sessions: 30-day session tokens backing the HttpOnly `cc_account`
-- cookie (distinct from the merchant `session` cookie — an account signs in
-- once and can connect/own multiple Stripe merchants).
--
-- Linkage chain (billing unchanged): account → merchant (merchants.account_id
-- below) → subscription (existing getSubscriptionByMerchantId). The OAuth
-- install state row records which account started the install
-- (oauth_install_states.account_id), and the callback stamps the created/
-- found merchant with it — so the purchased subscription is reachable from
-- the account through the merchant.
--
-- Applied at most once via the schema_migrations tracker (the pattern of
-- 008–016). The CREATE TABLEs are IF NOT EXISTS so the file is also safe to
-- re-execute by hand; the two ALTERs are NOT (SQLite has no ADD COLUMN IF NOT
-- EXISTS — 016's column adds rely on the tracker the same way, and a re-run
-- fails loudly with "duplicate column name" rather than corrupting anything).
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS account_magic_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS account_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The account that owns a merchant (nullable: existing/legacy rows keep NULL,
-- and web-connect merchants stay NULL until a marketplace install links them).
ALTER TABLE merchants ADD COLUMN account_id INTEGER;
-- The account that started a marketplace install: stamped by the logged-in
-- /oauth/install/start, read back in the callback so the created merchant
-- links to the account. Nullable — legacy state rows keep NULL (callback is
-- null-safe for them).
ALTER TABLE oauth_install_states ADD COLUMN account_id INTEGER;
