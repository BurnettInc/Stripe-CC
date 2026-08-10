/**
 * Webhooks & notifications (part 2) — endpoint tests.
 *
 * Covers the homepage-parity promises against the running server:
 *   1. charge.dispute.created   → pauses the invoice's sequence (tasks
 *      cancelled) + merchant notification; idempotent on replay.
 *   2. charge.refunded          → cancels the linked invoice's tasks (no
 *      notification) and logs a 'refund' send_logs entry.
 *   3. account.application.deauthorized → merchants.disconnected=1, ALL
 *      merchant tasks cancelled, merchant-level 'disconnect' log, GET
 *      /settings exposes disconnected, and POST /tasks/:id/process auto-skips
 *      while disconnected (task kept, not sent).
 *   4. invoice.paid             → payment-received merchant notification ONLY
 *      when the invoice was being followed up, and only once.
 *   5. Escalation notification  → fires on successful Stage 2/3 sends, not
 *      Stage 1.
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing the SQLite DB it seeds (TEST_DB_PATH, default /tmp/cc-notif-test.db).
 * Webhooks are unauthenticated; authed routes use a session seeded for
 * merchant 2 (a real-email merchant so notifyMerchant actually logs).
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-notif-test.db bun run test-notifications.ts
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-notif-test.db";
const SESSION = "test-notifications-session";
const ACCOUNT = "acct_notify_real"; // merchant 2's connected Stripe account

// ── DB helpers ──
function db(): Database {
  // Bun 1.3.x: default constructor only ({create:false} throws SQLITE_MISUSE).
  return new Database(DB_PATH);
}

/** Seed session + Pro subscription + real-email merchant + connection. */
function seedAuthAndMerchant(): number {
  const d = db();
  // Merchant 1 (acct_default) is auto-created by ensureDefaultMerchant on the
  // first request; we add merchant 2 with a REAL email so notifyMerchant
  // actually logs a merchant_notification row.
  d.run(
    "INSERT OR IGNORE INTO merchants (stripe_account_id, email, trust_mode) VALUES (?, ?, 'full')",
    [ACCOUNT, "merchant@example.com"]
  );
  const m2 = d.query("SELECT id FROM merchants WHERE stripe_account_id=?").get(ACCOUNT) as { id: number };
  d.run("INSERT OR IGNORE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES (?, ?, '', NULL, '')", [ACCOUNT, m2.id]);
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [SESSION, m2.id]);
  const existing = d.query("SELECT id FROM subscriptions WHERE merchant_id=?").get(m2.id) as { id: number } | null;
  if (existing) {
    d.run("UPDATE subscriptions SET status='active', tier='pro' WHERE merchant_id=?", [m2.id]);
  } else {
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_notif', 'pro', 'active')", [m2.id]);
  }
  d.close();
  return m2.id;
}

function seedInvoice(stripeId: string, amountCents: number, customerName: string, customerEmail: string, merchantId = 2): number {
  const d = db();
  d.run(
    `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status)
     VALUES (?, ?, ?, ?, ?, 'usd', date('now', '-10 days'), 'overdue')`,
    [stripeId, merchantId, customerName, customerEmail, amountCents]
  );
  const id = (d.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(stripeId) as { id: number }).id;
  d.close();
  return id;
}

function seedTask(invoiceId: number, stage: number, status: string): number {
  const d = db();
  d.run("INSERT INTO reminder_tasks (invoice_id, stage, status) VALUES (?, ?, ?)", [invoiceId, stage, status]);
  const id = (d.query("SELECT id FROM reminder_tasks WHERE invoice_id=? ORDER BY id DESC LIMIT 1").get(invoiceId) as { id: number }).id;
  d.close();
  return id;
}

// ── HTTP helpers ──
function af(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Cookie", `session=${encodeURIComponent(SESSION)}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}

function fireWebhook(type: string, object: Record<string, unknown>, account = ACCOUNT): Promise<{ action: string }> {
  return fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, account, data: { object } }),
  }).then((r) => r.json());
}

function daysAgoTimestamp(days: number): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return Math.floor(d.getTime() / 1000);
}

