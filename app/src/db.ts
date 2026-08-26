import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    // DB_PATH lets the deployment point SQLite at a persistent volume
    // (e.g. DB_PATH=/data/app.db with a Railway volume mounted at /data).
    // Default stays the app directory so local dev is unchanged.
    const dbPath = process.env.DB_PATH || join(import.meta.dirname, "..", "app.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath, { create: true });
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
  // Idempotency guard for the charge.refunded handler: which refund stopped
  // this invoice's sequence, so a replayed refund event can't double-log.
  if (!invoiceCols.some(c => c.name === "refund_id")) {
    db.exec("ALTER TABLE invoices ADD COLUMN refund_id TEXT DEFAULT NULL");
  }
  // Manual pause flag (drawer Pause button): ISO timestamp set by the merchant
  // via POST /tasks/pause. The watcher's stale guard skips manually-paused
  // invoices exactly like reply-paused ones, so no new tasks are created and
  // the pause is durable until POST /tasks/resume clears it.
  if (!invoiceCols.some(c => c.name === "manually_paused_at")) {
    db.exec("ALTER TABLE invoices ADD COLUMN manually_paused_at TEXT DEFAULT NULL");
  }

  // Dev-only Pro flag (merchants.dev_pro): when 1, the backend treats this
  // merchant as an ACTIVE PRO subscriber with NO real Stripe subscription —
  // no row in the subscriptions table. Used to preview paid behavior (the
  // Stripe App drawer's paid OverviewView, paid dashboard state, Pro-only
  // gates) before the merchant has a live subscription. Deliberately NOT a
  // fake subscriptions row (that caused the owner's portal 502: the portal
  // looked up a non-existent Stripe customer), so /billing/portal and other
  // Stripe-backed paths still see "no subscription". Flip is an ops action on
  // the merchants table — no env var, no hardcoded merchant id in code.
  const merchantCols = db.query("PRAGMA table_info(merchants)").all() as { name: string }[];
  if (!merchantCols.some(c => c.name === "dev_pro")) {
    db.exec("ALTER TABLE merchants ADD COLUMN dev_pro INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasType || (reminderCol && reminderCol.notnull === 1)) {
    // Need to migrate: recreate send_logs with type column + nullable reminder_task_id
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN TRANSACTION");
    db.exec(`
      CREATE TABLE IF NOT EXISTS send_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_task_id INTEGER REFERENCES reminder_tasks(id),
        type TEXT NOT NULL DEFAULT 'reminder',
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
    /** 1 = live, 0 = test (reviewer fix #5). Defaults to LIVE — the
     * pre-mode behavior; every pre-migration row is live. */
    livemode?: number;
  }
) {
  const livemode = params.livemode === 0 ? 0 : 1;
  const existing = db
    .query("SELECT id FROM invoices WHERE stripe_invoice_id = ? AND livemode = ?")
    .get(params.stripe_invoice_id, livemode) as { id: number } | null;

  if (existing) {
    // ever_overdue is the sticky "was ever in the overdue pipeline" flag
    // (migration 020): set to 1 when the incoming status is 'overdue', and
    // NEVER cleared — an invoice that was once overdue stays flagged for
    // life, so its later payment records a recovery event even after the
    // status column has moved on to 'paid'/'void'.
    db.run(
      `UPDATE invoices SET customer_name=?, customer_email=?, amount_cents=?, currency=?, due_date=?, status=?,
       ever_overdue = CASE WHEN ? = 'overdue' THEN 1 ELSE ever_overdue END
       WHERE id=?`,
      [params.customer_name, params.customer_email, params.amount_cents, params.currency, params.due_date, params.status, params.status, existing.id]
    );
    return existing.id;
  }

  const result = db.run(
    `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, ever_overdue, livemode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [params.stripe_invoice_id, params.merchant_id, params.customer_name, params.customer_email, params.amount_cents, params.currency, params.due_date, params.status, params.status === "overdue" ? 1 : 0, livemode]
  );
  return Number(result.lastInsertRowid);
}

// ── Recovery-outcome helpers (admin telemetry, migration 020) ──
const DAY_MS = 24 * 60 * 60 * 1000;

/** The invoice facts recordRecoveryEvent needs — a subset of the full Invoice
 * row so both call sites (watcher webhook handler, scheduler sync
 * reconciliation) can pass what they already have without a full read-back. */
export interface RecoveryInvoiceFacts {
  id: number;
  stripe_invoice_id: string;
  merchant_id: number;
  amount_cents: number;
  currency: string;
  due_date: string;
  ever_overdue: number;
}

/**
 * Record one recovery event: an invoice that was EVER overdue (ever_overdue
 * flag, set by upsertInvoice whenever the invoice entered the overdue
 * pipeline) just became PAID. Pure admin telemetry — never read by any
 * merchant-facing flow and never modifies reminder/send behavior.
 *
 * Idempotent per invoice_id: the UNIQUE(invoice_id) constraint + INSERT OR
 * IGNORE make webhook replays, double observation (webhook AND the sync pass
 * both noticing the same payment), and scheduler re-runs all no-ops — the
 * first writer wins, so the frozen outcome facts are never mutated.
 *
 * @param paidAt  ISO timestamp of when the payment was observed (webhook:
 *                Stripe's status_transitions.paid_at when present, else
 *                event-received time; sync: the sync run time).
 */
export function recordRecoveryEvent(
  db: Database,
  invoice: RecoveryInvoiceFacts,
  opts: { source: "webhook" | "sync"; paidAt?: string }
): { recorded: boolean; reason: string } {
  if (!invoice || invoice.ever_overdue !== 1) {
    return { recorded: false, reason: "invoice was never overdue locally" };
  }
  const paidAt = opts.paidAt ?? new Date().toISOString();
  const reminderSent = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM send_logs sl
         JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
         WHERE rt.invoice_id = ? AND sl.type = 'reminder' AND sl.status = 'success'`
      )
      .get(invoice.id) as { n: number }
  ).n > 0
    ? 1
    : 0;
  const stageRow = db
    .query("SELECT MAX(stage) AS s FROM reminder_tasks WHERE invoice_id = ?")
    .get(invoice.id) as { s: number | null } | null;
  const stageReached = stageRow?.s ?? 0;
  // days-to-payment = paid date − due date, in whole days (negative = paid
  // before the due date — a same-window payment). NULL when the due date is
  // missing/unparseable.
  let daysToPayment: number | null = null;
  if (invoice.due_date && /^\d{4}-\d{2}-\d{2}/.test(invoice.due_date)) {
    const dueMs = Date.parse(invoice.due_date + (invoice.due_date.length === 10 ? "T00:00:00Z" : ""));
    const paidMs = Date.parse(paidAt);
    if (!Number.isNaN(dueMs) && !Number.isNaN(paidMs)) {
      daysToPayment = Math.floor((paidMs - dueMs) / DAY_MS);
    }
  }
  const result = db.run(
    `INSERT OR IGNORE INTO recovery_events
       (merchant_id, invoice_id, stripe_invoice_id, amount_cents, currency, due_date, paid_at, days_to_payment, reminder_sent, stage_reached, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invoice.merchant_id,
      invoice.id,
      invoice.stripe_invoice_id,
      invoice.amount_cents,
      invoice.currency,
      invoice.due_date,
      paidAt,
      daysToPayment,
      reminderSent,
      stageReached,
      opts.source,
    ]
  );
  if (result.changes === 0) {
    return { recorded: false, reason: "recovery event already recorded for this invoice" };
  }
  return { recorded: true, reason: `recorded (source ${opts.source})` };
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

/**
 * Whether the merchant is flagged as a dev-only Pro account
 * (merchants.dev_pro = 1). Such accounts are treated as active Pro
 * subscribers EVERYWHERE tier/paid state is derived, WITHOUT any real Stripe
 * subscription — used to preview paid behavior (Stripe App drawer, paid
 * dashboard, Pro-only gates) before the merchant has a live plan. This is a
 * merchants-table flag only: /billing/portal and other Stripe-backed paths
 * still see "no subscription" (the flag never fabricates a subscriptions row
 * or a Stripe customer).
 */
export function isDevPro(db: Database, merchantId: number): boolean {
  const merchant = db.query("SELECT dev_pro FROM merchants WHERE id=?").get(merchantId) as { dev_pro: number } | null;
  return merchant?.dev_pro === 1;
}

export function createSubscription(
  db: Database,
  params: { merchant_id: number; stripe_subscription_id: string; tier: string; stripe_customer_id?: string | null; interval?: string }
) {
  // Billing interval (Phase B): 'month' (default, unchanged) or 'year'. Stored
  // so the dashboard can show an honest plan card for yearly subscribers
  // ("Pro plan — $100/yr") instead of the misleading monthly price.
  const interval = params.interval === "year" ? "year" : "month";
  const result = db.run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, stripe_customer_id, tier, status, interval) VALUES (?, ?, ?, ?, 'active', ?)",
    [params.merchant_id, params.stripe_subscription_id, params.stripe_customer_id ?? null, params.tier, interval]
  );
  return Number(result.lastInsertRowid);
}

