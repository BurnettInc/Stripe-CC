/**
 * Scheduler / continuous-sync engine suite (feature/scheduler-continuous-sync).
 *
 * Standalone in-process tests — NO real timers, NO real network. The four
 * passes are pure-ish (db, deps) functions driven with seeded data + a fake
 * clock (deps.now); the invoice-sync pass talks to an in-process Stripe stub
 * (STRIPE_API_BASE → localhost:3199, per-merchant invoice sets keyed by the
 * merchant's bearer token), and email sends are log-only (provider keys
 * deleted before the modules load).
 *
 * Coverage:
 *   (a) sync pass creates a task for a newly-overdue invoice (draft mode →
 *       reviewed, stage from days-overdue vs ladder timing)
 *   (b) Trust Mode respected: Semi-Auto stage-1 invoice is AUTO-SENT by the
 *       sync pass (task status 'sent' + send_logs success)
 *   (c) Standard 50-invoice cap: 55 overdue → 50 tasks created, 5 blocked;
 *       blocked-resume: one tracked invoice paid → the next pass picks up a
 *       previously-blocked invoice
 *   (d) 401 from the invoice pull → merchant marked disconnected + open tasks
 *       cancelled (mirrors account.application.deauthorized)
 *   (e) stopped invoice (dispute) never gets a task from sync
 *   (f) paid transition via sync (missed webhook) → tasks cancelled +
 *       paid_notified (recovery of stale local state)
 *   (g) escalation advance at day 7 (default ladder) and on Pro custom timing
 *       (stage1_days=10/stage2_days=20); cancelled-latest and no-task
 *       invoices are never advanced
 *   (h) weekly summary: paid merchant past 7-day cadence → sent (summary_sends
 *       ledger + send_logs row); free / brand-new / already-sent-5d-ago /
 *       placeholder merchants → skipped
 *   (i) purge: expired deletion clock → merchant purged (FK chain); future
 *       clock / no clock → kept
 *   (j) single-flight guard: a tick while the previous run is in flight is
 *       skipped; the next tick runs
 *   (k) void / uncollectible are first-class TERMINAL stop states (reviewer
 *       fix #2): sync stores them DISTINCTLY and cancels open sequences; a
 *       stale/replayed overdue webhook cannot resurrect them (watcher guard);
 *       the sender skips both without emailing; isInvoiceSequenceStopped
 *       treats both as stopped
 *
 * Run: bun run test-scheduler.ts   (or bash /tmp/run-suite.sh scheduler —
 * the suite driver boots an idle server with SCHEDULER_ENABLED=0; the test
 * uses the same TEST_DB_PATH)
 */
import { Database } from "bun:sqlite";

const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-scheduler-test.db";
const STRIPE_STUB_PORT = 3199;

// ── Environment BEFORE any module import ──
// db.ts reads DB_PATH lazily on first getDb(); oauth-app-install.ts reads
// STRIPE_API_BASE at module load; provider keys are read at call time but
// deleting them up front guarantees log-only sends.
process.env.DB_PATH = DB_PATH;
process.env.STRIPE_API_BASE = `http://localhost:${STRIPE_STUB_PORT}/v1`;
process.env.STRIPE_SECRET_KEY = "sk_test_stub";
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.TOKEN_ENCRYPTION_KEY;
process.env.FROM_EMAIL = "test@example.com";

Bun.spawnSync(["rm", "-f", `${DB_PATH}`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]);

// ── Dynamic imports (env above must be set first) ──
const { getDb, createReminderTask, purgeMerchantData, isInvoiceSequenceStopped } = await import("./src/db");
const sched = await import("./src/pipeline/scheduler");
const watcher = await import("./src/pipeline/watcher");
const sender = await import("./src/pipeline/sender");

const db = getDb();

let failures = 0;
const checks: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  checks.push(label);
  if (cond) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}

// ── Fixtures ──
const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_NOW = new Date("2026-08-17T12:00:00.000Z");
const fakeNow = () => FAKE_NOW;
const DAYS = (n: number) => Math.floor(FAKE_NOW.getTime() / 1000) - n * 86400;

const stubState: {
  invoiceSets: Record<string, unknown[]>;
  failTokens: Set<string>;
  calls: number;
} = { invoiceSets: {}, failTokens: new Set(), calls: 0 };

