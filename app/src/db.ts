import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    db = new Database(join(import.meta.dirname, "..", "app.db"), { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    const schemaFile = join(import.meta.dirname, "..", "schema.sql");
    const schema = readFileSync(schemaFile, "utf-8");
    db.exec(schema);
    runMigrations(db);
  }
  return db;
}

// ── Migrations ──

function runMigrations(db: Database) {
  // Check if send_logs has the 'type' column
  const cols = db.query("PRAGMA table_info(send_logs)").all() as { name: string; notnull: number }[];
  const hasType = cols.some(c => c.name === "type");
  const reminderCol = cols.find(c => c.name === "reminder_task_id");

  // Per-invoice Trust Mode overrides are nullable: null means use merchant default.
  const invoiceCols = db.query("PRAGMA table_info(invoices)").all() as { name: string }[];
  if (!invoiceCols.some(c => c.name === "trust_mode_override")) {
    db.exec("ALTER TABLE invoices ADD COLUMN trust_mode_override TEXT DEFAULT NULL CHECK(trust_mode_override IN ('draft', 'semi', 'full'))");
  }

  if (!hasType || (reminderCol && reminderCol.notnull === 1)) {
    // Need to migrate: recreate send_logs with type column + nullable reminder_task_id
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN TRANSACTION");
    db.exec(`
      CREATE TABLE IF NOT EXISTS send_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_task_id INTEGER REFERENCES reminder_tasks(id),
        type TEXT NOT NULL DEFAULT 'reminder' CHECK(type IN ('reminder', 'weekly_summary')),
        status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'skipped')),
        provider_message TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    if (hasType) {
      db.exec(`INSERT INTO send_logs_new (id, reminder_task_id, type, status, provider_message, created_at) SELECT id, reminder_task_id, type, status, provider_message, created_at FROM send_logs`);
    } else {
      db.exec(`INSERT INTO send_logs_new (id, reminder_task_id, status, provider_message, created_at) SELECT id, reminder_task_id, status, provider_message, created_at FROM send_logs`);
    }
    db.exec("DROP TABLE send_logs");
    db.exec("ALTER TABLE send_logs_new RENAME TO send_logs");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys=ON");
  }

  // Run SQL migration files from the migrations/ directory, each at most once.
  // (Files contain non-idempotent DDL like ALTER TABLE, so track what ran.)
  const migrationsDir = join(import.meta.dirname, "..", "migrations");
  if (existsSync(migrationsDir)) {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (file TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    const applied = new Set(
      (db.query("SELECT file FROM schema_migrations").all() as { file: string }[]).map(r => r.file)
    );
    const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      db.exec(sql);
      db.run("INSERT INTO schema_migrations (file) VALUES (?)", [file]);
    }
  }
}

// ── Merchant helpers ──

export function ensureDefaultMerchant(db: Database) {
  const existing = db.query("SELECT id FROM merchants WHERE stripe_account_id = ?").get("acct_default");
  if (!existing) {
    db.run(
      "INSERT INTO merchants (stripe_account_id, email, trust_mode) VALUES (?, ?, ?)",
      ["acct_default", "default@collections-copilot.local", "draft"]
    );
  }
}

// ── Invoice helpers ──

export function upsertInvoice(
  db: Database,
  params: {
    stripe_invoice_id: string;
    merchant_id: number;
    customer_name: string;
    customer_email: string;
    amount_cents: number;
    currency: string;
    due_date: string;
    status: string;
  }
) {
  const existing = db
    .query("SELECT id FROM invoices WHERE stripe_invoice_id = ?")
    .get(params.stripe_invoice_id) as { id: number } | null;

  if (existing) {
    db.run(
      `UPDATE invoices SET customer_name=?, customer_email=?, amount_cents=?, currency=?, due_date=?, status=? WHERE id=?`,
      [params.customer_name, params.customer_email, params.amount_cents, params.currency, params.due_date, params.status, existing.id]
    );
    return existing.id;
  }

  const result = db.run(
    `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [params.stripe_invoice_id, params.merchant_id, params.customer_name, params.customer_email, params.amount_cents, params.currency, params.due_date, params.status]
  );
  return Number(result.lastInsertRowid);
}

// ── Task helpers ──

export function createReminderTask(db: Database, invoiceId: number, stage: number) {
  // Cancel any existing active tasks for this invoice first (including sent tasks to prevent duplicate sends)
  db.run("UPDATE reminder_tasks SET status='cancelled' WHERE invoice_id=? AND status IN ('pending','drafted','reviewed','sent')", [invoiceId]);

  const result = db.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status) VALUES (?, ?, 'pending')",
    [invoiceId, stage]
  );
  return Number(result.lastInsertRowid);
}

