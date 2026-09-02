/**
 * Free Draft Mode — unlimited and free forever (owner decision 9/2) tests.
 *
 * The dashboard's "Free Drafts" stat card (GET /stats → free_drafts_remaining)
 * now reports a large sentinel for EVERY merchant, and free_drafts_unlimited
 * is always true, so the card renders "Unlimited" for free merchants, trial
 * merchants and paid merchants alike. The legacy merchants.drafts_used column
 * is never written or read. SENDING remains the paid unlock, gated at
 * /approve, /process and the watcher's auto-send: a non-subscriber (outside
 * the full-access free trial) can draft unlimited reminders but every send
 * attempt returns 402 subscription_required.
 *
 * This suite proves that:
 *   - free_drafts_remaining is a huge sentinel / unlimited for everyone (no
 *     countdown at any draft count, drafts_used ignored entirely)
 *   - a non-subscriber can draft PAST the old 5-draft cap without 402 (a
 *     pending task drafted via /process/like-the-branch, and webhook tasks
 *     still created at any draft count), but every SEND attempt (approve +
 *     watcher semi auto-send) is 402-blocked at the send step
 *   - a trial merchant (full access) can draft AND send normally
 *   - active Standard/Pro subscribers keep free_drafts_unlimited=true
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default app/app.db). Run via:
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-free-drafts.db bun run test-free-drafts.ts
 *
 * (or /tmp/run-suite.sh free-drafts, which boots an isolated server with a
 * fresh DB and stripped email-provider keys).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const SESSION = "test-free-drafts-session";
const MERCHANT = 2; // dedicated non-subscriber merchant (out of trial, no sub rows)
const TRIAL_MERCHANT = 3; // dedicated merchant inside the 30-day full-access free trial
const SESSION_TRIAL = "test-free-drafts-session-trial";
function db(): Database {
  // NOTE: Bun 1.3.x throws SQLITE_MISUSE when the options object contains
  // `create: false` — use the default constructor (create: true is harmless,
  // the file already exists because the server created it).
  return new Database(DB_PATH);
}
function seedMerchant(id: number, acct: string, email: string, session: string, createdSql: string): void {
  const d = db();
  d.run(
    `INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, drafts_used, created_at)
     VALUES (?, ?, ?, 'draft', 0, ${createdSql})`,
    [id, acct, email]
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [session, id]);
  d.close();
}
function seedInvoice(sid: string, merchantId: number): number {
  const d = db();
  d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, 'Derived Client', 'client@example.com', 2500, 'usd', datetime('now', '-10 days'), 'overdue')",
    [sid, merchantId]
  );
  const inv = d.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(sid) as { id: number };
  d.close();
  return inv.id;
}
function insertTask(stripeInvoiceId: string, merchantId: number, status: string, draftBody: string): number {
  const d = db();
  const inv = seedInvoice(stripeInvoiceId, merchantId);
  const r = d.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Derived', ?)",
    [inv, status, draftBody]
  );
  d.close();
  return Number(r.lastInsertRowid);
}
/** Seed a PENDING task (no draft yest) for the /process-draft path. */
function seedPendingTask(stripeInvoiceId: string, merchantId: number): number {
  const d = db();
  const inv = seedInvoice(stripeInvoiceId, merchantId);
  const r = d.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, 'pending', '', '')",
    [inv]
  );
  d.close();
  return Number(r.lastInsertRowid);
}
function draftsUsedColumn(merchantId: number): number {
  const d = db();
  const row = d.query("SELECT drafts_used FROM merchants WHERE id=?").get(merchantId) as { drafts_used: number };
  d.close();
  return row.drafts_used;
}
async function af(path: string, opts: RequestInit = {}, session = SESSION): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Cookie", `session=${encodeURIComponent(session)}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}
async function statsJson(session = SESSION): Promise<{
  free_drafts_remaining: number;
  free_drafts_unlimited: boolean;
  stripeConnected: boolean;
  stripeDisconnected: boolean;
  stripeAccountId: string | null;
  free_trial: boolean;
}> {
  const res = await af("/stats", {}, session);
  if (res.status !== 200) throw new Error(`GET /stats returned ${res.status}`);
  return (await res.json()) as {
    free_drafts_remaining: number;
    free_drafts_unlimited: boolean;
    stripeConnected: boolean;
    stripeDisconnected: boolean;
    stripeAccountId: string | null;
    free_trial: boolean;
  };
}
const SENTINEL = Number.MAX_SAFE_INTEGER;
const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
async function run(): Promise<void> {
  seedMerchant(MERCHANT, "acct_free_drafts", "free@example.com", SESSION, "datetime('now', '-40 days')"); // out of trial, no sub
  seedMerchant(TRIAL_MERCHANT, "acct_free_drafts_trial", "trial@example.com", SESSION_TRIAL, "datetime('now', '-10 days')"); // in trial
  db().run("DELETE FROM subscriptions WHERE merchant_id IN (?, ?)", [MERCHANT, TRIAL_MERCHANT]);
  // ── 1..6. free_drafts_remaining is UNLIMITED for a free merchant, no matter
  //          how many drafts exist; drafts_used is never read.
  insertTask("fd_001", MERCHANT, "reviewed", "Draft one");
  const s1 = await statsJson();
  record("1. free merchant with 1 drafted task → free_drafts_remaining sentinel (unlimited), free_drafts_unlimited=true",
    s1.free_drafts_remaining === SENTINEL && s1.free_drafts_unlimited === true,
    `remaining=${s1.free_drafts_remaining} unlimited=${s1.free_drafts_unlimited}`);
  // 2. pending task with no draft still doesn't change anything (no countdown exists).
  insertTask("fd_002", MERCHANT, "pending", "");
  const s2 = await statsJson();
  record("2. pending task with no draft → still unlimited (no countdown)",
    s2.free_drafts_remaining === SENTINEL && s2.free_drafts_unlimited === true,
    `remaining=${s2.free_drafts_remaining}`);
  // 3. six drafted tasks (PAST the old 5-draft cap) → still unlimited.
  for (let i = 0; i < 5; i++) insertTask(`fd_pastcap_${i}`, MERCHANT, "sent", `Draft past cap ${i}`);
  const s3 = await statsJson();
  record("3. 6+ drafted tasks (past old 5-cap) → still unlimited for a free merchant",
    s3.free_drafts_remaining === SENTINEL && s3.free_drafts_unlimited === true,
    `remaining=${s3.free_drafts_remaining}`);
  // 4. the drafts_used column is ignored entirely (set to 5 → unchanged).
  db().run("UPDATE merchants SET drafts_used=5 WHERE id=?", [MERCHANT]);
  const s4 = await statsJson();
  record("4. drafts_used column ignored (set to 5) → still unlimited",
    s4.free_drafts_remaining === SENTINEL && s4.free_drafts_unlimited === true && draftsUsedColumn(MERCHANT) === 5,
    `remaining=${s4.free_drafts_remaining} column=${draftsUsedColumn(MERCHANT)}`);
  // 5. DRAFTING is free past the old cap: /process on a pending task (draft
  //    step) returns 200 and a drafted/reviewed task — no 402 at the DRAFT step.
  const pendingId = seedPendingTask("fd_proc", MERCHANT);
  const proc = await af(`/tasks/${pendingId}/process`, { method: "POST" });
  const procBody = await proc.json().catch(() => null) as { task?: { status?: string; draft_body?: string }; message?: string } | null;
  record("5. free merchant: /process drafts a pending task past the old cap → 200, task reviewed with a draft (no 402 at draft step)",
    proc.status === 200 && procBody?.task?.status === "reviewed" && (procBody?.task?.draft_body?.length ?? 0) > 0,
    `status=${proc.status} taskStatus=${procBody?.task?.status} body=${JSON.stringify(procBody)}`);
  // 6. The watcher still creates (and auto-drafts) tasks for a free merchant
  //    with 6+ drafts — unlimited creation.
  const wh = await af("/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      account: "acct_free_drafts",
      data: { object: { id: "fd_webhook", customer_name: "Derived Client", customer_email: "client@example.com", amount_due: 2500, currency: "usd", due_date: Math.floor(Date.now() / 1000) - 10 * 86400 } },
    }),
  });
  const whBody = await wh.json().catch(() => null) as { action?: string; taskId?: number } | null;
  record("6. free merchant: watcher creates + auto-drafts a task despite 6+ drafts (unlimited)",
    wh.status === 200 && typeof whBody?.taskId === "number" && !String(whBody?.action).includes("free draft limit"),
    `status=${wh.status} body=${JSON.stringify(whBody)}`);
  // 7. SENDING is the paid unlock: /approve on a reviewed task → 402
  //    subscription_required (at the SEND step, never the draft step).
  const approvedTaskId = insertTask("fd_approve", MERCHANT, "reviewed", "Ready to send");
  const approve = await af(`/tasks/${approvedTaskId}/approve`, { method: "POST" });
  const approveBody = await approve.json().catch(() => null) as { error?: string; message?: string } | null;
  record("7. free merchant: approve to SEND → 402 subscription_required (send step, not draft step)",
    approve.status === 402 && approveBody?.error === "subscription_required",
    `status=${approve.status} body=${JSON.stringify(approveBody)}`);
  // 8. Watcher semi-auto stage 1 for a free merchant → draft kept 'reviewed',
  //    NOT auto-sent (send skipped at the send step, no 402 crash).
  db().run("UPDATE merchants SET trust_mode='semi' WHERE id=?", [MERCHANT]);
  const wh2 = await af("/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      account: "acct_free_drafts",
      data: { object: { id: "fd_semi", customer_name: "Derived Client", customer_email: "client@example.com", amount_due: 2500, currency: "usd", due_date: Math.floor(Date.now() / 1000) - 3 * 86400 } },
    }),
  });
  const wh2Body = await wh2.json().catch(() => null) as { taskId?: number } | null;
  const semiTask = wh2Body?.taskId ? db().query("SELECT status, draft_body FROM reminder_tasks WHERE id=?").get(wh2Body.taskId) as { status: string; draft_body: string } | null : null;
  record("8. free merchant: watcher semi-auto stage-1 → task kept 'reviewed' with a draft (send blocked at send step, draft always created)",
    !!semiTask && semiTask.status === "reviewed" && semiTask.draft_body.length > 0,
    `task=${JSON.stringify(semiTask)} wh=${JSON.stringify(wh2Body)}`);
  db().run("UPDATE merchants SET trust_mode='draft' WHERE id=?", [MERCHANT]);
  // 9. Trial merchant (full-access 30-day free trial): can draft past the old
  //    cap AND send (approve → 200 sent), proving the trial is full access.
  for (let i = 0; i < 6; i++) insertTask(`fd_trial_draft_${i}`, TRIAL_MERCHANT, "reviewed", `Trial draft ${i}`);
  const trialProcId = seedPendingTask("fd_trial_proc", TRIAL_MERCHANT);
  const trialProc = await af(`/tasks/${trialProcId}/process`, { method: "POST" }, SESSION_TRIAL);
  record("9a. trial merchant: /process past old 5-cap → 200 (draft free in trial)",
    trialProc.status === 200, `status=${trialProc.status}`);
  const trialApproveId = insertTask("fd_trial_approve", TRIAL_MERCHANT, "reviewed", "Trial send");
  const trialApprove = await af(`/tasks/${trialApproveId}/approve`, { method: "POST" }, SESSION_TRIAL);
  const trialApproveBody = await trialApprove.json().catch(() => null) as { sent?: boolean; task?: { status?: string } } | null;
  record("9b. trial merchant: approve to SEND → 200 sent (full access during trial)",
    trialApprove.status === 200 && trialApproveBody?.sent === true && trialApproveBody?.task?.status === "sent",
    `status=${trialApprove.status} body=${JSON.stringify(trialApproveBody)}`);
  // 10. Active subscriber → free_drafts_unlimited=true (unchanged).
  db().run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_paid_test', 'standard', 'active')",
    [MERCHANT]
  );
  const s10 = await statsJson();
  record("10. active Standard subscriber → free_drafts_unlimited=true",
    s10.free_drafts_unlimited === true && s10.free_drafts_remaining === SENTINEL,
    `unlimited=${s10.free_drafts_unlimited} remaining=${s10.free_drafts_remaining}`);
  db().run("DELETE FROM subscriptions WHERE stripe_subscription_id='sub_paid_test'");
  // 11. Trial merchant → free_trial=true + unlimited (both true), matching the
  //     new universal semantics.
  const s11 = await statsJson(SESSION_TRIAL);
  record("11. trial merchant → free_trial=true AND free_drafts_unlimited=true (unlimited for everyone)",
    s11.free_trial === true && s11.free_drafts_unlimited === true,
    `trial=${s11.free_trial} unlimited=${s11.free_drafts_unlimited}`);
  // 12..14. Stripe connection state (unchanged coverage from the old suite).
  const s12 = await statsJson();
  record("12. no connection row → stripeConnected=false, stripeDisconnected=false, no account id",
    s12.stripeConnected === false && s12.stripeDisconnected === false && s12.stripeAccountId === null,
    `connected=${s12.stripeConnected} disconnected=${s12.stripeDisconnected} accountId=${s12.stripeAccountId}`);
  db().run(
    "INSERT INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key, created_at, updated_at) VALUES ('acct_fd_live', ?, 'rk_fd_live', NULL, '', datetime('now'), datetime('now'))",
    [MERCHANT]
  );
  const s13 = await statsJson();
  record("13. connection row present → stripeConnected=true, account id exposed",
    s13.stripeConnected === true && s13.stripeDisconnected === false && s13.stripeAccountId === 'acct_fd_live',
    `connected=${s13.stripeConnected} disconnected=${s13.stripeDisconnected} accountId=${s13.stripeAccountId}`);
  db().run("UPDATE merchants SET disconnected=1 WHERE id=?", [MERCHANT]);
  const s14 = await statsJson();
  record("14. deauthorized → stripeConnected=false, stripeDisconnected=true",
    s14.stripeConnected === false && s14.stripeDisconnected === true,
    `connected=${s14.stripeConnected} disconnected=${s14.stripeDisconnected}`);
  db().run("UPDATE merchants SET disconnected=0 WHERE id=?", [MERCHANT]);
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