const stub = Bun.serve({
  port: STRIPE_STUB_PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/invoices" && req.method === "GET") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
      stubState.calls++;
      if (stubState.failTokens.has(token)) {
        return Response.json({ error: { code: "platform_api_key_expired", message: "Expired API key" } }, { status: 401 });
      }
      return Response.json({ data: stubState.invoiceSets[token] ?? [], has_more: false });
    }
    if (url.pathname === "/v1/oauth/token" && req.method === "POST") {
      return Response.json({
        access_token: "rk_refreshed", livemode: false, refresh_token: "rt_refreshed",
        stripe_user_id: "acct_refresh", token_type: "bearer",
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

const DAY = 86400;
function openInvoice(id: string, dueSec: number, amountCents = 10000): Record<string, unknown> {
  return {
    id, status: "open", due_date: dueSec, created: dueSec - 5 * DAY, amount_due: amountCents,
    amount_paid: 0, currency: "usd", customer_name: `Customer ${id}`, customer_email: `cust-${id}@example.com`,
  };
}
function paidInvoice(id: string, createdSec: number, amountCents = 10000): Record<string, unknown> {
  return {
    id, status: "paid", created: createdSec, amount_due: amountCents, amount_paid: amountCents,
    currency: "usd", customer_name: `Customer ${id}`, customer_email: `cust-${id}@example.com`,
  };
}
function inactiveInvoice(id: string, status: string, createdSec: number, amountCents = 10000): Record<string, unknown> {
  return {
    id, status, created: createdSec, amount_due: amountCents, amount_paid: 0,
    currency: "usd", customer_name: `Customer ${id}`, customer_email: `cust-${id}@example.com`,
  };
}

interface SeedMerchantOpts {
  email?: string;
  trustMode?: string;
  createdDaysAgo?: number; // relative to FAKE_NOW; undefined = SQLite now()
  stage1Days?: number;
  stage2Days?: number;
  deletionScheduledAt?: string | null;
  disconnected?: number;
}
function seedMerchant(accountId: string, opts: SeedMerchantOpts = {}): number {
  const created = opts.createdDaysAgo !== undefined ? sqliteFromDate(new Date(FAKE_NOW.getTime() - opts.createdDaysAgo * DAY_MS)) : undefined;
  const info = db.run(
    `INSERT INTO merchants (stripe_account_id, email, trust_mode, created_at, stage1_days, stage2_days, deletion_scheduled_at, disconnected)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`,
    [
      accountId,
      opts.email ?? `${accountId}@example.com`,
      opts.trustMode ?? "draft",
      created ?? null,
      opts.stage1Days ?? 6,
      opts.stage2Days ?? 20,
      opts.deletionScheduledAt ?? null,
      opts.disconnected ?? 0,
    ]
  );
  return Number(info.lastInsertRowid);
}
function sqliteFromDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
function seedConnection(merchantId: number, token: string): void {
  db.run(
    `INSERT INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', datetime('now'), datetime('now'))`,
    [`acct_conn_${merchantId}`, merchantId, token, `rt_${merchantId}`]
  );
}
function seedStandardSub(merchantId: number, tier = "standard"): void {
  db.run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, ?, ?, 'active')",
    [merchantId, `sub_${merchantId}`, tier]
  );
}
function taskCount(merchantId: number): number {
  const row = db.query(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=?"
  ).get(merchantId) as { n: number };
  return row.n;
}
function latestTaskForInvoice(invoiceId: number) {
  return db.query("SELECT * FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(invoiceId);
}
function findInvoiceId(merchantId: number, stripeInvoiceId: string): number {
  const row = db.query("SELECT id FROM invoices WHERE merchant_id=? AND stripe_invoice_id=?").get(merchantId, stripeInvoiceId) as { id: number } | null;
  return row?.id ?? 0;
}

// ════════════════════════════════════════════════════════════════════════
// (a)+(b)+(c) sync pass — task creation, Trust Mode, Standard cap
// ════════════════════════════════════════════════════════════════════════
{
  // m1: free, draft mode → task created at stage 2 (10 days overdue), reviewed (no auto-send in draft).
  const m1 = seedMerchant("acct_m1", { trustMode: "draft" });
  seedConnection(m1, "rk_m1");
  stubState.invoiceSets["rk_m1"] = [openInvoice("in_m1_ovd", DAYS(10), 12345)];

  // m2: free, semi mode → stage-1 invoice auto-sent (Trust Mode respected).
  const m2 = seedMerchant("acct_m2", { trustMode: "semi" });
  seedConnection(m2, "rk_m2");
  stubState.invoiceSets["rk_m2"] = [openInvoice("in_m2_ovd", DAYS(2), 5000)];

  // m3: active Standard → 55 overdue invoices: 50 tracked, 5 cap-blocked.
  const m3 = seedMerchant("acct_m3", { trustMode: "draft", createdDaysAgo: 60 });
  seedConnection(m3, "rk_m3");
  seedStandardSub(m3, "standard");
  stubState.invoiceSets["rk_m3"] = Array.from({ length: 55 }, (_, i) => openInvoice(`in_m3_${i}`, DAYS(3), 1000 + i));

  const r1 = await sched.runInvoiceSyncPass(db, { now: fakeNow, log: () => {} });

  const m1InvId = findInvoiceId(m1, "in_m1_ovd");
  const m1Task = latestTaskForInvoice(m1InvId);
  check("(a) sync pass created a task for the newly-overdue invoice", r1.tasksCreated >= 1 && !!m1Task, JSON.stringify(r1));
  check("(a) task stage = 2 (10 days overdue, default 6/20 ladder)", m1Task?.stage === 2, `stage=${m1Task?.stage}`);
  check("(a) draft-mode task lands 'reviewed' (auto-drafted, NOT auto-sent)", m1Task?.status === "reviewed", `status=${m1Task?.status}`);
  check("(a) invoice marked overdue", db.query("SELECT status FROM invoices WHERE id=?").get(m1InvId)?.status === "overdue", "");

  const m2InvId = findInvoiceId(m2, "in_m2_ovd");
  const m2Task = latestTaskForInvoice(m2InvId);
  const m2Sent = db.query(
    "SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='success'"
  ).get(m2Task?.id ?? -1) as { n: number };
  check("(b) semi-auto stage-1 invoice auto-SENT by sync (task status 'sent')", m2Task?.status === "sent", `status=${m2Task?.status}`);
  check("(b) auto-send logged as success in send_logs", m2Sent.n === 1, `n=${m2Sent.n}`);

  const m3TaskCount = taskCount(m3);
  const m3Invoices = db.query("SELECT id FROM invoices WHERE merchant_id=? AND status='overdue'").all(m3) as { id: number }[];
  const m3Tracked = db.query(
    "SELECT COUNT(DISTINCT i.id) AS n FROM invoices i JOIN reminder_tasks rt ON rt.invoice_id=i.id WHERE i.merchant_id=? AND i.status='overdue'"
  ).get(m3) as { n: number };
  check("(c) Standard cap: exactly 50 of 55 overdue invoices tracked", m3TaskCount === 50 && m3Tracked.n === 50, `tasks=${m3TaskCount} tracked=${m3Tracked.n} invoices=${m3Invoices.length}`);
  check("(c) cap blocks exactly 5 (result.blocked.standardLimit)", r1.blocked.standardLimit === 5, `blocked=${r1.blocked.standardLimit}`);

  // Blocked-resume: one TRACKED invoice becomes paid in Stripe → next pass
  // must pick up one previously-blocked invoice (50 tracked again).
  const trackedM3 = db.query(
    "SELECT i.id, i.stripe_invoice_id FROM invoices i JOIN reminder_tasks rt ON rt.invoice_id=i.id WHERE i.merchant_id=? AND i.status='overdue' ORDER BY i.id LIMIT 1"
  ).get(m3) as { id: number; stripe_invoice_id: string } | null;
  const remaining = db.query(
    "SELECT stripe_invoice_id FROM invoices WHERE merchant_id=? AND status='overdue' AND stripe_invoice_id != ? ORDER BY stripe_invoice_id ASC"
  ).all(m3, trackedM3!.stripe_invoice_id) as { stripe_invoice_id: string }[];
  stubState.invoiceSets["rk_m3"] = [
    paidInvoice(trackedM3!.stripe_invoice_id, DAYS(3), 1000),
    ...remaining.map((r) => openInvoice(r.stripe_invoice_id, DAYS(3), 1000)),
  ];

  const r2 = await sched.runInvoiceSyncPass(db, { now: fakeNow, log: () => {} });
  const m3Tracked2 = db.query(
    "SELECT COUNT(DISTINCT i.id) AS n FROM invoices i JOIN reminder_tasks rt ON rt.invoice_id=i.id WHERE i.merchant_id=? AND i.status='overdue'"
  ).get(m3) as { n: number };
  check("(c) blocked-resume: paid tracked invoice → 1 previously-blocked invoice picked up", r2.tasksCreated === 1 && m3Tracked2.n === 50, `created=${r2.tasksCreated} tracked=${m3Tracked2.n}`);
  check("(c) paid transition closed the tracked invoice's tasks", db.query("SELECT status FROM invoices WHERE id=?").get(trackedM3!.id)?.status === "paid", "");
}

// ════════════════════════════════════════════════════════════════════════
// (d) 401 → disconnected  (e) stopped invoice never gets a task
// ════════════════════════════════════════════════════════════════════════
{
  // m4: connection whose token 401s → marked disconnected, open task cancelled.
  const m4 = seedMerchant("acct_m4", { trustMode: "draft" });
  seedConnection(m4, "rk_m4_bad");
  stubState.failTokens.add("rk_m4_bad");
  stubState.invoiceSets["rk_m4_bad"] = [openInvoice("in_m4_ovd", DAYS(5), 7000)];
  // A pre-existing open task (as if created earlier) that must be cancelled.
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m4_pre', ?, 'C', 'c@example.com', 7000, 'usd', ?, 'overdue')", [m4, sqliteFromDate(new Date(FAKE_NOW.getTime() - 5 * DAY_MS)).slice(0, 10)]);
  const m4Pre = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m4_pre'").get() as { id: number };
  createReminderTask(db, m4Pre.id, 1);

  // m5: invoice disputed locally → sync must NOT create a task for it.
  const m5 = seedMerchant("acct_m5", { trustMode: "draft" });
  seedConnection(m5, "rk_m5");
  stubState.invoiceSets["rk_m5"] = [openInvoice("in_m5_disputed", DAYS(9), 8000)];
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, dispute_id) VALUES ('in_m5_disputed', ?, 'C', 'c@example.com', 8000, 'usd', ?, 'overdue', 'dp_1')", [m5, sqliteFromDate(new Date(FAKE_NOW.getTime() - 9 * DAY_MS)).slice(0, 10)]);

  const r3 = await sched.runInvoiceSyncPass(db, { now: fakeNow, log: () => {} });

  check("(d) 401 pull → merchant marked disconnected", (db.query("SELECT disconnected FROM merchants WHERE id=?").get(m4) as { disconnected: number }).disconnected === 1, "");
  check("(d) 401 → open task cancelled (deauthorized semantics)", (db.query("SELECT status FROM reminder_tasks WHERE invoice_id=?").get(m4Pre.id) as { status: string }).status === "cancelled", "");
  check("(d) result.disconnected reports the merchant", r3.disconnected.includes(String(m4)), JSON.stringify(r3.disconnected));

  const m5TaskCount = taskCount(m5);
  check("(e) disputed invoice never gets a task from sync", m5TaskCount === 0, `tasks=${m5TaskCount}`);
  check("(e) dispute flag survives the sync upsert", (db.query("SELECT dispute_id FROM invoices WHERE stripe_invoice_id='in_m5_disputed'").get() as { dispute_id: string }).dispute_id === "dp_1", "");
}

// ════════════════════════════════════════════════════════════════════════
// (f) paid transition via sync (missed webhook recovery)
// ════════════════════════════════════════════════════════════════════════
{
  const m6 = seedMerchant("acct_m6", { email: "m6@example.com", trustMode: "draft" });
  seedConnection(m6, "rk_m6");
  // Local stale state: overdue invoice + open task (the webhook was missed).
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m6_paid', ?, 'C6', 'c6@example.com', 9000, 'usd', ?, 'overdue')", [m6, sqliteFromDate(new Date(FAKE_NOW.getTime() - 6 * DAY_MS)).slice(0, 10)]);
  const m6Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m6_paid'").get() as { id: number };
  createReminderTask(db, m6Inv.id, 1);
  // Stripe now says paid.
  stubState.invoiceSets["rk_m6"] = [paidInvoice("in_m6_paid", DAYS(10), 9000)];

  await sched.runInvoiceSyncPass(db, { now: fakeNow, log: () => {} });

  const m6Row = db.query("SELECT * FROM invoices WHERE stripe_invoice_id='in_m6_paid'").get() as { status: string; paid_notified: number };
  const m6Tasks = db.query("SELECT status FROM reminder_tasks WHERE invoice_id=?").all(m6Inv.id) as { status: string }[];
  check("(f) sync propagates paid → local status paid", m6Row.status === "paid", `status=${m6Row.status}`);
  check("(f) paid transition cancelled the open task", m6Tasks.every((t) => t.status === "cancelled"), JSON.stringify(m6Tasks));
  check("(f) payment-received notification marked once (paid_notified)", m6Row.paid_notified === 1, `paid_notified=${m6Row.paid_notified}`);
}

// ════════════════════════════════════════════════════════════════════════
// (g) escalation advance — default ladder day 7/21 + Pro custom timing
// ════════════════════════════════════════════════════════════════════════
{
  // m7: Pro custom timing stage1=10 stage2=20; invoice 25 days overdue →
  // expected stage 3; existing task at stage 1 must advance straight to 3.
  const m7 = seedMerchant("acct_m7", { trustMode: "draft", stage1Days: 10, stage2Days: 20 });
  seedStandardSub(m7, "pro");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m7_adv', ?, 'C7', 'c7@example.com', 11000, 'usd', ?, 'overdue')", [m7, sqliteFromDate(new Date(FAKE_NOW.getTime() - 25 * DAY_MS)).slice(0, 10)]);
  const m7Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m7_adv'").get() as { id: number };
  createReminderTask(db, m7Inv.id, 1);

  // m8: default ladder; invoice 8 days overdue → stage 2; sent stage-1 task.
  const m8 = seedMerchant("acct_m8", { trustMode: "draft" });
  seedStandardSub(m8, "standard");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m8_adv', ?, 'C8', 'c8@example.com', 12000, 'usd', ?, 'overdue')", [m8, sqliteFromDate(new Date(FAKE_NOW.getTime() - 8 * DAY_MS)).slice(0, 10)]);
  const m8Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m8_adv'").get() as { id: number };
  const m8T1 = createReminderTask(db, m8Inv.id, 1);
  db.run("UPDATE reminder_tasks SET status='sent', sent_at=datetime('now') WHERE id=?", [m8T1]);

  // m9: default ladder; invoice 30 days overdue → stage 3; sent stage-2 task.
  const m9 = seedMerchant("acct_m9", { trustMode: "draft" });
  seedStandardSub(m9, "standard");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m9_adv', ?, 'C9', 'c9@example.com', 13000, 'usd', ?, 'overdue')", [m9, sqliteFromDate(new Date(FAKE_NOW.getTime() - 30 * DAY_MS)).slice(0, 10)]);
  const m9Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m9_adv'").get() as { id: number };
  const m9T2 = createReminderTask(db, m9Inv.id, 2);
  db.run("UPDATE reminder_tasks SET status='sent', sent_at=datetime('now') WHERE id=?", [m9T2]);

  // m10: still stage-1 (5 days overdue) → must NOT advance.
  const m10 = seedMerchant("acct_m10", { trustMode: "draft" });
  seedStandardSub(m10, "standard");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m10_no', ?, 'C10', 'c10@example.com', 14000, 'usd', ?, 'overdue')", [m10, sqliteFromDate(new Date(FAKE_NOW.getTime() - 5 * DAY_MS)).slice(0, 10)]);
  const m10Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m10_no'").get() as { id: number };
  createReminderTask(db, m10Inv.id, 1);

  // m11: cancelled-latest (stopped sequence) → never advanced.
  const m11 = seedMerchant("acct_m11", { trustMode: "draft" });
  seedStandardSub(m11, "standard");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m11_cx', ?, 'C11', 'c11@example.com', 15000, 'usd', ?, 'overdue')", [m11, sqliteFromDate(new Date(FAKE_NOW.getTime() - 40 * DAY_MS)).slice(0, 10)]);
  const m11Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m11_cx'").get() as { id: number };
  const m11T = createReminderTask(db, m11Inv.id, 1);
  db.run("UPDATE reminder_tasks SET status='cancelled' WHERE id=?", [m11T]);

  const rg = await sched.runEscalationAdvancePass(db, { now: fakeNow, log: () => {} });

  const m7Latest = latestTaskForInvoice(m7Inv.id) as { stage: number; status: string };
  const m7Old = db.query("SELECT stage, status FROM reminder_tasks WHERE invoice_id=? ORDER BY id ASC").all(m7Inv.id) as { stage: number; status: string }[];
  check("(g) Pro custom timing: stage 1 → 3 on day 25 (stage1=10/stage2=20)", m7Latest.stage === 3, `stage=${m7Latest.stage}`);
  check("(g) old stage-1 task cancelled by the advance", m7Old.some((t) => t.stage === 1 && t.status === "cancelled"), JSON.stringify(m7Old));
  check("(g) advanced task is drafted 'reviewed' (draft mode, no auto-send)", m7Latest.status === "reviewed", `status=${m7Latest.status}`);

  const m8Latest = latestTaskForInvoice(m8Inv.id) as { stage: number; status: string };
  check("(g) default ladder: sent stage-1 → stage 2 on day 8", m8Latest.stage === 2, `stage=${m8Latest.stage}`);

  const m9Latest = latestTaskForInvoice(m9Inv.id) as { stage: number; status: string };
  check("(g) default ladder: sent stage-2 → stage 3 on day 30", m9Latest.stage === 3, `stage=${m9Latest.stage}`);

  const m10Latest = latestTaskForInvoice(m10Inv.id) as { stage: number };
  check("(g) no advance below the next threshold (day 5 stays stage 1)", m10Latest.stage === 1 && taskCount(m10) === 1, `stage=${m10Latest.stage}`);

  const m11Latest = latestTaskForInvoice(m11Inv.id) as { stage: number; status: string };
  check("(g) cancelled-latest sequence never resurrected", m11Latest.stage === 1 && m11Latest.status === "cancelled", `stage=${m11Latest.stage} status=${m11Latest.status}`);
  check("(g) advance pass reports the advances", rg.advanced === 3, `advanced=${rg.advanced}`);
}

// ════════════════════════════════════════════════════════════════════════
// (h) weekly summary — paid gate + 7-day cadence + placeholder skip
// ════════════════════════════════════════════════════════════════════════
{
  // m12: paid Standard, real email, created 10 days before fake now → due.
  const m12 = seedMerchant("acct_m12", { email: "m12@example.com", createdDaysAgo: 10 });
  seedStandardSub(m12, "standard");
  // m13: FREE → never sent. Aged 40 days so it is OUTSIDE the 30-day free
  // trial (a fresh merchant is full-access/in-trial and would earn a summary).
  const m13 = seedMerchant("acct_m13", { email: "m13@example.com", createdDaysAgo: 40 });
  // m14: paid but only 3 days old → not due yet (first summary after a week).
  const m14 = seedMerchant("acct_m14", { email: "m14@example.com", createdDaysAgo: 3 });
  seedStandardSub(m14, "standard");
  // m15: paid, real email, sent 5 days ago → not due (7-day cadence).
  const m15 = seedMerchant("acct_m15", { email: "m15@example.com", createdDaysAgo: 30 });
  seedStandardSub(m15, "standard");
  db.run("INSERT INTO summary_sends (merchant_id, sent_at, status) VALUES (?, '2026-08-12 10:00:00', 'sent')", [m15]);
  // m16: paid but placeholder email (.local) → skipped.
  const m16 = seedMerchant("acct_m16", { email: "user_acct_m16@install.local", createdDaysAgo: 20 });
  seedStandardSub(m16, "standard");

  const rh = await sched.runWeeklySummaryPass(db, { now: fakeNow, log: () => {} });

  const m12Sends = db.query("SELECT COUNT(*) AS n FROM summary_sends WHERE merchant_id=?").get(m12) as { n: number };
  const weeklyLogs = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='weekly_summary'").get() as { n: number };
  check("(h) paid merchant past the cadence → weekly summary sent (ledger row)", m12Sends.n === 1, `n=${m12Sends.n}`);
  check("(h) weekly summary logged in send_logs", weeklyLogs.n >= 1, `n=${weeklyLogs.n}`);
  const m13Sends = db.query("SELECT COUNT(*) AS n FROM summary_sends WHERE merchant_id=?").get(m13) as { n: number };
  check("(h) free merchant NEVER gets a summary", m13Sends.n === 0, `n=${m13Sends.n}`);
  const m14Sends = db.query("SELECT COUNT(*) AS n FROM summary_sends WHERE merchant_id=?").get(m14) as { n: number };
  check("(h) brand-new paid merchant not due before 7 days", m14Sends.n === 0, `n=${m14Sends.n}`);
  const m15Sends = db.query("SELECT COUNT(*) AS n FROM summary_sends WHERE merchant_id=?").get(m15) as { n: number };
  check("(h) merchant sent 5 days ago not re-sent (7-day cadence)", m15Sends.n === 1, `n=${m15Sends.n}`);
  const m16Sends = db.query("SELECT COUNT(*) AS n FROM summary_sends WHERE merchant_id=?").get(m16) as { n: number };
  check("(h) placeholder merchant never sent", m16Sends.n === 0, `n=${m16Sends.n}`);
  check("(h) summary pass reports the paid sends", rh.sent >= 1, `sent=${rh.sent}`);
}

// ════════════════════════════════════════════════════════════════════════
// (i) purge pass — expired clock purged (FK chain), future/null kept
// ════════════════════════════════════════════════════════════════════════
{
  // m17: expired clock, with children (session + subscription) → fully purged.
  const m17 = seedMerchant("acct_m17", { email: "m17@example.com", deletionScheduledAt: "2026-08-16 12:00:00" });
  seedStandardSub(m17, "standard");
  db.run("INSERT INTO sessions (token, merchant_id, expires_at) VALUES ('sess_m17', ?, datetime('now','+30 days'))", [m17]);
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m17', ?, 'C', 'c@example.com', 100, 'usd', '2026-08-01', 'overdue')", [m17]);
  // m18: future clock → kept. m19: no clock → kept.
  const m18 = seedMerchant("acct_m18", { deletionScheduledAt: "2026-08-18 12:00:00" });
  const m19 = seedMerchant("acct_m19", {});

  const ri = await sched.runPurgePass(db, { now: fakeNow, log: () => {} });

  check("(i) expired-clock merchant purged", db.query("SELECT id FROM merchants WHERE id=?").get(m17) === null, "");
  check("(i) purge removed the merchant's children (session, subscription, invoice)", db.query("SELECT token FROM sessions WHERE token='sess_m17'").get() === null && db.query("SELECT id FROM subscriptions WHERE merchant_id=?").get(m17) === null && db.query("SELECT id FROM invoices WHERE merchant_id=?").get(m17) === null, "");
  check("(i) future-clock merchant kept", db.query("SELECT id FROM merchants WHERE id=?").get(m18) !== null, "");
  check("(i) no-clock merchant kept", db.query("SELECT id FROM merchants WHERE id=?").get(m19) !== null, "");
  check("(i) purge pass reports 1 expired + 1 purged", ri.expired === 1 && ri.purged === 1, JSON.stringify(ri));
  // purgeMerchantData direct idempotency: purging an already-purged id is a safe no-op.
  try {
    purgeMerchantData(db, m17);
    check("(i) purgeMerchantData on an already-purged id is a safe no-op", true, "");
  } catch {
    check("(i) purgeMerchantData on an already-purged id is a safe no-op", false, "threw");
  }
}

// ════════════════════════════════════════════════════════════════════════
// (j) single-flight guard
// ════════════════════════════════════════════════════════════════════════
{
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  let runs = 0;
  const wrapped = sched.singleFlightPass("test-flight", async () => { runs++; await gate; }, () => {});
  const first = wrapped(); // starts, awaits the gate
  await new Promise((r) => setTimeout(r, 20));
  const second = await wrapped();
  check("(j) tick while the previous run is in flight is SKIPPED", second.skipped === true, JSON.stringify(second));
  release();
  await first;
  check("(j) first tick ran to completion", runs === 1, `runs=${runs}`);
  const third = await wrapped();
  check("(j) next tick runs after the previous completed", third.skipped === false && runs === 2, `skipped=${third.skipped} runs=${runs}`);
}

// ════════════════════════════════════════════════════════════════════════
// (k) void / uncollectible — first-class terminal stop states (reviewer fix #2)
// ════════════════════════════════════════════════════════════════════════
{
  // Unit: the shared "stopped" model treats both as stopped.
  check("(k) isInvoiceSequenceStopped(void) === true", isInvoiceSequenceStopped({ status: "void" } as never), "");
  check("(k) isInvoiceSequenceStopped(uncollectible) === true", isInvoiceSequenceStopped({ status: "uncollectible" } as never), "");
  check("(k) isInvoiceSequenceStopped(overdue) === false", !isInvoiceSequenceStopped({ status: "overdue" } as never), "");

  // m20: invoice VOIDED in Stripe after a missed webhook → local status 'void'
  // (distinct), open task cancelled, never re-chased.
  const m20 = seedMerchant("acct_m20", { trustMode: "draft" });
  seedConnection(m20, "rk_m20");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m20_void', ?, 'C20', 'c20@example.com', 16000, 'usd', ?, 'overdue')", [m20, sqliteFromDate(new Date(FAKE_NOW.getTime() - 8 * DAY_MS)).slice(0, 10)]);
  const m20Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m20_void'").get() as { id: number };
  createReminderTask(db, m20Inv.id, 2);
  stubState.invoiceSets["rk_m20"] = [inactiveInvoice("in_m20_void", "void", DAYS(8), 16000)];

  // m21: invoice marked UNCOLLECTIBLE in Stripe → stored 'uncollectible'
  // (DISTINCT from 'void'), open task cancelled.
  const m21 = seedMerchant("acct_m21", { trustMode: "draft" });
  seedConnection(m21, "rk_m21");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m21_unc', ?, 'C21', 'c21@example.com', 17000, 'usd', ?, 'overdue')", [m21, sqliteFromDate(new Date(FAKE_NOW.getTime() - 9 * DAY_MS)).slice(0, 10)]);
  const m21Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m21_unc'").get() as { id: number };
  createReminderTask(db, m21Inv.id, 2);
  stubState.invoiceSets["rk_m21"] = [inactiveInvoice("in_m21_unc", "uncollectible", DAYS(9), 17000)];

  await sched.runInvoiceSyncPass(db, { now: fakeNow, log: () => {} });
  await sched.runInvoiceSyncPass(db, { now: fakeNow, log: () => {} }); // a second pass must not resurrect anything

  const m20Row = db.query("SELECT status FROM invoices WHERE id=?").get(m20Inv.id) as { status: string };
  const m21Row = db.query("SELECT status FROM invoices WHERE id=?").get(m21Inv.id) as { status: string };
  check("(k) sync stores 'void' DISTINCTLY", m20Row.status === "void", `status=${m20Row.status}`);
  check("(k) sync stores 'uncollectible' DISTINCTLY (NOT collapsed into 'void')", m21Row.status === "uncollectible", `status=${m21Row.status}`);
  const m20Tasks = db.query("SELECT status FROM reminder_tasks WHERE invoice_id=?").all(m20Inv.id) as { status: string }[];
  const m21Tasks = db.query("SELECT status FROM reminder_tasks WHERE invoice_id=?").all(m21Inv.id) as { status: string }[];
  check("(k) void transition cancelled the open task", m20Tasks.length === 1 && m20Tasks[0].status === "cancelled", JSON.stringify(m20Tasks));
  check("(k) uncollectible transition cancelled the open task", m21Tasks.length === 1 && m21Tasks[0].status === "cancelled", JSON.stringify(m21Tasks));
  check("(k) no new tasks after the stop (second pass created nothing)", taskCount(m20) === 1 && taskCount(m21) === 1, `m20=${taskCount(m20)} m21=${taskCount(m21)}`);

  // m22: a stale/replayed overdue WEBHOOK must not resurrect a stopped invoice
  // (the watcher's stale-event guard — the actual resurrection bug fixed).
  const m22 = seedMerchant("acct_m22", { trustMode: "draft" });
  seedConnection(m22, "rk_m22");
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m22_void', ?, 'C22', 'c22@example.com', 18000, 'usd', ?, 'void')", [m22, sqliteFromDate(new Date(FAKE_NOW.getTime() - 10 * DAY_MS)).slice(0, 10)]);
  const m22Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m22_void'").get() as { id: number };
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m22_unc', ?, 'C22', 'c22@example.com', 18000, 'usd', ?, 'uncollectible')", [m22, sqliteFromDate(new Date(FAKE_NOW.getTime() - 11 * DAY_MS)).slice(0, 10)]);
  const m22Unc = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m22_unc'").get() as { id: number };

  const staleVoid = await watcher.handleWebhookEvent(db, {
    type: "invoice.overdue",
    account: "acct_m22",
    data: { object: { id: "in_m22_void", status: "open", customer_name: "C22", customer_email: "c22@example.com", amount_due: 18000, currency: "usd", due_date: DAYS(10) } },
  } as never);
  const staleUnc = await watcher.handleWebhookEvent(db, {
    type: "invoice.payment_failed",
    account: "acct_m22",
    data: { object: { id: "in_m22_unc", status: "open", customer_name: "C22", customer_email: "c22@example.com", amount_due: 18000, currency: "usd", due_date: DAYS(11) } },
  } as never);
  check("(k) stale overdue webhook skipped for a VOIDED invoice (action names it)", staleVoid.action.includes("already voided"), staleVoid.action);
  check("(k) stale payment_failed webhook skipped for an UNCOLLECTIBLE invoice", staleUnc.action.includes("already uncollectible"), staleUnc.action);
  check("(k) voided invoice NOT resurrected by the stale webhook (status stays void, no task)", (db.query("SELECT status FROM invoices WHERE id=?").get(m22Inv.id) as { status: string }).status === "void" && taskCount(m22) === 0, "");
  check("(k) uncollectible invoice NOT resurrected (status stays uncollectible)", (db.query("SELECT status FROM invoices WHERE id=?").get(m22Unc.id) as { status: string }).status === "uncollectible", "");

  // Sender: a voided/uncollectible invoice is never emailed (pre-send guard).
  const m23 = seedMerchant("acct_m23", { trustMode: "draft" });
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m23_void', ?, 'C23', 'c23@example.com', 19000, 'usd', ?, 'void')", [m23, sqliteFromDate(new Date(FAKE_NOW.getTime() - 12 * DAY_MS)).slice(0, 10)]);
  const m23Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m23_void'").get() as { id: number };
  const m23Task = createReminderTask(db, m23Inv.id, 3);
  const m23Res = sender.sendEmail(db, db.query("SELECT * FROM reminder_tasks WHERE id=?").get(m23Task) as never, { subject: "reminder", body: "please pay" });
  const m23Skips = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='skipped'").get(m23Task) as { n: number };
  const m23Sends = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='success'").get(m23Task) as { n: number };
  check("(k) sender skips a VOIDED invoice (no email)", m23Res.success === false && (m23Res.message ?? "").includes("voided"), JSON.stringify(m23Res));
  check("(k) void skip logged as skipped, NO success log", m23Skips.n === 1 && m23Sends.n === 0, `skips=${m23Skips.n} sends=${m23Sends.n}`);

  const m24 = seedMerchant("acct_m24", { trustMode: "draft" });
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m24_unc', ?, 'C24', 'c24@example.com', 20000, 'usd', ?, 'uncollectible')", [m24, sqliteFromDate(new Date(FAKE_NOW.getTime() - 13 * DAY_MS)).slice(0, 10)]);
  const m24Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m24_unc'").get() as { id: number };
  const m24Task = createReminderTask(db, m24Inv.id, 3);
  const m24Res = sender.sendEmail(db, db.query("SELECT * FROM reminder_tasks WHERE id=?").get(m24Task) as never, { subject: "reminder", body: "please pay" });
  const m24Skips = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='skipped'").get(m24Task) as { n: number };
  const m24Sends = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='success'").get(m24Task) as { n: number };
  check("(k) sender skips an UNCOLLECTIBLE invoice (no email)", m24Res.success === false && (m24Res.message ?? "").includes("uncollectible"), JSON.stringify(m24Res));
  check("(k) uncollectible skip logged as skipped, NO success log (no thank-you for an unpaid debt)", m24Skips.n === 1 && m24Sends.n === 0, `skips=${m24Skips.n} sends=${m24Sends.n}`);

  // Control: the paid case keeps its thank-you success log (back-compat).
  const m25 = seedMerchant("acct_m25", { trustMode: "draft" });
  db.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES ('in_m25_paid', ?, 'C25', 'c25@example.com', 21000, 'usd', ?, 'paid')", [m25, sqliteFromDate(new Date(FAKE_NOW.getTime() - 14 * DAY_MS)).slice(0, 10)]);
  const m25Inv = db.query("SELECT id FROM invoices WHERE stripe_invoice_id='in_m25_paid'").get() as { id: number };
  const m25Task = createReminderTask(db, m25Inv.id, 3);
  const m25Res = sender.sendEmail(db, db.query("SELECT * FROM reminder_tasks WHERE id=?").get(m25Task) as never, { subject: "reminder", body: "please pay" });
  const m25Sends = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='success'").get(m25Task) as { n: number };
  check("(k) paid skip keeps the simulated thank-you success log (back-compat)", m25Res.success === false && m25Sends.n >= 1, JSON.stringify(m25Res));
}

// ── Cleanup ──
stub.stop(true);

const passed = checks.length - failures;
console.log("\n═══════════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed, ${failures} failed`);
console.log("═══════════════════════════════════════════════");
process.exit(failures === 0 ? 0 : 1);
