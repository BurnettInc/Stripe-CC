/**
 * Full-Auto (Trust Mode) end-to-end test — webhook-driven auto-send.
 *
 * Verifies the watcher's server-side auto-send branch (added with the
 * full-auto fix): an invoice.overdue webhook alone — NO /process call, NO
 * merchant click — must produce a sent task when Trust Mode allows, and must
 * NOT send when it doesn't.
 *
 * Sequences:
 *  1. Full Auto (Pro): webhook → task auto-sent, no manual step. /process now
 *     400s (double-process guard).
 *  2. Draft mode: webhook → task stays 'reviewed', nothing sent.
 *  3. Semi-Auto stage 1: webhook → auto-sent.
 *  4. Semi-Auto stage 2: webhook → stays 'reviewed'.
 *  5. Replay guard: same overdue event fired twice → exactly ONE send for the
 *     invoice; the second task stays 'reviewed'.
 *  6. Tier gate: trust_mode 'full' WITHOUT active Pro → demoted to semi;
 *     stage 1 still auto-sends (semi behavior), stage 2 does not.
 *  7. Pause gate: full + paused → auto-send skipped, task stays 'reviewed'.
 *  8. Stale-event guards (run #4 gaps): a re-fired invoice.overdue after
 *     dispute / refund / paid creates NO new task; paid status is preserved;
 *     a replayed charge.refunded logs exactly ONE refund row.
 *     - 8a. overdue-after-dispute → no new task, dispute_id preserved
 *     - 8b. overdue-after-refund → no new task, refund_id preserved
 *     - 8c. overdue-after-paid → no new task AND invoice status stays 'paid'
 *     - 8d. refund replay → single send_logs refund row (idempotent)
 *  9. Weekly summary placeholder-stub fix: the placeholder merchant (1) must
 *     NOT be a summary send target — skipped, no weekly_summary send_logs row,
 *     no fake success, /stats summaryEmailsSent stays 0. A real merchant (2)
 *     still gets its summary through the normal path, and its stub send is
 *     never counted as a real send in /stats.
 *
 * Boot: DB_PATH=/tmp/cc-fullauto.db PORT=3100 env -u RESEND_API_KEY -u
 * SENDGRID_API_KEY -u OPENAI_API_KEY nohup bun run src/index.ts > /tmp/cc-fullauto-server.log 2>&1 &
 * Then: TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-fullauto.db bun run test-full-auto.ts
 */

import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-fullauto.db";
const SESSION = "fullauto-session";
const SESSION_REAL = "fullauto-session-real"; // merchant 2 (real email) session

function db(): Database {
  return new Database(DB_PATH);
}

function seedSessionAndPro(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now', '+30 days'))", [SESSION]);
  const existing = d.query("SELECT id FROM subscriptions WHERE merchant_id=1").get() as { id: number } | null;
  if (existing) {
    d.run("UPDATE subscriptions SET status='active', tier='pro' WHERE merchant_id=1");
  } else {
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (1, 'sub_fullauto', 'pro', 'active')");
  }
  d.close();
}

function setTrustMode(mode: "draft" | "semi" | "full"): Promise<boolean> {
  return fetch(`${BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: `session=${encodeURIComponent(SESSION)}` },
    body: JSON.stringify({ trust_mode: mode }),
  }).then((r) => r.ok);
}

function setPaused(paused: boolean): void {
  const d = db();
  d.run("UPDATE merchants SET paused=? WHERE id=1", [paused ? 1 : 0]);
  d.close();
}

function setSubscription(tier: "pro" | "standard" | null): void {
  const d = db();
  if (tier === null) {
    d.run("UPDATE subscriptions SET status='cancelled' WHERE merchant_id=1");
  } else {
    d.run("UPDATE subscriptions SET status='active', tier=? WHERE merchant_id=1", [tier]);
  }
  d.close();
}

function daysAgo(days: number): number {
  const t = new Date();
  t.setDate(t.getDate() - days);
  return Math.floor(t.getTime() / 1000);
}

async function fireOverdue(invId: string, days: number, amount = 12500): Promise<any> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      data: { object: { id: invId, customer_name: "Full Auto Client", customer_email: "client@example.com", amount_due: amount, currency: "usd", due_date: daysAgo(days) } },
    }),
  });
  return res.json();
}

/** Fire an arbitrary webhook event (dispute/refund/paid) at the local server. */
async function fireWebhook(type: string, object: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, data: { object } }),
  });
  return res.json();
}

function invoiceStatus(stripeInvoiceId: string): string {
  const d = db();
  const row = d.query("SELECT status FROM invoices WHERE stripe_invoice_id=?").get(stripeInvoiceId) as { status: string } | null;
  d.close();
  return row?.status ?? "missing";
}

function invoiceFlag(stripeInvoiceId: string, col: "dispute_id" | "refund_id"): string | null {
  const d = db();
  const row = d.query(`SELECT ${col} AS v FROM invoices WHERE stripe_invoice_id=?`).get(stripeInvoiceId) as { v: string | null } | null;
  d.close();
  return row?.v ?? null;
}

function taskCountForInvoice(stripeInvoiceId: string): number {
  const d = db();
  const row = d.query(
    `SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.stripe_invoice_id=?`
  ).get(stripeInvoiceId) as { n: number };
  d.close();
  return row.n;
}

function refundLogCount(stripeInvoiceId: string): number {
  const d = db();
  const row = d.query(
    `SELECT COUNT(*) AS n FROM send_logs WHERE type='refund' AND instr(provider_message, ?) > 0`
  ).get(stripeInvoiceId) as { n: number };
  d.close();
  return row.n;
}

async function getTask(taskId: number): Promise<any> {
  const res = await fetch(`${BASE}/tasks?status=all`, { headers: { Cookie: `session=${encodeURIComponent(SESSION)}` } });
  const tasks = await res.json();
  return tasks.find((t: any) => t.id === taskId);
}

async function processTask(taskId: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/tasks/${taskId}/process`, {
    method: "POST",
    headers: { Cookie: `session=${encodeURIComponent(SESSION)}` },
  });
  return { status: res.status, body: await res.json() };
}

