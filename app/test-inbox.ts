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

  // ── 6. Free merchant: sends within 5-draft allowance; 402 only when exhausted ──
  try {
    setSubscription(null); // merchant 1 becomes free
    // The allowance is DERIVED from drafted tasks (freeDraftsRemaining counts
    // reminder_tasks with a draft joined to the merchant's invoices), not from
    // the legacy merchants.drafts_used column — which is no longer written or
    // read. Prove the column is ignored by setting it to a bogus value: the
    // /stats counter and all gates must reflect the real drafted-task count,
    // and the column must stay untouched at 5.
    db().run("UPDATE merchants SET drafts_used=5 WHERE id=1");
    const draftedCount = (): number =>
      (db().query(
        "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=1 AND rt.draft_body != ''"
      ).get() as { n: number }).n;
    const freeDrafts = async (): Promise<number> => {
      const s = (await (await af("/stats")).json()) as any;
      return s.free_drafts_remaining;
    };
    // Seed extra drafted tasks directly so the derived count is deterministic
    // regardless of how many drafts earlier sequences left behind.
    let seedSeq = 0;
    const seedDraftedTask = (): void => {
      const sid = `seed_inbox_${seedSeq++}`;
      db().run(
        "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, amount_cents, due_date, status) VALUES (?, 1, 'Seed Client', 1000, datetime('now'), 'overdue')",
        [sid]
      );
      const inv = db().query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(sid) as { id: number };
      db().run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, 'reviewed', 'Seed', 'Seeded draft body')", [inv.id]);
    };
    // Force the derived count down to exactly n by clearing drafts off the
    // oldest drafted tasks (test-only DB manipulation — simulates allowance
    // freed up for a fresh draft).
    const setDraftedCount = (n: number): void => {
      let c = draftedCount();
      while (c > n) {
        const row = db().query(
          "SELECT rt.id AS tid FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=1 AND rt.draft_body != '' ORDER BY rt.id LIMIT 1"
        ).get() as { tid: number } | null;
        if (!row) break;
        db().run("UPDATE reminder_tasks SET draft_body='', draft_subject='', status='pending' WHERE id=?", [row.tid]);
        c = draftedCount();
      }
    };
    const before = draftedCount(); // drafted tasks left by earlier sequences
    // (a) Allowance remaining: webhook task arrives auto-drafted → approve →
    //     SENT without payment. The derived count rises at draft time (task
    //     creation), never at send (no double-count).
    const wh1 = await fireOverdueWebhook(`${INV_PREFIX}_fa`, 3);
    const approve1 = await af(`/tasks/${wh1.taskId}/approve`, { method: "POST" });
    const a1 = await approve1.json();
    const fdA = await freeDrafts();
    // (b) Legacy-task simulation (pre-#29 tasks arrive pending with no draft):
    //     with the allowance exhausted (derived count at 5), approve → 402
    //     subscription_required with the free-draft-allowance upgrade message.
    const wh2 = await fireOverdueWebhook(`${INV_PREFIX}_fb`, 2); // auto-drafts → +1
    db().run("UPDATE reminder_tasks SET status='pending', draft_body='', draft_subject='' WHERE id=?", [wh2.taskId]);
    while (draftedCount() < 5) seedDraftedTask(); // exhaust the derived allowance
    const approve2 = await af(`/tasks/${wh2.taskId}/approve`, { method: "POST" });
    const a2 = await approve2.json();
    // (c) Allowance exhausted → the watcher stops creating tasks entirely
    //     (6th invoice gets no task) — the natural cap of the sendable set.
    const wh3 = await fireOverdueWebhook(`${INV_PREFIX}_fc`, 4);
    // (d) Allowance remaining + pending task with no draft: approve drafts
    //     inline (consuming one allowance) and then sends.
    setDraftedCount(4); // free one allowance
    const wh4 = await fireOverdueWebhook(`${INV_PREFIX}_fd`, 2); // auto-drafts → 5
    db().run("UPDATE reminder_tasks SET status='pending', draft_body='', draft_subject='' WHERE id=?", [wh4.taskId]); // back to 4
    const approve4 = await af(`/tasks/${wh4.taskId}/approve`, { method: "POST" }); // inline draft → 5 → sent
    const a4 = await approve4.json();
    const fdD = await freeDrafts();
    // (e) Free merchant, Semi-Auto stage 1: the WATCHER auto-sends at webhook
    //     creation (PR #35) — no /process click is needed anymore. With one
    //     allowance freed, the webhook auto-drafts (derived count →5, allowance
    //     consumed at draft time) and auto-sends immediately; the derived count
    //     is NOT charged again at send time. /process on the already-sent task
    //     returns 400 (double-process guard) — itself proof the send happened
    //     at webhook time, before any manual step.
    setDraftedCount(4);
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "semi" }) });
    const wh5 = await fireOverdueWebhook(`${INV_PREFIX}_fe`, 3); // auto-drafts → 5 AND auto-sends (semi stage 1)
    const proc5 = await processTask(wh5.taskId); // 400: already sent by the watcher
    const hist5 = await getTaskList(true);
    const t5 = hist5.find((x: any) => x.id === wh5.taskId);
    const fdE = await freeDrafts();
    const column = db().query("SELECT drafts_used FROM merchants WHERE id=1").get() as { drafts_used: number };
    // (f) Full Auto stays Pro-gated for free merchants (Trust Mode gate intact).
    const fullAuto = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "full" }) });
    const pass =
      approve1.status === 200 && a1.sent === true && a1.task.status === "sent" && fdA === 5 - (before + 1) &&
      approve2.status === 402 && a2.error === "subscription_required" && a2.message.includes("free draft allowance") &&
      wh3.taskId === undefined &&
      approve4.status === 200 && a4.sent === true && a4.task.status === "sent" && fdD === 0 &&
      proc5.status === 400 && String(proc5.body?.error).includes("already processed") && proc5.body?.currentStatus === "sent" && t5?.status === "sent" && fdE === 0 &&
      column.drafts_used === 5 && // legacy column ignored: never written, never read
      fullAuto.status === 402;
    record("6. Free tier: sends within 5-draft allowance (approve + semi watcher auto-send), 402 only when exhausted, Full Auto gated", pass,
      pass ? "" : JSON.stringify({ approve1: approve1.status, a1: a1.sent, fdA, before, approve2: approve2.status, a2, wh3: wh3.taskId, approve4: approve4.status, a4: a4.sent, fdD, proc5: proc5.status, proc5Body: proc5.body, t5: t5?.status, fdE, column: column.drafts_used, fullAuto: fullAuto.status }));
  } catch (e: any) {
    record("6. Free tier sends within allowance; 402 when exhausted", false, `Exception: ${e.message}`);
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
      // Pause must NOT block the MANUAL weekly-summary route — only automatic
      // sends are paused. The test merchant is the acct_default placeholder
      // (no real email), so /summary/send legitimately SKIPS by design
      // (placeholder guard, PR #39 / 12cd747): what proves pause doesn't gate
      // it is that the route still runs to completion — 200 with a sendResult
      // whose only reason for not sending is the placeholder, never "paused".
      summary.status === 200 &&
      s.sendResult !== undefined &&
      (s.sendResult.success === true ||
        (s.sendResult.skipped === true && s.sendResult.message.includes("no real email")));

    record("7. paused blocks semi/full auto-send (task kept) but not manual approve/summary", pass,
      pass ? "" : JSON.stringify({ proc1Status: proc1.status, t1: t1?.status, msg1: proc1.body.message, skipLog: skipLog.n, proc2Status: proc2.status, t2: t2?.status, inInbox1, inInbox2, approveStatus: approve.status, approveTask: a.task?.status, summaryStatus: summary.status, summarySend: s.sendResult }));
  } catch (e: any) {
    record("7. paused blocks auto-send, not manual approve/summary", false, `Exception: ${e.message}`);
  }

  // ── 8. Unpause resumes auto-send (watcher sends at webhook creation) ──
  try {
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false, trust_mode: "semi" }) });
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_g`, 3); // semi stage 1 → watcher auto-sends at creation
    // The watcher (PR #35) sends semi stage 1 at webhook time — no /process
    // click is needed. /process on the already-sent task returns 400
    // (double-process guard), which is itself proof the send happened at
    // webhook time, before any manual step.
    const proc = await processTask(wh.taskId);
    const history = await getTaskList(true);
    const t = history.find((x: any) => x.id === wh.taskId);
    const pass =
      proc.status === 400 && String(proc.body?.error).includes("already processed") &&
      proc.body?.currentStatus === "sent" && t?.status === "sent";
    record("8. unpaused: semi stage 1 auto-sends at webhook creation (process 400 = already sent)", pass,
      pass ? "" : JSON.stringify({ status: proc.status, procBody: proc.body, taskStatus: t?.status }));
  } catch (e: any) {
    record("8. unpaused: semi stage 1 auto-sends at webhook creation", false, `Exception: ${e.message}`);
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
