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

  // Run SQL migration files from the migrations/ directory
  const migrationsDir = join(import.meta.dirname, "..", "migrations");
  if (existsSync(migrationsDir)) {
    const files = readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      db.exec(sql);
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

// ── Subscription helpers ──

export function createSubscription(
  db: Database,
  params: { merchant_id: number; stripe_subscription_id: string; tier: string }
) {
  const result = db.run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, ?, ?, 'active')",
    [params.merchant_id, params.stripe_subscription_id, params.tier]
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

export function getSubscriptionByStripeId(db: Database, stripeSubscriptionId: string) {
  return db
    .query("SELECT * FROM subscriptions WHERE stripe_subscription_id=?")
    .get(stripeSubscriptionId) as Subscription | null;
}

// ── Query helpers ──

export function getMerchantById(db: Database, id: number) {
  return db.query("SELECT * FROM merchants WHERE id = ?").get(id) as Merchant | null;
}

export function getInvoiceById(db: Database, id: number) {
  return db.query("SELECT * FROM invoices WHERE id = ?").get(id) as Invoice | null;
}

export function getTaskById(db: Database, id: number) {
  return db.query("SELECT * FROM reminder_tasks WHERE id = ?").get(id) as ReminderTask | null;
}

export function getAllTasks(db: Database) {
  return db.query(`
    SELECT rt.*, i.stripe_invoice_id, i.customer_name, i.customer_email, i.amount_cents, i.currency, i.due_date, i.status as invoice_status
    FROM reminder_tasks rt
    JOIN invoices i ON rt.invoice_id = i.id
    ORDER BY rt.created_at DESC
  `).all();
}

// ── Types ──

export interface Merchant {
  id: number;
  stripe_account_id: string;
  email: string;
  trust_mode: string;
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
  tier: string;
  status: string;
  created_at: string;
}