function sendLogCount(invoiceId: number): number {
  const d = db();
  const row = d.query(
    `SELECT COUNT(*) AS n FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id=rt.id
     WHERE rt.invoice_id=? AND sl.status='success' AND sl.provider_message NOT LIKE '%[STUB SEND]%'`
  ).get(invoiceId) as { n: number };
  d.close();
  return row.n;
}

/** Count weekly_summary rows in send_logs (any status). */
function weeklySummaryRowCount(): number {
  const d = db();
  const row = d.query(`SELECT COUNT(*) AS n FROM send_logs WHERE type='weekly_summary'`).get() as { n: number };
  d.close();
  return row.n;
}

/**
 * Seed a SECOND merchant (id 2) with a real, non-placeholder email plus a
 * session and an active Pro subscription, so the weekly-summary path has a
 * genuine send target to prove the job still runs for real merchants.
 */
function seedRealMerchant(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (2, 'acct_summary_real', 'real@example.com', 'draft')"
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 2, datetime('now', '+30 days'))", [SESSION_REAL]);
  const existing = d.query("SELECT id FROM subscriptions WHERE merchant_id=2").get() as { id: number } | null;
  if (existing) {
    d.run("UPDATE subscriptions SET status='active', tier='pro' WHERE merchant_id=2");
  } else {
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (2, 'sub_summary_real', 'pro', 'active')");
  }
  d.close();
}

/** POST /summary/send with the given session cookie. */
async function postSummarySend(session: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/summary/send`, {
    method: "POST",
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
  });
  return { status: res.status, body: await res.json() };
}

/** GET /stats with the given session cookie. */
async function getStats(session: string): Promise<any> {
  const res = await fetch(`${BASE}/stats`, { headers: { Cookie: `session=${encodeURIComponent(session)}` } });
  return res.json();
}

let passed = 0;
let failed = 0;
function record(name: string, pass: boolean, details = "") {
  if (pass) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}: ${details}`); }
}