export function cancelTasksForInvoice(db: Database, invoiceId: number) {
  db.run("UPDATE reminder_tasks SET status='cancelled' WHERE invoice_id=? AND status IN ('pending','drafted','reviewed','sent')", [invoiceId]);
}

// ── Logging helpers ──

export function logSend(db: Database, taskId: number, status: string, message: string, type: string = "reminder") {
  db.run(
    "INSERT INTO send_logs (reminder_task_id, type, status, provider_message) VALUES (?, ?, ?, ?)",
    [taskId === 0 ? null : taskId, type, status, message]
  );
}

// ── CAN-SPAM unsubscribe helpers ──

/**
 * Record a customer opt-out for a merchant. Idempotent — repeated clicks on
 * the unsubscribe link are no-ops. Customer emails are stored lowercased so
 * the sender-side skip check is case-insensitive.
 */
export function recordUnsubscribe(db: Database, merchantId: number, customerEmail: string): boolean {
  const email = customerEmail.trim().toLowerCase();
  if (!email) return false;
  db.run(
    `INSERT INTO unsubscribes (merchant_id, customer_email) VALUES (?, ?)
     ON CONFLICT(merchant_id, customer_email) DO NOTHING`,
    [merchantId, email]
  );
  return true;
}

/** Whether a customer has opted out of reminders for the given merchant. */
export function isUnsubscribed(db: Database, merchantId: number, customerEmail: string): boolean {
  const email = customerEmail.trim().toLowerCase();
  if (!email) return false;
  return !!db
    .query("SELECT 1 FROM unsubscribes WHERE merchant_id = ? AND customer_email = ?")
    .get(merchantId, email);
}

// ── Subscription helpers ──

export function createSubscription(
  db: Database,
  params: { merchant_id: number; stripe_subscription_id: string; tier: string; stripe_customer_id?: string | null }
) {
  const result = db.run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, stripe_customer_id, tier, status) VALUES (?, ?, ?, ?, 'active')",
    [params.merchant_id, params.stripe_subscription_id, params.stripe_customer_id ?? null, params.tier]
  );
  return Number(result.lastInsertRowid);
}

export function updateSubscriptionStatus(
  db: Database,
  stripe_subscription_id: string,
  status: string,
  tier?: string
) {
  if (tier) {
    db.run(
      "UPDATE subscriptions SET status=?, tier=? WHERE stripe_subscription_id=?",
      [status, tier, stripe_subscription_id]
    );
  } else {
    db.run(
      "UPDATE subscriptions SET status=? WHERE stripe_subscription_id=?",
      [status, stripe_subscription_id]
    );
  }
}

export function getSubscriptionByMerchantId(db: Database, merchantId: number) {
  return db
    .query("SELECT * FROM subscriptions WHERE merchant_id=? ORDER BY created_at DESC LIMIT 1")
    .get(merchantId) as Subscription | null;
}

/** Whether the merchant's most recent subscription is currently active. */
export function hasActiveSubscription(db: Database, merchantId: number): boolean {
  const sub = getSubscriptionByMerchantId(db, merchantId);
  return sub?.status === "active";
}

