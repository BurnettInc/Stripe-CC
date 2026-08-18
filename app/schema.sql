-- Stripe Collections Copilot database schema

CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_account_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  trust_mode TEXT NOT NULL DEFAULT 'draft' CHECK(trust_mode IN ('draft', 'semi', 'full')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  customer_name TEXT NOT NULL DEFAULT 'Unknown',
  customer_email TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  due_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'paid', 'void', 'overdue', 'uncollectible')),
  trust_mode_override TEXT DEFAULT NULL CHECK(trust_mode_override IN ('draft', 'semi', 'full')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminder_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  stage INTEGER NOT NULL DEFAULT 1 CHECK(stage IN (1, 2, 3)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'drafted', 'reviewed', 'sent', 'paused', 'cancelled')),
  draft_subject TEXT DEFAULT '',
  draft_body TEXT DEFAULT '',
  reviewer_notes TEXT DEFAULT '',
  sent_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS send_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_task_id INTEGER REFERENCES reminder_tasks(id),
  type TEXT NOT NULL DEFAULT 'reminder',
  status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'skipped')),
  provider_message TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL CHECK(tier IN ('standard', 'pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'cancelled', 'past_due')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
CREATE TABLE IF NOT EXISTS unsubscribes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  customer_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(merchant_id, customer_email)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_invoices_merchant ON invoices(merchant_id);
CREATE INDEX IF NOT EXISTS idx_reminder_tasks_invoice ON reminder_tasks(invoice_id);
CREATE INDEX IF NOT EXISTS idx_reminder_tasks_status ON reminder_tasks(status);
CREATE INDEX IF NOT EXISTS idx_send_logs_task ON send_logs(reminder_task_id);