function fireOverdueWebhook(stripeId: string, daysAgo: number, amountCents: number, customerEmail: string): Promise<{ action: string; invoiceId: number; taskId: number }> {
  return fireWebhook("invoice.overdue", {
    id: stripeId,
    customer_name: "Escalating Client",
    customer_email: customerEmail,
    amount_due: amountCents,
    currency: "usd",
    due_date: daysAgoTimestamp(daysAgo),
  });
}

function countNotificationLogs(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='merchant_notification'").get() as { n: number };
  d.close();
  return row.n;
}

function taskStatus(taskId: number): string {
  const d = db();
  const row = d.query("SELECT status FROM reminder_tasks WHERE id=?").get(taskId) as { status: string } | null;
  d.close();
  return row?.status ?? "missing";
}

function latestNotificationMessage(): string {
  const d = db();
  const row = d.query(
    "SELECT provider_message FROM send_logs WHERE type='merchant_notification' ORDER BY id DESC LIMIT 1"
  ).get() as { provider_message: string } | null;
  d.close();
  return row?.provider_message ?? "";
}

// ── Test harness ──
interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details = "") {
  results.push({ name, pass, details });
  const icon = pass ? "✅" : "❌";
  console.log(`${icon} ${name}`);
  if (!pass && details) console.log(`   FAIL: ${details}`);
}