/**
 * Tier enforcement: Full Auto (trust_mode "full") is Pro-only. If the
 * merchant's now-effective subscription is NOT an active Pro one (no sub,
 * cancelled, past_due, or tier != "pro"), demote trust_mode "full" → "semi"
 * so the merchant stays operational (Semi-Auto still auto-sends stage 1)
 * without the unsafe hands-off behavior. No-op when the merchant is active
 * Pro or when trust_mode isn't "full" — only writes on an actual change.
 */
export function enforceTierTrustMode(db: Database, merchantId: number): void {
  const sub = getSubscriptionByMerchantId(db, merchantId);
  const isActivePro = !!sub && sub.status === "active" && sub.tier === "pro";
  if (isActivePro) return;

  const merchant = db.query("SELECT trust_mode FROM merchants WHERE id=?").get(merchantId) as { trust_mode: string } | null;
  if (merchant && merchant.trust_mode === "full") {
    db.run("UPDATE merchants SET trust_mode='semi' WHERE id=?", [merchantId]);
    console.log(
      `[billing] Tier enforcement: merchant ${merchantId} no longer has an active Pro subscription — trust_mode reset 'full' → 'semi'`
    );
  }
}

const FREE_DRAFT_LIMIT = 5;

/** Number of free drafts still available (an all-time, merchant-scoped cap). */
export function freeDraftsRemaining(db: Database, merchantId: number): number {
  const merchant = db.query("SELECT drafts_used FROM merchants WHERE id = ?").get(merchantId) as { drafts_used: number } | null;
  const used = merchant?.drafts_used ?? 0;
  return Math.max(0, FREE_DRAFT_LIMIT - used);
}

export function getSubscriptionByStripeId(db: Database, stripeSubscriptionId: string) {
  return db
    .query("SELECT * FROM subscriptions WHERE stripe_subscription_id=?")
    .get(stripeSubscriptionId) as Subscription | null;
}

// ── Query helpers ──

export function getMerchantById(db: Database, id: number) {
  return db.query("SELECT * FROM merchants WHERE id = ?").get(id) as Merchant | null;
}

/**
 * Resolve the merchant for a request.
 *
 * Priority:
 * 1. A Stripe account ID (from a webhook event, OAuth callback, etc.) —
 *    joined through stripe_connections to the owning merchant.
 * 2. The merchant owning the most recently updated stripe_connections row
 *    (covers requests with no account context, e.g. /settings).
 * 3. The default merchant (lowest id) — legacy single-merchant fallback.
 *
 * Never assumes "row 1" when a Stripe account ID is available.
 */
export function resolveMerchant(db: Database, accountId?: string | null): Merchant | null {
  if (accountId) {
    const conn = db
      .query("SELECT merchant_id FROM stripe_connections WHERE id = ?")
      .get(accountId) as { merchant_id: number } | null;
    if (conn) {
      const merchant = getMerchantById(db, conn.merchant_id);
      if (merchant) return merchant;
    }
  }

  const conn = db
    .query("SELECT merchant_id FROM stripe_connections ORDER BY updated_at DESC LIMIT 1")
    .get() as { merchant_id: number } | null;
  if (conn) {
    const merchant = getMerchantById(db, conn.merchant_id);
    if (merchant) return merchant;
  }

  return db.query("SELECT * FROM merchants ORDER BY id ASC LIMIT 1").get() as Merchant | null;
}

export function getInvoiceById(db: Database, id: number) {
  return db.query("SELECT * FROM invoices WHERE id = ?").get(id) as Invoice | null;
}

export function getTaskById(db: Database, id: number) {
  return db.query("SELECT * FROM reminder_tasks WHERE id = ?").get(id) as ReminderTask | null;
}