async function main() {
  seedSessionAndPro();
  const PREFIX = `fullauto_${Date.now()}`;

  // ── 1. Full Auto: webhook alone auto-sends ──
  await setTrustMode("full");
  const inv1 = `${PREFIX}_seq1`;
  const wh1 = await fireOverdue(inv1, 3); // stage 1
  const t1 = await getTask(wh1.taskId);
  const proc1 = await processTask(wh1.taskId);
  record("1. Full Auto auto-sends at webhook (no manual step)", !!t1 && t1.status === "sent" && t1.sent_at !== null && t1.stage === 1,
    JSON.stringify({ task: t1 && { status: t1.status, stage: t1.stage, sent_at: t1.sent_at }, proc: { status: proc1.status, err: proc1.body.error } }));
  record("1b. Double-process guard: /process on auto-sent task → 400", proc1.status === 400 && String(proc1.body.error).includes("already processed") && proc1.body.currentStatus === "sent",
    JSON.stringify(proc1.body));

  // ── 2. Draft mode: nothing sends ──
  await setTrustMode("draft");
  const inv2 = `${PREFIX}_seq2`;
  const wh2 = await fireOverdue(inv2, 3);
  const t2 = await getTask(wh2.taskId);
  record("2. Draft mode: task stays reviewed, NOT sent", !!t2 && t2.status === "reviewed" && t2.sent_at === null,
    JSON.stringify(t2 && { status: t2.status, sent_at: t2.sent_at }));

  // ── 3. Semi-Auto stage 1: auto-sends ──
  await setTrustMode("semi");
  const inv3 = `${PREFIX}_seq3`;
  const wh3 = await fireOverdue(inv3, 3); // stage 1
  const t3 = await getTask(wh3.taskId);
  record("3. Semi-Auto stage 1 auto-sends at webhook", !!t3 && t3.status === "sent" && t3.sent_at !== null,
    JSON.stringify(t3 && { status: t3.status, stage: t3.stage, sent_at: t3.sent_at }));

  // ── 4. Semi-Auto stage 2: stays reviewed ──
  await setTrustMode("semi");
  const inv4 = `${PREFIX}_seq4`;
  const wh4 = await fireOverdue(inv4, 10); // stage 2
  const t4 = await getTask(wh4.taskId);
  record("4. Semi-Auto stage 2: NOT auto-sent, stays reviewed", !!t4 && t4.status === "reviewed" && t4.sent_at === null,
    JSON.stringify(t4 && { status: t4.status, stage: t4.stage }));

  // ── 5. Replay guard: duplicate overdue event → exactly one send ──
  await setTrustMode("full");
  const inv5 = `${PREFIX}_seq5`;
  const wh5a = await fireOverdue(inv5, 3);
  const t5a = await getTask(wh5a.taskId); // should be sent
  const wh5b = await fireOverdue(inv5, 3); // replay: cancels old, creates new task
  const t5b = await getTask(wh5b.taskId); // should stay reviewed (replay guard)
  record("5. Replay guard: duplicate webhook → no second send", t5a?.status === "sent" && t5b?.status === "reviewed" && t5b?.sent_at === null,
    JSON.stringify({ first: t5a && { status: t5a.status }, second: t5b && { status: t5b.status, sent_at: t5b.sent_at } }));

  // ── 6. Tier gate: 'full' without active Pro is demoted to semi ──
  // Use an ACTIVE STANDARD sub (a Pro who downgraded): hasActiveSubscription
  // stays true so the watcher still creates tasks, but isActiveProSubscriber
  // is false → stored 'full' must degrade to 'semi' (stage 1 sends, stage 2+ waits).
  setSubscription("standard");
  await setTrustMode("full"); // stored as full (normally gated, but simulate stale row)
  const inv6 = `${PREFIX}_seq6a`;
  const wh6a = await fireOverdue(inv6, 3); // stage 1 → semi behavior sends
  const t6a = await getTask(wh6a.taskId);
  const inv6b = `${PREFIX}_seq6b`;
  const wh6b = await fireOverdue(inv6b, 10); // stage 2 → semi behavior does NOT send
  const t6b = await getTask(wh6b.taskId);
  record("6. Tier gate: stale 'full' w/o Pro → stage1 sends (semi), stage2 does not",
    t6a?.status === "sent" && t6b?.status === "reviewed",
    JSON.stringify({ stage1: t6a && { status: t6a.status }, stage2: t6b && { status: t6b.status } }));
  // restore Pro for seq 7
  seedSessionAndPro();

  // ── 7. Pause gate: full + paused → skip, task stays reviewed ──
  await setTrustMode("full");
  setPaused(true);
  const inv7 = `${PREFIX}_seq7`;
  const wh7 = await fireOverdue(inv7, 3);
  const t7 = await getTask(wh7.taskId);
  setPaused(false);
  record("7. Pause gate: full + paused → auto-send skipped, task reviewed", !!t7 && t7.status === "reviewed" && t7.sent_at === null,
    JSON.stringify(t7 && { status: t7.status, sent_at: t7.sent_at }));

  // ── 8. Stale-event guards: re-fired overdue after dispute/refund/paid ──
  await setTrustMode("full");

  // 8a. overdue-after-dispute → no new task, dispute marker preserved
  const inv8d = `${PREFIX}_seq8_dispute`;
  await fireOverdue(inv8d, 3, 13300);
  const dRes = await fireWebhook("charge.dispute.created", { id: "dp_fullauto_8", charge: "ch_fullauto_8", amount: 13300 });
  const dTasksBefore = taskCountForInvoice(inv8d);
  const dOv = await fireOverdue(inv8d, 3, 13300); // stale re-fire
  const dTasksAfter = taskCountForInvoice(inv8d);
  record("8a. Overdue-after-dispute: no new task, dispute_id preserved",
    String(dRes.action).includes("paused reminders") && dTasksAfter === dTasksBefore && invoiceFlag(inv8d, "dispute_id") === "dp_fullauto_8",
    JSON.stringify({ dRes, dOv, dTasksBefore, dTasksAfter, disputeId: invoiceFlag(inv8d, "dispute_id") }));

  // 8b. overdue-after-refund → no new task, refund marker preserved
  const inv8r = `${PREFIX}_seq8_refund`;
  await fireOverdue(inv8r, 3, 13400);
  const rRes = await fireWebhook("charge.refunded", { id: "re_fullauto_8", charge: "ch_fullauto_8r", amount: 13400, status: "succeeded" });
  const rTasksBefore = taskCountForInvoice(inv8r);
  const rOv = await fireOverdue(inv8r, 3, 13400); // stale re-fire
  const rTasksAfter = taskCountForInvoice(inv8r);
  record("8b. Overdue-after-refund: no new task, refund_id preserved",
    String(rRes.action).includes("stopped reminders") && rTasksAfter === rTasksBefore && invoiceFlag(inv8r, "refund_id") === "re_fullauto_8",
    JSON.stringify({ rRes, rOv, rTasksBefore, rTasksAfter, refundId: invoiceFlag(inv8r, "refund_id") }));

  // 8c. overdue-after-paid → no new task AND status stays 'paid'
  const inv8p = `${PREFIX}_seq8_paid`;
  await fireOverdue(inv8p, 3, 13500);
  const pRes = await fireWebhook("invoice.paid", { id: inv8p });
  const pTasksBefore = taskCountForInvoice(inv8p);
  const pStatusAfterPaid = invoiceStatus(inv8p);
  const pOv = await fireOverdue(inv8p, 3, 13500); // stale re-fire
  const pTasksAfter = taskCountForInvoice(inv8p);
  const pStatusAfterReplay = invoiceStatus(inv8p);
  record("8c. Overdue-after-paid: no new task, invoice status stays 'paid'",
    pStatusAfterPaid === "paid" && pStatusAfterReplay === "paid" && pTasksAfter === pTasksBefore,
    JSON.stringify({ pRes, pOv, pStatusAfterPaid, pStatusAfterReplay, pTasksBefore, pTasksAfter }));

  // 8d. refund replay → exactly one refund send_logs row (idempotent)
  const inv8l = `${PREFIX}_seq8_log`;
  await fireOverdue(inv8l, 3, 13600);
  const reId = "re_fullauto_8log";
  const lFirst = await fireWebhook("charge.refunded", { id: reId, charge: "ch_fullauto_8log", amount: 13600, status: "succeeded" });
  const logsAfterFirst = refundLogCount(inv8l);
  const lReplay = await fireWebhook("charge.refunded", { id: reId, charge: "ch_fullauto_8log", amount: 13600, status: "succeeded" });
  const logsAfterReplay = refundLogCount(inv8l);
  record("8d. Refund replay: single refund log row (idempotent)",
    String(lFirst.action).includes("stopped reminders") && logsAfterFirst === 1 && logsAfterReplay === 1 && String(lReplay.action).includes("idempotent"),
    JSON.stringify({ lFirst, lReplay, logsAfterFirst, logsAfterReplay }));

  // ── 9. Weekly summary: placeholder merchants are NOT send targets ──
  // The seeded placeholder (merchant 1, acct_default / default@collections-copilot.local)
  // must never produce a fake "sent" summary: no weekly_summary send_logs row,
  // no success claim, stats count stays 0. A real merchant still gets its
  // summary through the normal path.
  await setTrustMode("full");
  const summariesBefore = weeklySummaryRowCount();
  const phSummary = await postSummarySend(SESSION);
  const phStats = await getStats(SESSION);
  const summariesAfterPlaceholder = weeklySummaryRowCount();
  record("9a. Placeholder merchant: weekly summary skipped — no send_logs row, no fake success, stats 0",
    phSummary.status === 200 &&
      phSummary.body.skipped === true &&
      phSummary.body.sendResult && phSummary.body.sendResult.success === false &&
      phSummary.body.sendResult.skipped === true &&
      phStats.summaryEmailsSent === 0 &&
      summariesAfterPlaceholder === summariesBefore,
    JSON.stringify({ phSummary, phStats, summariesBefore, summariesAfterPlaceholder }));
  // 9b. Real merchant: summary still sent (stub path logs success in test env),
  // and the stub is never counted as a real send in /stats.
  seedRealMerchant();
  const realSummary = await postSummarySend(SESSION_REAL);
  const realStats = await getStats(SESSION_REAL);
  const summariesAfterReal = weeklySummaryRowCount();
  record("9b. Real merchant: weekly summary still sent; stub not counted in stats",
    realSummary.status === 200 &&
      realSummary.body.skipped === undefined &&
      realSummary.body.sendResult && realSummary.body.sendResult.success === true &&
      summariesAfterReal === summariesBefore + 1 &&
      realStats.summaryEmailsSent === 0,
    JSON.stringify({ realSummary, realStats, summariesBefore, summariesAfterReal }));
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