async function run() {
  // Wake the server first so schema + migration 008 are applied (lazy getDb),
  // then seed auth state.
  const health = await fetch(`${BASE}/health`);
  if (!health.ok) throw new Error(`Server at ${BASE} not healthy: ${health.status}`);
  const merchantId = seedAuthAndMerchant();
  console.log("═══════════════════════════════════════════════");
  console.log("  Webhooks & Notifications (part 2) — Endpoint Tests");
  console.log(`  merchantId=${merchantId} account=${ACCOUNT}`);
  console.log("═══════════════════════════════════════════════\n");

  // ────────────────────────────────────────────────────
  // 1. charge.dispute.created
  // ────────────────────────────────────────────────────
  try {
    const invId = seedInvoice("INV-D1", 5000, "Disputed Client", "disputed@example.com");
    const taskId = seedTask(invId, 1, "reviewed");
    const notifBefore = countNotificationLogs();

    const res1 = await fireWebhook("charge.dispute.created", { id: "dp_1", charge: "ch_1", amount: 5000 });
    const cancelled = taskStatus(taskId) === "cancelled";
    const notifAfter1 = countNotificationLogs();
    const msg1 = latestNotificationMessage();
    const notified1 = notifAfter1 === notifBefore + 1 && msg1.includes("Dispute filed on invoice INV-D1");

    // Replay the same dispute — must not pause again or double-notify.
    const res2 = await fireWebhook("charge.dispute.created", { id: "dp_1", charge: "ch_1", amount: 5000 });
    const notifAfter2 = countNotificationLogs();
    const idempotent = notifAfter2 === notifAfter1 && res2.action.includes("idempotent");

    const pass = res1.action.includes("paused reminders for invoice INV-D1") && cancelled && notified1 && idempotent;
    record("dispute.created: pauses invoice (tasks cancelled) + merchant notification, no double-notify on replay", pass,
      pass ? "" : `res1=${JSON.stringify(res1)} taskStatus=${taskStatus(taskId)} notif ${notifBefore}→${notifAfter1}→${notifAfter2} msg="${msg1}" res2=${JSON.stringify(res2)}`);
  } catch (e: any) {
    record("dispute.created: pauses invoice + notifies, no double-notify", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // 2. charge.refunded
  // ────────────────────────────────────────────────────
  try {
    const invId = seedInvoice("INV-R1", 2500, "Refunded Client", "refunded@example.com");
    const taskId = seedTask(invId, 1, "reviewed");
    const notifBefore = countNotificationLogs();

    const res = await fireWebhook("charge.refunded", { id: "re_1", charge: "ch_2", amount: 2500, status: "succeeded" });

    const d = db();
    const refundLog = d.query("SELECT provider_message FROM send_logs WHERE type='refund' ORDER BY id DESC LIMIT 1").get() as { provider_message: string } | null;
    d.close();

    const pass =
      taskStatus(taskId) === "cancelled" &&
      res.action.includes("stopped reminders for invoice INV-R1") &&
      !!refundLog && refundLog.provider_message.includes("INV-R1") &&
      countNotificationLogs() === notifBefore; // no merchant notification for refunds
    record("charge.refunded: cancels invoice tasks + refund log, no notification", pass,
      pass ? "" : `res=${JSON.stringify(res)} taskStatus=${taskStatus(taskId)} refundLog=${JSON.stringify(refundLog)} notifBefore=${notifBefore} notifAfter=${countNotificationLogs()}`);
  } catch (e: any) {
    record("charge.refunded: cancels tasks + refund log, no notification", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // 3. account.application.deauthorized
  // ────────────────────────────────────────────────────
  try {
    const invA = seedInvoice("INV-D2", 1000, "Client A", "a@example.com");
    const taskA = seedTask(invA, 1, "pending");
    const invB = seedInvoice("INV-D3", 1500, "Client B", "b@example.com");
    const taskB = seedTask(invB, 2, "drafted");

    const res = await fireWebhook("account.application.deauthorized", { id: ACCOUNT });

    const d = db();
    const disconnected = (d.query("SELECT disconnected FROM merchants WHERE id=?").get(merchantId) as { disconnected: number }).disconnected;
    const disconnectLog = d.query("SELECT provider_message FROM send_logs WHERE type='disconnect' ORDER BY id DESC LIMIT 1").get() as { provider_message: string } | null;
    d.close();

    const settings = await (await af("/settings")).json() as { disconnected?: boolean };

    const pass =
      disconnected === 1 &&
      taskStatus(taskA) === "cancelled" &&
      taskStatus(taskB) === "cancelled" &&
      !!disconnectLog && disconnectLog.provider_message.includes("disconnected") &&
      settings.disconnected === true &&
      res.action.includes("sequence(s) cancelled");
    record("application.deauthorized: disconnected=1 + all tasks cancelled + disconnect log + /settings exposes flag", pass,
      pass ? "" : `disconnected=${disconnected} taskA=${taskStatus(taskA)} taskB=${taskStatus(taskB)} disconnectLog=${JSON.stringify(disconnectLog)} settings=${JSON.stringify(settings)} res=${JSON.stringify(res)}`);
  } catch (e: any) {
    record("application.deauthorized: disconnected + cancel all + settings flag", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // 3b. process endpoint auto-skips while disconnected
  // ────────────────────────────────────────────────────
  try {
    // A NEW overdue invoice while disconnected: the watcher still tracks it
    // (tracking is not blocked), but the pipeline must not auto-send.
    const wh = await fireOverdueWebhook("INV-D4", 3, 2000, "client-d4@example.com");
    const proc = await af(`/tasks/${wh.taskId}/process`, { method: "POST" });
    const body = await proc.json();

    const sent = body.task?.status === "sent";
    const skipped = (body.pipelineLog || []).some((l: string) => l.includes("SKIPPED"));
    const msgOk = (body.message || "").toLowerCase().includes("disconnected");
    const kept = body.task?.status === "reviewed";

    const pass = proc.status === 200 && !sent && kept && skipped && msgOk;
    record("process while disconnected: auto-send skipped, task kept (not sent)", pass,
      pass ? "" : `status=${proc.status} taskStatus=${body.task?.status} skipped=${skipped} msg="${body.message}"`);
  } catch (e: any) {
    record("process while disconnected: auto-send skipped", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // 4. payment-received notification (only when followed up, once)
  // ────────────────────────────────────────────────────
  try {
    // Followed up: had a sent reminder.
    const invP1 = seedInvoice("INV-P1", 10000, "Paying Client", "paying@example.com");
    seedTask(invP1, 1, "sent");
    const notifBefore = countNotificationLogs();

    const res1 = await fireWebhook("invoice.paid", { id: "INV-P1" });
    const msg1 = latestNotificationMessage();
    const notified = countNotificationLogs() === notifBefore + 1 && msg1.includes("Payment received — invoice INV-P1");

    // Replay — must not notify again.
    await fireWebhook("invoice.paid", { id: "INV-P1" });
    const once = countNotificationLogs() === notifBefore + 1;

    // Not followed up: no tasks ever → no notification.
    const invP2 = seedInvoice("INV-P2", 5000, "Silent Client", "silent@example.com");
    await fireWebhook("invoice.paid", { id: "INV-P2" });
    const silent = countNotificationLogs() === notifBefore + 1;

    const d = db();
    const p1Status = (d.query("SELECT status FROM invoices WHERE stripe_invoice_id='INV-P1'").get() as { status: string }).status;
    const p2Status = (d.query("SELECT status FROM invoices WHERE stripe_invoice_id='INV-P2'").get() as { status: string }).status;
    d.close();

    const pass = notified && once && silent && p1Status === "paid" && p2Status === "paid" && res1.action.includes("payment-received notification sent");
    record("invoice.paid: notifies only when followed up, and only once", pass,
      pass ? "" : `notified=${notified} once=${once} silent=${silent} p1=${p1Status} p2=${p2Status} msg="${msg1}"`);
  } catch (e: any) {
    record("invoice.paid: notify only when followed up, once", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // 5. escalation notification (stage 2/3 sends only)
  // ────────────────────────────────────────────────────
  try {
    // Reconnect the merchant (test 3 disconnected it) so automatic sends can
    // flow again — simulates a fresh account.application.updated/connect.
    const d = db();
    d.run("UPDATE merchants SET disconnected=0 WHERE id=?", [merchantId]);
    d.close();

    // Stage 2 send → notification.
    const wh2 = await fireOverdueWebhook("INV-S2", 10, 1200, "client-s2@example.com");
    const beforeS2 = countNotificationLogs();
    const proc2 = await af(`/tasks/${wh2.taskId}/process`, { method: "POST" });
    const body2 = await proc2.json();
    const msg2 = latestNotificationMessage();
    const s2Ok = body2.task?.status === "sent" && countNotificationLogs() === beforeS2 + 1 && msg2.includes("escalated to Stage 2");

    // Stage 3 send → notification.
    const wh3 = await fireOverdueWebhook("INV-S3", 25, 1300, "client-s3@example.com");
    const beforeS3 = countNotificationLogs();
    const proc3 = await af(`/tasks/${wh3.taskId}/process`, { method: "POST" });
    const body3 = await proc3.json();
    const msg3 = latestNotificationMessage();
    const s3Ok = body3.task?.status === "sent" && countNotificationLogs() === beforeS3 + 1 && msg3.includes("escalated to Stage 3");

    // Stage 1 send → NO notification.
    const wh1 = await fireOverdueWebhook("INV-S1", 3, 1100, "client-s1@example.com");
    const beforeS1 = countNotificationLogs();
    const proc1 = await af(`/tasks/${wh1.taskId}/process`, { method: "POST" });
    const body1 = await proc1.json();
    const s1Ok = body1.task?.status === "sent" && countNotificationLogs() === beforeS1;

    const pass = s2Ok && s3Ok && s1Ok;
    record("escalation: merchant notified on stage 2/3 send success, silent on stage 1", pass,
      pass ? "" : `s2=${JSON.stringify({status: body2.task?.status, msg: msg2})} s3=${JSON.stringify({status: body3.task?.status, msg: msg3})} s1=${JSON.stringify({status: body1.task?.status, countDelta: countNotificationLogs() - beforeS1})}`);
  } catch (e: any) {
    record("escalation: notify on stage 2/3, not stage 1", false, `Exception: ${e.message}`);
  }

  // ── Summary ──
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log("\n═══════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log(`  🎉 All ${results.length}/${results.length} notifications tests PASSED`);
  } else {
    console.log(`  ❌ ${failed} test(s) FAILED`);
    for (const r of results) if (!r.pass) console.log(`     ${r.name} — ${r.details}`);
  }
  console.log("═══════════════════════════════════════════════");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