export function getAllTasks(db: Database, merchantId: number) {
  return db.query(`
    SELECT rt.*, i.stripe_invoice_id, i.customer_name, i.customer_email, i.amount_cents, i.currency, i.due_date, i.status as invoice_status
    FROM reminder_tasks rt
    JOIN invoices i ON rt.invoice_id = i.id
    WHERE i.merchant_id = ?
    ORDER BY rt.created_at DESC
  `).all(merchantId);
}

export interface CustomerHistory {
  relationship_length: string;
  payment_history_summary: string;
  typical_amount: string;
  amount_delta: string;
}

/** Compute compact, server-side customer context for the drafter. */
export function getCustomerHistory(
  db: Database,
  merchantId: number,
  customerName: string,
  customerEmail: string,
  currentInvoiceId?: number,
  currentAmountCents?: number,
): CustomerHistory {
  const invoices = db.query(`SELECT id, amount_cents, status, due_date, created_at
    FROM invoices WHERE merchant_id=? AND (customer_email=? OR (?='' AND customer_name=?))
    ORDER BY created_at ASC`).all(merchantId, customerEmail, customerEmail, customerName) as Array<{
      id: number; amount_cents: number; status: string; due_date: string; created_at: string;
    }>;
  const prior = invoices.filter(i => i.id !== currentInvoiceId);
  if (invoices.length === 0) {
    return { relationship_length: "new customer — insufficient history", payment_history_summary: "new customer — insufficient history", typical_amount: "no baseline", amount_delta: "first invoice — no baseline" };
  }
  const first = new Date(invoices[0].created_at).getTime();
  const months = Math.max(0, Math.floor((Date.now() - first) / (30.44 * 86400000)));
  const relationship = `${months} month${months === 1 ? "" : "s"}, ${prior.length} prior invoice${prior.length === 1 ? "" : "s"}`;
  if (prior.length === 0) return { relationship_length: relationship, payment_history_summary: "first late payment on record", typical_amount: "no baseline", amount_delta: "first invoice — no baseline" };
  const recent = prior.slice(-10);
  const amounts = recent.map(i => i.amount_cents);
  const average = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const typical = `$${(average / 100).toFixed(2)}`;
  const current = currentAmountCents ?? 0;
  const difference = average ? ((current - average) / average) * 100 : 0;
  const delta = Math.abs(difference) < 10 ? "in line with typical invoices" : `${Math.abs(Math.round(difference))}% ${difference > 0 ? "larger" : "smaller"} than usual`;
  const sentCounts = recent.map(i => Number((db.query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=? AND status='sent'").get(i.id) as { n: number }).n));
  const chronic = sentCounts.filter(n => n >= 2).length;
  let summary: string;
  if (chronic > 0) summary = `chronically late — ${chronic} of last ${recent.length} invoices needed 2+ reminders`;
  else if (recent.every(i => i.status === "paid")) summary = "always pays promptly";
  else if (recent.some(i => i.status === "paid")) summary = "typically pays within a few days of reminder";
  else summary = "first late payment on record";
  return { relationship_length: relationship, payment_history_summary: summary, typical_amount: typical, amount_delta: delta };
}

// ── Types ──

export interface Merchant {
  id: number;
  stripe_account_id: string;
  email: string;
  trust_mode: string;
  drafts_used: number;
  created_at: string;
}

export interface Invoice {
  id: number;
  stripe_invoice_id: string;
  merchant_id: number;
  customer_name: string;
  customer_email: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  status: string;
  trust_mode_override: string | null;
  created_at: string;
}

export interface ReminderTask {
  id: number;
  invoice_id: number;
  stage: number;
  status: string;
  draft_subject: string;
  draft_body: string;
  reviewer_notes: string;
  sent_at: string | null;
  created_at: string;
}

export interface SendLog {
  id: number;
  reminder_task_id: number;
  status: string;
  provider_message: string;
  created_at: string;
}

export interface Subscription {
  id: number;
  merchant_id: number;
  stripe_subscription_id: string;
  stripe_customer_id?: string | null;
  tier: string;
  status: string;
  created_at: string;
}