export function updateSubscriptionStatus(
  db: Database,
  stripe_subscription_id: string,
  status: string,
  tier?: string,
  interval?: string
) {
  if (tier && interval) {
    db.run(
      "UPDATE subscriptions SET status=?, tier=?, interval=? WHERE stripe_subscription_id=?",
      [status, tier, interval, stripe_subscription_id]
    );
  } else if (tier) {
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

/**
 * Length of the automatic full-access free trial, anchored to the OAuth
 * connect/install time (merchants.created_at, a SQLite datetime('now') set at
 * connect). Purely time-based: no manual per-merchant flag and no manual
 * expiry step — the same merchant drops back to the normal 5-draft free tier
 * automatically once this window elapses.
 */
export const FREE_TRIAL_DAYS = 30;
/**
 * Whether the merchant is inside its automatic full-access free trial (owner
 * directive: give newly installed merchants FULL access for 30 days from
 * install, then lock them to the normal 5-draft free tier).
 *
 * Time-based and self-expiring: returns true only while "now" is strictly
 * before created_at + FREE_TRIAL_DAYS, computed in SQLite against
 * merchants.created_at (so the comparison is timezone-consistent with the
 * datetime('now') value stored at connect).
 *
 * A merchant with an ACTIVE paid subscription is NEVER "in free trial" (the
 * trial only ever ADDS full access to a non-subscriber; it can never downgrade
 * an active subscriber — see the entitlement helpers below, all of which route
 * through this and then fall back to the real subscription). dev_pro merchants
 * are always full-access via the dev flag and are likewise not "in trial".
 *
 * Exact-boundary semantics: at exactly FREE_TRIAL_DAYS after created_at the
 * window has elapsed (strict `<`), so `datetime('now','-30 days')` is already
 * out of trial and `datetime('now','-29 days')` is still in trial. A merchant
 * whose created_at predates this feature by more than 30 days is immediately
 * on the normal free tier (no retroactive trial).
 */
export function isWithinFreeTrial(db: Database, merchantId: number): boolean {
  if (isDevPro(db, merchantId)) return false;
  const sub = getSubscriptionByMerchantId(db, merchantId);
  if (sub && sub.status === "active") return false; // active subscriber always wins
  const row = db
    .query("SELECT (datetime('now') < datetime(created_at, ?)) AS within FROM merchants WHERE id=?")
    .get(`+${FREE_TRIAL_DAYS} days`, merchantId) as { within: number } | null;
  return row?.within === 1;
}
/** Whether the merchant's most recent subscription is currently active. */
export function hasActiveSubscription(db: Database, merchantId: number): boolean {
  if (isDevPro(db, merchantId)) return true;
  // A merchant inside its 30-day full-access free trial is treated as paid for
  // entitlement purposes: the free-draft send gates (which key off
  // `!hasActiveSubscription(...) && freeDraftsRemaining(...) <= 0`) must be
  // bypassed during the trial, exactly as for an active subscriber.
  if (isWithinFreeTrial(db, merchantId)) return true;
  const sub = getSubscriptionByMerchantId(db, merchantId);
  return sub?.status === "active";
}

/**
 * Whether the merchant's most recent subscription is an ACTIVE Pro one —
 * or the merchant is dev-flagged Pro (isDevPro). Full Auto (trust_mode
 * "full") is Pro-only — the settings PUT gates switching to it,
 * enforceTierTrustMode demotes on downgrade, and the watcher's auto-send
 * branch re-checks this before trusting a stored "full".
 */
export function isActiveProSubscriber(db: Database, merchantId: number): boolean {
  if (isDevPro(db, merchantId)) return true;
  // The 30-day free trial grants Pro-equivalent FULL access to a
  // non-subscriber: Pro-only gates (Full Auto trust mode, Pro settings)
  // pass, and enforceTierTrustMode keeps a trial merchant's "full" intact.
  // Once the trial lapses (with no active paid sub) this returns false and
  // the same gates re-lock, demoting "full" back to "semi".
  if (isWithinFreeTrial(db, merchantId)) return true;
  const sub = getSubscriptionByMerchantId(db, merchantId);
  return !!sub && sub.status === "active" && sub.tier === "pro";
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
  const isActivePro = isActiveProSubscriber(db, merchantId);
  if (isActivePro) return;

  const merchant = db.query("SELECT trust_mode FROM merchants WHERE id=?").get(merchantId) as { trust_mode: string } | null;
  if (merchant && merchant.trust_mode === "full") {
    db.run("UPDATE merchants SET trust_mode='semi' WHERE id=?", [merchantId]);
    console.log(
      `[billing] Tier enforcement: merchant ${merchantId} no longer has an active Pro subscription — trust_mode reset 'full' → 'semi'`
    );
  }
}

// ── Founding Member Offer (Phase A, 2026-08-18) ──
// Owner rule (8/13+8/14+8/17): the FIRST 50 subscriptions EVER (across both
// plans) get lifetime 50% off both plans ($7.50/$14.50 forever) + 90 days of
// priority support. Eligibility is by subscription creation order — no claim
// race. See migrations/023_add_founding_members.sql for the table.
//
// NOTE 2026-08-26 (reprice): the offer is CLOSED — no new founding coupons
// are attached at checkout and isFoundingEligible/recordFoundingMember were
// removed with the offer. The table + read helpers below are KEPT: existing
// founder rows (their discount lives on Stripe, not here) remain queryable,
// and stale rows are harmless. Do not delete founding_members data.
export const FOUNDING_MEMBER_QUOTA = 50;
export interface FoundingMemberRow {
  merchant_id: number;
  subscription_id: string;
  created_at: string;
  priority_support_until: string;
}
export function getFoundingMember(db: Database, merchantId: number): FoundingMemberRow | null {
  return db
    .query("SELECT * FROM founding_members WHERE merchant_id=?")
    .get(merchantId) as FoundingMemberRow | null;
}
export function countFoundingMembers(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM founding_members").get() as { n: number };
  return row.n;
}
/** True when the merchant already holds a founding slot (lifetime benefit). */
export function isFoundingMember(db: Database, merchantId: number): boolean {
  return !!getFoundingMember(db, merchantId);
}
// ── Lifetime free Pro giveaway (owner direction 2026-08) ──
// The owner can grant exactly 10 lifetime free Pro accounts by handing out ONE
// special checkout link (promo=LIFETIME10 — a real Pro subscription at $0
// forever via live coupon EiubBz3c, percent_off=100, duration=forever). This
// mirrors the founding-quota pattern: eligibility is by subscription creation
// order, earned atomically so concurrent progressions can never exceed 10.
// See migrations/032_add_lifetime_members.sql for the table.
export const LIFETIME_MEMBER_QUOTA = 10;
export interface LifetimeMemberRow {
  merchant_id: number;
  subscription_id: string;
  account_email: string | null;
  created_at: string;
}
export function getLifetimeMember(db: Database, merchantId: number): LifetimeMemberRow | null {
  return db
    .query("SELECT * FROM lifetime_members WHERE merchant_id=?")
    .get(merchantId) as LifetimeMemberRow | null;
}
export function countLifetimeMembers(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM lifetime_members").get() as { n: number };
  return row.n;
}
/** True when the merchant already holds a lifetime free-Pro slot. */
export function isLifetimeMember(db: Database, merchantId: number): boolean {
  return !!getLifetimeMember(db, merchantId);
}
/**
 * Atomically record a lifetime free-Pro slot for a completed subscription.
 *
 * The guard lives INSIDE the INSERT (single SQLite statement → serialized with
 * every other writer), so concurrent checkout completions can never overshoot
 * the quota: whoever's INSERT commits first among the open slots wins, in
 * subscription-creation (webhook delivery) order.
 *
 * Returns:
 *   "inserted" — the merchant just earned one of the 10 slots (count was < 10
 *                and the merchant had no row yet).
 *   "already"  — the merchant already holds a lifetime slot; the coupon on the
 *                new subscription is their right, nothing to do.
 *   "full"     — all 10 slots are taken AND this merchant is not a lifetime
 *                member: the coupon must NOT stay on the subscription — the
 *                caller strips the subscription's discount so no 11th
 *                discount exists.
 */
export function recordLifetimeMember(
  db: Database,
  merchantId: number,
  subscriptionId: string,
  accountEmail: string | null,
): "inserted" | "already" | "full" {
  const result = db.run(
    `INSERT INTO lifetime_members (merchant_id, subscription_id, account_email)
     SELECT ?, ?, ?
     WHERE (SELECT COUNT(*) FROM lifetime_members) < ?
       AND NOT EXISTS (SELECT 1 FROM lifetime_members WHERE merchant_id = ?)`,
    [merchantId, subscriptionId, accountEmail, LIFETIME_MEMBER_QUOTA, merchantId],
  );
  if (Number(result.changes) === 1) return "inserted";
  return isLifetimeMember(db, merchantId) ? "already" : "full";
}
// ── Data rights (PROMISES_AUDIT #42) ──
// The privacy page promises: "If you cancel your subscription, your data is
// deleted within 30 days", "You can request immediate deletion", and "Request
// a copy of your stored data". These helpers + purgeMerchantData make those
// promises real. The daily purge scheduler (separate build) runs
// purgeMerchantData on merchants whose deletion_scheduled_at has passed.

/** Number of days between subscription cancellation and the purge deadline. */
export const DELETION_GRACE_DAYS = 30;

/**
 * Start the 30-day deletion clock for a merchant. Only sets the flag when it
 * is currently NULL — an idempotent webhook replay or a second cancellation
 * never moves the deadline later. (A merchant who requested immediate
 * deletion is already purged, so their row is gone and this is a no-op.)
 */
export function scheduleMerchantDeletion(db: Database, merchantId: number): void {
  db.run(
    `UPDATE merchants SET deletion_scheduled_at = datetime('now', '+${DELETION_GRACE_DAYS} days')
     WHERE id = ? AND deletion_scheduled_at IS NULL`,
    [merchantId],
  );
}

/** Clear the deletion clock — used when a merchant resubscribes (an active
 * subscriber is never scheduled for deletion). */
export function clearMerchantDeletion(db: Database, merchantId: number): void {
  db.run("UPDATE merchants SET deletion_scheduled_at = NULL WHERE id = ?", [merchantId]);
}

/**
 * Delete EVERY row stored for a merchant, across every table that references
 * them — the single purge primitive behind both immediate deletion
 * (POST /account/delete) and the 30-day scheduler pass. Idempotent: after the
 * first call the merchant row is gone and every DELETE is a no-op, so calling
 * it again (or for an unknown merchant id) is safe and does nothing.
 *
 * Table coverage (verified against schema.sql + migrations 001–017):
 *   send_logs          — via reminder_tasks of the merchant's invoices (FK chain)
 *   reminder_tasks     — via the merchant's invoices
 *   invoices           — merchant_id
 *   inbound_replies    — merchant_id
 *   subscriptions      — merchant_id
 *   unsubscribes       — merchant_id
 *   sessions           — merchant_id
 *   stripe_connections — merchant_id
 *   oauth_tokens       — merchant_id
 *   email_connections  — merchant_id (sender-identity Phase 1, migration 026)
 *   email_oauth_states — merchant_id (one-time state rows for the email
 *                        authorize hop, migration 026)
 *   subscription_events— merchant_id
 *   merchants          — the row itself
 * Plus the account layer (migration 017) when this merchant is the LAST
 * merchant of its linked account: account_magic_links, account_sessions,
 * oauth_install_states and the accounts row itself are deleted too, so a
 * deleted merchant's sign-in account does not linger. An account that still
 * owns OTHER merchants is kept (deleting it would orphan them).
 *
 * NOT touched (deliberately — not merchant-scoped data): page_visits /
 * waitlist (anonymous landing-page visitor data, keyed by visitor_id/email),
 * support_log (global support mailbox log keyed by email — may include
 * customer emails, never merchant_ids).
 *
 * Runs in a single transaction: a failure mid-way rolls back to the pre-call
 * state. Delete order respects the FK chain (foreign_keys=ON): child rows are
 * removed before the rows they reference.
 */
export function purgeMerchantData(db: Database, merchantId: number): void {
  db.exec("BEGIN");
  try {
    // send_logs → reminder_tasks → invoices (FK chain: send_logs references
    // reminder_tasks, reminder_tasks references invoices). inbound_replies
    // references BOTH invoices and merchants, so it goes before invoices.
    db.run(
      `DELETE FROM send_logs WHERE reminder_task_id IN
        (SELECT id FROM reminder_tasks WHERE invoice_id IN
          (SELECT id FROM invoices WHERE merchant_id = ?))`,
      [merchantId],
    );
    db.run(
      "DELETE FROM reminder_tasks WHERE invoice_id IN (SELECT id FROM invoices WHERE merchant_id = ?)",
      [merchantId],
    );
    db.run("DELETE FROM inbound_replies WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM invoices WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM subscriptions WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM unsubscribes WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM sessions WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM stripe_connections WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM oauth_tokens WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM email_connections WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM email_oauth_states WHERE merchant_id = ?", [merchantId]);
    db.run("DELETE FROM subscription_events WHERE merchant_id = ?", [merchantId]);

    // Account layer: delete the linked account only when this is its last
    // merchant (see the doc comment above).
    const merchant = db.query("SELECT account_id FROM merchants WHERE id = ?").get(merchantId) as
      | { account_id: number | null }
      | null;
    if (merchant?.account_id != null) {
      const others = db
        .query("SELECT COUNT(*) AS n FROM merchants WHERE account_id = ? AND id != ?")
        .get(merchant.account_id, merchantId) as { n: number };
      if (others.n === 0) {
        db.run("DELETE FROM account_magic_links WHERE account_id = ?", [merchant.account_id]);
        db.run("DELETE FROM account_sessions WHERE account_id = ?", [merchant.account_id]);
        db.run("DELETE FROM oauth_install_states WHERE account_id = ?", [merchant.account_id]);
        db.run("DELETE FROM accounts WHERE id = ?", [merchant.account_id]);
      }
    }

    db.run("DELETE FROM merchants WHERE id = ?", [merchantId]);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const FREE_DRAFT_LIMIT = 5;

/**
 * Upgrade-prompt message shown when a free merchant exhausts the 5-draft
 * allowance. Free merchants may SEND within the allowance (owner direction,
 * rev 23) — the 402 appears only when sending would require drafting a NEW
 * draft and no allowance remains. Single source of truth for the task
 * approve/process gates and the UI copy.
 */
export const FREE_ALLOWANCE_MESSAGE = "You've used your free draft allowance. Subscribe to keep sending reminders.";

/**
 * Number of free drafts still available (an all-time, merchant-scoped cap).
 *
 * Only meaningful for merchants WITHOUT an active paid subscription: the
 * 5-draft allowance is a free-tier concept. Paid merchants (Standard or Pro
 * active — see isActivePaidSubscriber) have no draft cap; the dashboard
 * renders "Unlimited" for them (GET /stats → free_drafts_unlimited) and the
 * pipeline gates below already skip the allowance for any active subscriber,
 * so this count is never used to block a paid merchant. Keep using this raw
 * count for the free-tier gates (tasks.ts) — do not return "unlimited" here.
 *
 * Derived from reality, not a stored counter: counts the merchant's
 * reminder_tasks that carry a draft (joined through their invoice), so the
 * value self-heals. Drafts created before the rev-23 counter existed (e.g.
 * the E2E task, drafted mid-test) count immediately, and the count can never
 * drift below the true number of drafts the merchant has used. The legacy
 * `merchants.drafts_used` column is no longer written or read here (left in
 * the schema — dropping it would need a table rebuild; it just stops being
 * used).
 *
 * Rev-23 semantics: the allowance is consumed at draft time, once per task,
 * lifetime. Sent / cancelled / rejected tasks that carry a draft still count
 * (the draft was consumed); pending tasks with no draft do not.
 */
export function freeDraftsRemaining(db: Database, merchantId: number): number {
  const row = db.query(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id WHERE i.merchant_id = ? AND rt.draft_body != ''"
  ).get(merchantId) as { n: number } | undefined;
  const used = row?.n ?? 0;
  return Math.max(0, FREE_DRAFT_LIMIT - used);
}

const STANDARD_INVOICE_LIMIT = 50;

/**
 * Whether the merchant's effective plan is an active Standard subscription —
 * the only plan subject to the 50-overdue-invoice cap. Pro merchants and
 * merchants with no active subscription (free) are never capped.
 */
export function isActiveStandard(db: Database, merchantId: number): boolean {
  const sub = getSubscriptionByMerchantId(db, merchantId);
  return !!sub && sub.status === "active" && sub.tier === "standard";
}

/** Invoice tracking limit for a merchant: 50 when active Standard, null (unlimited) otherwise. */
export function invoiceLimitFor(db: Database, merchantId: number): number | null {
  return isActiveStandard(db, merchantId) ? STANDARD_INVOICE_LIMIT : null;
}

/**
 * Whether the merchant has an ACTIVE paid subscription — Standard or Pro —
 * or is dev-flagged Pro (isDevPro, which counts as paid for entitlement
 * purposes: the paid drawer, paid dashboard state and paid send paths are
 * exactly what the dev flag exists to preview). Homepage parity (owner
 * directive): features advertised on a paid plan (e.g. weekly recovery
 * reports) are gated on any active paid tier, not Pro alone. Merchants with
 * no subscription, or a subscription that is cancelled / past_due, fail this
 * check. Use this for every paid-plan send path so the route and any future
 * scheduled sender share one rule.
 */
export function isActivePaidSubscriber(db: Database, merchantId: number): boolean {
  if (isDevPro(db, merchantId)) return true;
  // The 30-day free trial grants paid-equivalent FULL access to a
  // non-subscriber: GET /stats reports free_drafts_unlimited (so the
  // dashboard renders "Unlimited" instead of a depleted "N of 5" countdown)
  // and every paid send path treats the merchant as subscribed. Once the
  // trial lapses (with no active paid sub) this returns false and the
  // standard free-tier behavior returns.
  if (isWithinFreeTrial(db, merchantId)) return true;
  const sub = getSubscriptionByMerchantId(db, merchantId);
  return !!sub && sub.status === "active" && (sub.tier === "standard" || sub.tier === "pro");
}

/** Count of currently-overdue invoices for a merchant — the measure behind the
 * Standard cap. Mode-scoped since reviewer fix #5 (default live): a merchant's
 * live and test pipelines are separate, so test-mode overdue rows never count
 * against the live cap (and vice versa). */
export function countOverdueInvoices(db: Database, merchantId: number, livemode = 1): number {
  const row = db.query("SELECT COUNT(*) AS count FROM invoices WHERE merchant_id=? AND status='overdue' AND livemode=?").get(merchantId, livemode === 0 ? 0 : 1) as { count: number };
  return row.count;
}

/**
 * The most recent reminder task for an invoice, if any. Used by the Standard
 * cap gate so an invoice is only blocked when it has no existing task — an
 * already-tracked invoice is never re-blocked, and a previously-blocked
 * invoice is automatically picked up once the merchant drops back under the
 * limit.
 */
export function getTaskForInvoice(db: Database, invoiceId: number): { id: number } | null {
  return db.query("SELECT id FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(invoiceId) as { id: number } | null;
}

export function getSubscriptionByStripeId(db: Database, stripeSubscriptionId: string) {
  return db
    .query("SELECT * FROM subscriptions WHERE stripe_subscription_id=?")
    .get(stripeSubscriptionId) as Subscription | null;
}

// ── Internal admin tracking helpers (owner request 2026-08-12) ──
// page_visits + subscription_events are the two new additive tables behind the
// admin-only funnel dashboard (GET /admin). See migrations/012_add_admin_tracking.sql.

/**
 * Record a landing-page visit (POST /api/track). First-party, internal-only
 * analytics: the fields the snippet sends (visitor_id, page, referrer, utm_*,
 * ts) plus server-derived, privacy-masked signals for device/bot/geo
 * classification (owner approved 2026-08-26):
 *   * ip        — MASKED IP (see visitor-signals.ts maskIp: IPv4 /24, IPv6 /64;
 *                 raw IP never stored) — "" when none derivable.
 *   * user_agent — the request's User-Agent header (≤512 chars).
 *   * country    — proxy country header (CF-IPCountry) when forwarded; "" otherwise.
 * Idempotent-ish: the UNIQUE(visitor_id, page, ts) index makes a retried
 * beacon with an identical payload a no-op (ts is generated per page load, so
 * an identical ts means the same visit). Returns whether a row was actually
 * inserted.
 */
export function recordPageVisit(
  db: Database,
  params: {
    visitor_id: string;
    page: string;
    referrer: string;
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    utm_content: string;
    ts: string;
    ip?: string;
    user_agent?: string;
    country?: string;
  }
): boolean {
  const result = db.run(
    `INSERT OR IGNORE INTO page_visits (visitor_id, page, referrer, utm_source, utm_medium, utm_campaign, utm_content, ts, ip, user_agent, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.visitor_id, params.page, params.referrer, params.utm_source, params.utm_medium,
      params.utm_campaign, params.utm_content, params.ts,
      params.ip ?? "", params.user_agent ?? "", params.country ?? "",
    ]
  );
  return result.changes > 0;
}

/**
 * Record a waitlist signup (landing-page email capture). Returns true when a
 * NEW row was inserted, false when the email was already on the list
 * (idempotent — duplicates are a no-op, never an error).
 *
 * `attribution` carries the channel fields the landing page's WaitlistForm
 * forwards (same fields as the visit-tracking beacon — referrer, utm_* and
 * visitor_id, see migrations/016_waitlist_attribution.sql). The route clamps
 * lengths to the track.ts conventions (referrer 500, utm_* 200, visitor_id
 * 128); absent fields default to '' here so pre-existing callers stay
 * unchanged.
 */
export function recordWaitlistSignup(
  db: Database,
  email: string,
  attribution: {
    referrer?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    visitor_id?: string;
  } = {}
): boolean {
  const result = db.run(
    `INSERT OR IGNORE INTO waitlist (email, referrer, utm_source, utm_medium, utm_campaign, utm_content, visitor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      email,
      attribution.referrer ?? "",
      attribution.utm_source ?? "",
      attribution.utm_medium ?? "",
      attribution.utm_campaign ?? "",
      attribution.utm_content ?? "",
      attribution.visitor_id ?? "",
    ]
  );
  return result.changes > 0;
}
/** Total number of waitlist signups (used in the owner notification body). */
export function countWaitlistSignups(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM waitlist").get() as { n: number } | undefined;
  return row?.n ?? 0;
}
export interface WaitlistEntry {
  id: number;
  email: string;
  created_at: string;
  referrer: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  visitor_id: string;
}
/** Latest waitlist signups, newest first (id DESC — matches the visits / subscription-events admin lists), capped at 500. */
export function listWaitlistEntries(db: Database, limit = 500): WaitlistEntry[] {
  const cap = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return db
    .query(
      "SELECT id, email, created_at, referrer, utm_source, utm_medium, utm_campaign, utm_content, visitor_id FROM waitlist ORDER BY id DESC LIMIT ?"
    )
    .all(cap) as WaitlistEntry[];
}
/**
 * Record a subscription lifecycle event (append-only log behind the admin
 * dashboard's "subscription events" view). Called from the /billing webhook
 * handler at every material transition: checkout.session.completed → 'created',
 * customer.subscription.updated → 'updated', customer.subscription.deleted →
 * 'cancelled'. Existing subscriptions rows are never modified — this is purely
 * additive, so prod data stays pristine.
 */
export function recordSubscriptionEvent(
  db: Database,
  params: {
    merchant_id: number;
    stripe_subscription_id: string;
    event: "created" | "updated" | "cancelled";
    tier?: string | null;
    status?: string | null;
  }
): void {
  db.run(
    "INSERT INTO subscription_events (merchant_id, stripe_subscription_id, event, tier, status) VALUES (?, ?, ?, ?, ?)",
    [params.merchant_id, params.stripe_subscription_id, params.event, params.tier ?? null, params.status ?? null]
  );
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

/**
 * Task inbox / history for a merchant.
 *
 * Default (includeAll=false) returns the inbox — tasks the dashboard needs to
 * act on: pending (not yet processed), drafted and reviewed (awaiting-approval
 * candidates). Sent/cancelled tasks are excluded unless includeAll is true
 * (used for history, e.g. the e2e suite).
 *
 * Mode-scoped (reviewer fix #5): `livemode` (1 = live, 0 = test) restricts the
 * result to the active mode's invoices — the drawer never sees the other
 * mode's tasks. Defaults to LIVE (web dashboard sends no mode header).
 *
 * Every row carries the invoice facts plus two inbox-specific fields:
 * - days_overdue: whole days since due_date (mirrors the watcher's math)
 * - awaiting_approval: true when the task has a reviewed draft ready to send
 *   (status 'reviewed'), false otherwise (pending = nothing drafted yet).
 */
export function getAllTasks(db: Database, merchantId: number, includeAll = false, livemode = 1): Array<Record<string, unknown>> {
  const rows = db.query(`
    SELECT rt.*, i.stripe_invoice_id, i.customer_name, i.customer_email, i.amount_cents, i.currency, i.due_date, i.status as invoice_status,
           i.reply_paused_at, i.manually_paused_at, i.reply_opt_out_at, i.dispute_id, i.refund_id,
           (SELECT reply_status FROM inbound_replies WHERE invoice_id = i.id ORDER BY id DESC LIMIT 1) AS reply_status,
           (SELECT detect_classification FROM inbound_replies WHERE invoice_id = i.id ORDER BY id DESC LIMIT 1) AS reply_detect_classification,
           (SELECT action_flag FROM inbound_replies WHERE invoice_id = i.id ORDER BY id DESC LIMIT 1) AS reply_action_flag
    FROM reminder_tasks rt
    JOIN invoices i ON rt.invoice_id = i.id
    WHERE i.merchant_id = ? AND i.livemode = ?
      ${includeAll ? "" : "AND rt.status IN ('pending', 'drafted', 'reviewed')"}
    ORDER BY rt.created_at DESC
  `).all(merchantId, livemode === 0 ? 0 : 1) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const dueDate = String(row.due_date ?? "");
    const daysOverdue = dueDate
      ? Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    return {
      ...row,
      days_overdue: daysOverdue,
      awaiting_approval: row.status === "reviewed",
    };
  });
}

/** Whether the merchant has paused collections (automatic sends skipped). */
export function isMerchantPaused(db: Database, merchantId: number): boolean {
  const merchant = db.query("SELECT paused FROM merchants WHERE id=?").get(merchantId) as { paused: number } | null;
  return !!merchant?.paused;
}

/**
 * Whether the merchant's Stripe account is disconnected (account
 * deauthorized). Automatic sends are skipped exactly like paused; manual
 * actions (/approve, /summary/send) are NOT blocked. Read-only from the API —
 * set only by the account.application.deauthorized webhook handler.
 */
export function isMerchantDisconnected(db: Database, merchantId: number): boolean {
  const merchant = db.query("SELECT disconnected FROM merchants WHERE id=?").get(merchantId) as { disconnected: number } | null;
  return !!merchant?.disconnected;
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
  paused: number;
  disconnected: number;
  /** Dev-only Pro flag: 1 = treat as active Pro subscriber with no real subscription (see isDevPro). */
  dev_pro: number;
  /** The platform account that owns this merchant (migration 017; null for legacy/web-connect merchants). */
  account_id: number | null;
  /** Data-rights deletion clock: when a cancelled merchant is purged (null = none scheduled). */
  deletion_scheduled_at: string | null;
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
  /** 1 = live Stripe mode, 0 = test (reviewer fix #5, migration 022). Every
   *  row is tagged at write; pre-existing rows are live (default 1). */
  livemode: number;
  trust_mode_override: string | null;
  /** 1 once this invoice EVER entered the overdue pipeline (sticky — never
   *  cleared; see migration 020 + upsertInvoice). Backs recovery_events. */
  ever_overdue: number;
  /** Id of the most recent dispute handled for this invoice (idempotency guard). */
  dispute_id: string | null;
  /** Id of the most recent refund handled for this invoice (idempotency guard). */
  refund_id: string | null;
  /** 1 once the payment-received notification has been emailed for this invoice. */
  paid_notified: number;
  /** ISO timestamp set when a customer reply paused this invoice's sequence (reply-pause, D1a). */
  reply_paused_at: string | null;
  /** ISO timestamp set by the merchant's Pause button in the Stripe App drawer (manual pause). */
  manually_paused_at: string | null;
  /** ISO timestamp set by the D1b opt_out classification — stops THIS invoice's reminders only. */
  reply_opt_out_at: string | null;
  /** Manual escalation-stage override (1|2|3) or NULL for auto progression
   *  (migration 031). When set it PINS the invoice's effective stage; clearing
   *  to null restores automatic getEscalationStage() behavior. Honored by the
   *  watcher task factory + the scheduler escalation-advance pass. */
  stage_override: number | null;
  created_at: string;
}

/**
 * Whether an invoice's sequence is stopped (paid, voided, uncollectible,
 * disputed, refunded, reply-paused, manually-paused, or the customer opted out
 * of reminders for it). 'void' and 'uncollectible' are first-class terminal
 * stop states (reviewer fix #2): an invoice voided or marked uncollectible in
 * Stripe is no longer an active debt, and its sequence must never be
 * resurrected by a replayed overdue/payment_failed event or a late-arriving
 * send. This is the "stopped" model shared by the watcher's stale-event guard,
 * the scheduler's sync/advance passes, the sender's pre-send guard, and the
 * inbound reply handler (never re-pause a stopped sequence). A null invoice
 * counts as stopped (callers treat unknown as "don't act").
 */
export function isInvoiceSequenceStopped(invoice: Invoice | null): boolean {
  if (!invoice) return true;
  return (
    invoice.status === "paid" ||
    invoice.status === "void" ||
    invoice.status === "uncollectible" ||
    !!invoice.dispute_id ||
    !!invoice.refund_id ||
    !!invoice.reply_paused_at ||
    !!invoice.manually_paused_at ||
    !!invoice.reply_opt_out_at
  );
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
  /** 'month' | 'year' — billing interval (Phase B; migration 024). */
  interval?: string;
  created_at: string;
}
