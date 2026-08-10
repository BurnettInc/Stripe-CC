/**
 * Task inbox + pause endpoint tests (new dashboard controls).
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100).
 * The server must share the SQLite DB this script seeds (TEST_DB_PATH,
 * default app/app.db) so the test can create the session + subscription
 * the HTTP calls depend on — sessions have no public creation endpoint.
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-test.db bun run test-inbox.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const SESSION = "test-inbox-session";

// ── helpers ──

function db(): Database {
  // NOTE: Bun 1.3.x throws SQLITE_MISUSE when the options object contains
  // `create: false` — use the default constructor (create: true is harmless,
  // the file already exists because the server created it).
  return new Database(DB_PATH);
}

function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now', '+30 days'))", [SESSION]);
  d.close();
}

function setSubscription(tier: "standard" | "pro" | null): void {
  const d = db();
  const existing = d.query("SELECT id FROM subscriptions WHERE merchant_id=1").get() as { id: number } | null;
  if (existing) {
    if (tier === null) {
      d.run("UPDATE subscriptions SET status='cancelled' WHERE merchant_id=1");
    } else {
      d.run("UPDATE subscriptions SET status='active', tier=? WHERE merchant_id=1", [tier]);
    }
  } else if (tier !== null) {
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (1, 'sub_test_inbox', ?, 'active')", [tier]);
  }
  d.close();
}

function af(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Cookie", `session=${encodeURIComponent(SESSION)}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}

function daysAgoTimestamp(days: number): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return Math.floor(d.getTime() / 1000);
}

async function fireOverdueWebhook(invoiceId: string, daysAgo: number): Promise<{ action: string; invoiceId: number; taskId: number }> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      data: {
        object: {
          id: invoiceId,
          customer_name: "Test Client",
          customer_email: "client@example.com",
          amount_due: 5000,
          currency: "usd",
          due_date: daysAgoTimestamp(daysAgo),
        },
      },
    }),
  });
  return res.json();
}

async function processTask(taskId: number): Promise<{ status: number; body: any }> {
  const res = await af(`/tasks/${taskId}/process`, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

async function getTaskList(includeAll = false): Promise<any[]> {
  const res = await af(`/tasks${includeAll ? "?status=all" : ""}`);
  return res.json();
}

const results: { name: string; pass: boolean; details: string }[] = [];
function record(name: string, pass: boolean, details = "") {
  results.push({ name, pass, details });
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass && details) console.log(`   FAIL: ${details}`);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${BASE} did not become healthy`);
}

// ── tests ──

const INV_PREFIX = `inbox_test_${Date.now()}`;

async function run() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Task Inbox + Pause — endpoint tests");
  console.log(`  BASE=${BASE} DB=${DB_PATH}`);
  console.log("═══════════════════════════════════════════════\n");

  await waitForServer();
  seedSession();
  setSubscription("pro");

  // ── 1. Settings: paused round-trip + combined update ──
  try {
    const get1 = await af("/settings");
    const s1 = await get1.json();
    const get2res = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true }) });
    const s2 = await get2res.json();
    const get3res = await af("/settings");
    const s3 = await get3res.json();
    const putCombined = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "semi", paused: true }) });
    const sCombined = await putCombined.json();
    const getCombined = await af("/settings");
    const sCombinedGet = await getCombined.json();
    const badPaused = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: "yes" }) });
    const empty = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });

    const pass =
      s1.paused === false &&
      s2.paused === true && s3.paused === true &&
      sCombined.trust_mode === "semi" && sCombined.paused === true &&
      sCombinedGet.trust_mode === "semi" && sCombinedGet.paused === true &&
      badPaused.status === 400 && empty.status === 400;
    record("1. paused round-trips through GET/PUT /settings (+ combined update)", pass,
      pass ? "" : JSON.stringify({ s1, s2, s3, sCombined, badPaused: badPaused.status, empty: empty.status }));
  } catch (e: any) {
    record("1. paused round-trips through GET/PUT /settings (+ combined update)", false, `Exception: ${e.message}`);
  }

  // ── 2. GET /tasks inbox shape (draft mode) ──
  let reviewedTaskId = 0;
  try {
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "draft" }) });
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_a`, 3);
    const proc = await processTask(wh.taskId);
    const t = proc.body.task;
    reviewedTaskId = t.id;

    const inbox = await getTaskList();
    const task = inbox.find((x: any) => x.id === t.id);

    const pass =
      proc.status === 200 && t.status === "reviewed" && t.draft_body && t.draft_body.length > 0 &&
      task &&
      task.awaiting_approval === true &&
      typeof task.draft_subject === "string" && task.draft_subject.length > 0 &&
      task.stage === 1 && task.status === "reviewed" &&
      task.customer_name === "Test Client" &&
      task.customer_email === "client@example.com" &&
      task.amount_cents === 5000 && task.currency === "usd" &&
      typeof task.due_date === "string" && task.due_date.length > 0 &&
      typeof task.days_overdue === "number" && task.days_overdue >= 3 &&
      typeof task.created_at === "string";

    record("2. GET /tasks returns inbox shape (draft, facts, awaiting_approval, days_overdue)", pass,
      pass ? "" : `task=${JSON.stringify(task)} procStatus=${proc.status} tStatus=${t.status}`);
  } catch (e: any) {
    record("2. GET /tasks returns inbox shape", false, `Exception: ${e.message}`);
  }

  // ── 3. Approve sends; double-approve/reject-on-sent → 409 ──
  try {
    const approve = await af(`/tasks/${reviewedTaskId}/approve`, { method: "POST" });
    const a = await approve.json();

    const inboxAfter = await getTaskList();
    const historyAfter = await getTaskList(true);
    const inInbox = inboxAfter.some((x: any) => x.id === reviewedTaskId);
    const inHistory = historyAfter.find((x: any) => x.id === reviewedTaskId);

    const double = await af(`/tasks/${reviewedTaskId}/approve`, { method: "POST" });
    const rejectSent = await af(`/tasks/${reviewedTaskId}/reject`, { method: "POST" });

    const pass =
      approve.status === 200 && a.sent === true && a.sendResult?.success === true && a.task.status === "sent" &&
      !inInbox && inHistory && inHistory.status === "sent" &&
      double.status === 409 &&
      rejectSent.status === 409;

    record("3. approve sends; double-approve 409; reject-on-sent 409; sent excluded from inbox", pass,
      pass ? "" : JSON.stringify({ approveStatus: approve.status, a, inInbox, inHistoryStatus: inHistory?.status, double: double.status, rejectSent: rejectSent.status }));
  } catch (e: any) {
    record("3. approve sends; double-approve 409; reject-on-sent 409", false, `Exception: ${e.message}`);
  }

  // ── 4. Reject cancels; approve-on-cancelled → 409 ──
  let rejectedTaskId = 0;
  try {
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_b`, 10);
    await processTask(wh.taskId);
    rejectedTaskId = wh.taskId;

    const reject = await af(`/tasks/${wh.taskId}/reject`, { method: "POST" });
    const r = await reject.json();
    const history = await getTaskList(true);
    const t = history.find((x: any) => x.id === wh.taskId);
    const approveCancelled = await af(`/tasks/${wh.taskId}/approve`, { method: "POST" });

    const d = db();
    const log = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='skipped' AND provider_message LIKE '%rejected%'").get(wh.taskId) as { n: number };
    d.close();

    const pass =
      reject.status === 200 && r.status === "cancelled" && t?.status === "cancelled" &&
      approveCancelled.status === 409 && log.n >= 1;

    record("4. reject cancels + logs; approve-on-cancelled 409", pass,
      pass ? "" : JSON.stringify({ rejectStatus: reject.status, r, historyStatus: t?.status, approveCancelled: approveCancelled.status, logCount: log.n }));
  } catch (e: any) {
    record("4. reject cancels + logs; approve-on-cancelled 409", false, `Exception: ${e.message}`);
  }

  // ── 5. PUT /tasks/:id/draft replaces body, validates, edited body is sent ──
  try {
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_c`, 5);
    await processTask(wh.taskId);
    const invId = wh.invoiceId;
    const invoiceRow = db().query("SELECT stripe_invoice_id, amount_cents, due_date FROM invoices WHERE id=?").get(invId) as { stripe_invoice_id: string; amount_cents: number; due_date: string };

    const editedBody =
      `Hi there — this is my hand-edited reminder for invoice #${invoiceRow.stripe_invoice_id} ` +
      `for $${(invoiceRow.amount_cents / 100).toFixed(2)} due ${invoiceRow.due_date}. ` +
      `Please pay at https://dashboard.stripe.com/invoices/${invoiceRow.stripe_invoice_id} — thanks!`;

    const put = await af(`/tasks/${wh.taskId}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_body: editedBody, draft_subject: "Edited subject" }),
    });
    const p = await put.json();

    const emptyBody = await af(`/tasks/${wh.taskId}/draft`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_body: "   " }),
    });
    const tooLong = await af(`/tasks/${wh.taskId}/draft`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_body: "x".repeat(10001) }),
    });

    // inbox should now show the edited draft awaiting approval
    const inbox = await getTaskList();
    const inInbox = inbox.find((x: any) => x.id === wh.taskId);

    // approve → the EDITED body is what goes out
    const approve = await af(`/tasks/${wh.taskId}/approve`, { method: "POST" });
    const a = await approve.json();
    const history = await getTaskList(true);
    const sent = history.find((x: any) => x.id === wh.taskId);

    const pass =
      put.status === 200 && p.task.status === "reviewed" && p.task.draft_body === editedBody &&
      p.task.draft_subject === "Edited subject" &&
      emptyBody.status === 400 && tooLong.status === 400 &&
      inInbox && inInbox.draft_body === editedBody &&
      approve.status === 200 && a.task.status === "sent" &&
      sent && sent.draft_body === editedBody;

    record("5. PUT draft updates body → approve sends edited body; validation 400s", pass,
      pass ? "" : JSON.stringify({ putStatus: put.status, pStatus: p.task?.status, bodyMatches: p.task?.draft_body === editedBody, emptyBody: emptyBody.status, tooLong: tooLong.status, approveStatus: approve.status, sentBodyMatches: sent?.draft_body === editedBody }));
  } catch (e: any) {
    record("5. PUT draft updates body → approve sends edited body", false, `Exception: ${e.message}`);
  }

  // ── 6. Free merchant: approve → 402 ──
  try {
    setSubscription(null); // merchant 1 becomes free
    // Reset the freemium draft counter so the free-tier gates (watcher task
    // creation, /process draft step) don't interfere with this test — the
    // subscription gate on /approve is what's under test here.
    const d = db();
    d.run("UPDATE merchants SET drafts_used=0 WHERE id=1");
    d.close();
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_d`, 2);
    const proc = await processTask(wh.taskId); // free: drafts remaining -> drafts + reviews
    const approve = await af(`/tasks/${wh.taskId}/approve`, { method: "POST" });
    const a = await approve.json();
    const fullAuto = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "full" }) });

    const pass =
      proc.status === 200 && proc.body.task.status === "reviewed" &&
      approve.status === 402 && a.error === "subscription_required" &&
      fullAuto.status === 402;

    record("6. Free tier: approve 402 (upgrade prompt), Full Auto gate intact", pass,
      pass ? "" : JSON.stringify({ procStatus: proc.status, approveStatus: approve.status, a, fullAuto: fullAuto.status }));
  } catch (e: any) {
    record("6. Free tier: approve 402, Full Auto gate intact", false, `Exception: ${e.message}`);
  }

  // ── 7. Paused: blocks auto-send (semi stage 1 + full), not manual approve/summary ──
  let pausedAutoTaskId = 0;
  let fullAutoPausedTaskId = 0;
  try {
    setSubscription("pro");
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true, trust_mode: "semi" }) });

    // Semi-Auto stage 1 while paused → draft+review, no send
    const wh1 = await fireOverdueWebhook(`${INV_PREFIX}_e`, 3);
    pausedAutoTaskId = wh1.taskId;
    const proc1 = await processTask(wh1.taskId);
    const t1 = proc1.body.task;

    const d = db();
    const skipLog = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='skipped' AND provider_message LIKE '%collections paused%'").get(wh1.taskId) as { n: number };
    d.close();

    // Full Auto while paused → also no send
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "full" }) });
    const wh2 = await fireOverdueWebhook(`${INV_PREFIX}_f`, 4);
    fullAutoPausedTaskId = wh2.taskId;
    const proc2 = await processTask(wh2.taskId);
    const t2 = proc2.body.task;

    // Task stays in the inbox (not cancelled) while paused
    const inbox = await getTaskList();
    const inInbox1 = inbox.some((x: any) => x.id === wh1.taskId);
    const inInbox2 = inbox.some((x: any) => x.id === wh2.taskId);

    // Manual approve still works while paused
    const approve = await af(`/tasks/${wh1.taskId}/approve`, { method: "POST" });
    const a = await approve.json();

    // Manual weekly summary still works while paused
    const summary = await af("/summary/send", { method: "POST" });
    const s = await summary.json();

    const pass =
      proc1.status === 200 && t1.status === "reviewed" && proc1.body.message.includes("paused") &&
      skipLog.n >= 1 &&
      proc2.status === 200 && t2.status === "reviewed" && proc2.body.message.includes("paused") &&
      inInbox1 && inInbox2 &&
      approve.status === 200 && a.task.status === "sent" &&
      summary.status === 200 && s.sendResult?.success === true;

    record("7. paused blocks semi/full auto-send (task kept) but not manual approve/summary", pass,
      pass ? "" : JSON.stringify({ proc1Status: proc1.status, t1: t1?.status, msg1: proc1.body.message, skipLog: skipLog.n, proc2Status: proc2.status, t2: t2?.status, inInbox1, inInbox2, approveStatus: approve.status, approveTask: a.task?.status, summaryStatus: summary.status, summarySend: s.sendResult }));
  } catch (e: any) {
    record("7. paused blocks auto-send, not manual approve/summary", false, `Exception: ${e.message}`);
  }

  // ── 8. Unpause resumes auto-send ──
  try {
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false, trust_mode: "semi" }) });
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_g`, 3); // stage 1 semi → auto-send
    const proc = await processTask(wh.taskId);
    const t = proc.body.task;
    const pass = proc.status === 200 && t.status === "sent";
    record("8. unpaused: semi stage 1 auto-sends again", pass, pass ? "" : JSON.stringify({ status: proc.status, taskStatus: t?.status, msg: proc.body.message }));
  } catch (e: any) {
    record("8. unpaused: semi stage 1 auto-sends again", false, `Exception: ${e.message}`);
  }

  // ── cleanup ──
  await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false, trust_mode: "draft" }) }).catch(() => {});
  setSubscription("pro");

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n═══════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
