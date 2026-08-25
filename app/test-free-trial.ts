/**
 * 30-day full-access free trial tests.
 *
 * Owner directive: give newly installed merchants FULL access for 30 days
 * from install (merchants.created_at, set at OAuth connect), then lock them
 * to the normal 5-draft free tier — purely time-based, self-expiring, no
 * manual flag. This suite proves that:
 *   (a) the boundary is exact: created_at <30 days ago → in trial; exactly
 *       30 days ago → trial has elapsed; >30 days → out of trial;
 *   (b) during the trial a merchant with NO subscription gets full access:
 *       /stats reports free_trial=true + free_drafts_unlimited=true, but
 *       plan/sub_status stay 'free'/'none' (truthful — nothing fabricated),
 *       and invoiceLimit is null (uncapped, Pro-equivalent);
 *   (c) Pro/paid settings gates pass during the trial (Full Auto, custom
 *       timing, late fee, branding) and 402 for an out-of-trial free merchant;
 *   (d) the free-draft 5-cap is bypassed during the trial (a merchant with 6+
 *       drafts can still /process a pending task and the watcher still
 *       creates tasks), while an out-of-trial free merchant at the cap 402s
 *       and the watcher skips task creation;
 *   (e) the SAME merchant auto-returns to the normal 5-draft free tier when
 *       its trial lapses: free_trial=false, free_drafts_unlimited=false,
 *       0 drafts remaining, /process 402s, watcher skips — no manual step;
 *   (f) an active subscriber mid-trial is never "in trial" (free_trial=false)
 *       and is never downgraded — the real subscription wins and survives
 *       the trial expiring;
 *   (g) the 50-invoice Standard cap does NOT apply during trial (treated as
 *       uncapped Pro, not Standard).
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-free-trial.db). The
 * server MUST be booted with the provider keys stripped (log-only mode):
 *
 *   DB_PATH=/tmp/cc-free-trial.db PORT=3100 \
 *     env -u RESEND_API_KEY -u SENDGRID_API_KEY -u OPENAI_API_KEY \
 *     nohup bun run src/index.ts > /tmp/cc-free-trial-server.log 2>&1 &
 *
 * Then: TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-free-trial.db \
 *       bun run test-free-trial.ts
 *
 * Or via /tmp/run-suite.sh free-trial (kills/reboots an isolated server with a
 * fresh DB and stripped provider keys).
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-free-trial.db";
const TRIAL_MERCHANT = 5;     // acct_trial — created_at -10d, NO subscription
const EXPIRED_MERCHANT = 6;   // acct_expired — created_at -60d, NO subscription
const SUB_MIDTRIAL_MERCHANT = 7; // acct_sub_trial — created_at -10d + active Standard sub
const SESSION_TRIAL = "trial-session";
const SESSION_EXPIRED = "expired-session";
const SESSION_SUB = "sub-trial-session";
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}
function authHeaders(session: string): Record<string, string> {
  return { "Content-Type": "application/json", Cookie: `session=${encodeURIComponent(session)}` };
}
async function af(path: string, session: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders(session), ...(init.headers ?? {}) } });
}
function daysAgo(days: number): number {
  const t = new Date();
  t.setDate(t.getDate() - days);
  return Math.floor(t.getTime() / 1000);
}
/** Set a merchant's created_at (the free-trial anchor) to now - N days. */
function setCreatedAt(merchantId: number, daysBack: number): void {
  const d = db();
  d.run(`UPDATE merchants SET created_at = datetime('now', '-${daysBack} days') WHERE id=?`, [merchantId]);
  d.close();
}
function draftedTaskCount(merchantId: number): number {
  const d = db();
  const row = d.query(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=? AND rt.draft_body != ''"
  ).get(merchantId) as { n: number };
  d.close();
  return row.n;
}
function taskStatus(taskId: number | undefined): { status: string } | null {
  if (!taskId) return null;
  const d = db();
  const row = d.query("SELECT status FROM reminder_tasks WHERE id=?").get(taskId) as { status: string } | null;
  d.close();
  return row;
}
function trustMode(merchantId: number): string | null {
  const d = db();
  const row = d.query("SELECT trust_mode FROM merchants WHERE id=?").get(merchantId) as { trust_mode: string } | null;
  d.close();
  return row?.trust_mode ?? null;
}
/** Seed a drafted (or pending, draftBody="") task for a merchant. Returns task id. */
function seedTask(merchantId: number, sid: string, status: string, draftBody: string): number {
  const d = db();
  d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, 'Trial Client', 'trialclient@example.com', 5000, 'usd', datetime('now'), 'overdue')",
    [sid, merchantId]
  );
  const inv = d.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(sid) as { id: number };
  const r = d.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Trial', ?)",
    [inv.id, status, draftBody]
  );
  d.close();
  return Number(r.lastInsertRowid);
}
async function fireOverdue(invId: string, days: number, account?: string): Promise<{ action: string; taskId?: number; invoiceId?: number }> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      account,
      data: { object: { id: invId, customer_name: "Trial Client", customer_email: "trialclient@example.com", amount_due: 5000, currency: "usd", due_date: daysAgo(days) } },
    }),
  });
  return res.json() as Promise<{ action: string; taskId?: number; invoiceId?: number }>;
}
interface Stats {
  free_trial: boolean;
  free_drafts_unlimited: boolean;
  free_drafts_remaining: number;
  invoiceLimit: number | null;
  overInvoiceLimit: boolean;
  plan: string | null;
  sub_status: string | null;
}
async function stats(session: string): Promise<Stats> {
  return (await af("/stats", session)).json() as Promise<Stats>;
}

async function main(): Promise<void> {
  const PREFIX = `trial_${Date.now()}`;
  const d = db();
  // Merchants (NOT REPLACE the default 1..4 which test-dev-pro may have created
  // on the same DB — use dedicated ids 5–7). created_at anchored explicitly so
  // the trial boundary is controlled.
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, created_at) VALUES (5, 'acct_trial', 'trial@example.com', 'draft', datetime('now','-10 days'))");
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, created_at) VALUES (6, 'acct_expired', 'expired@example.com', 'draft', datetime('now','-60 days'))");
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, created_at) VALUES (7, 'acct_sub_trial', 'subtri@example.com', 'draft', datetime('now','-10 days'))");
  // Subscriber-mid-trial: an ACTIVE real Standard sub.
  d.run("INSERT OR REPLACE INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (7, 'sub_trial_std', 'standard', 'active')");
  // Sessions.
  for (const [token, mid] of [[SESSION_TRIAL, TRIAL_MERCHANT], [SESSION_EXPIRED, EXPIRED_MERCHANT], [SESSION_SUB, SUB_MIDTRIAL_MERCHANT]] as const) {
    d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [token, mid]);
  }
  // Stripe connections for webhook resolution.
  d.run("INSERT OR REPLACE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES ('acct_trial', 5, 'plain', NULL, 'pk_test')");
  d.run("INSERT OR REPLACE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES ('acct_expired', 6, 'plain', NULL, 'pk_test')");
  d.close();

  // ── (a) Exact 30-day boundary ──
  {
    // < 30 days → in trial
    setCreatedAt(TRIAL_MERCHANT, 10);
    let s = await stats(SESSION_TRIAL);
    check("(a) created_at 10 days ago → free_trial=true", s.free_trial === true, JSON.stringify(s));
    // 29 days → still in trial
    setCreatedAt(TRIAL_MERCHANT, 29);
    s = await stats(SESSION_TRIAL);
    check("(a) created_at 29 days ago → free_trial=true (just inside)", s.free_trial === true, JSON.stringify(s));
    // exactly 30 days → elapsed (strict <)
    setCreatedAt(TRIAL_MERCHANT, 30);
    s = await stats(SESSION_TRIAL);
    check("(a) created_at exactly 30 days ago → free_trial=false (elapsed)", s.free_trial === false, JSON.stringify(s));
    // > 30 days → out
    setCreatedAt(TRIAL_MERCHANT, 31);
    s = await stats(SESSION_TRIAL);
    check("(a) created_at 31 days ago (or older) → free_trial=false", s.free_trial === false, JSON.stringify(s));
    // Back in trial for the rest of the suite.
    setCreatedAt(TRIAL_MERCHANT, 10);
    // A merchant already past 30 days with no sub (expired control) is already
    // off the trial, never retroactively on it.
    check("(a) expired merchant (60 days ago) → free_trial=false", (await stats(SESSION_EXPIRED)).free_trial === false);
  }

  // ── (b) Trial full access, honest plan/sub_status ──
  {
    const s = await stats(SESSION_TRIAL);
    check("(b) trial merchant → free_trial=true", s.free_trial === true, JSON.stringify(s));
    check("(b) trial merchant → free_drafts_unlimited=true (full access)", s.free_drafts_unlimited === true, JSON.stringify(s));
    check("(b) trial merchant → plan 'free' (not claiming to be a paying customer)", s.plan === "free", `plan=${s.plan}`);
    check("(b) trial merchant → sub_status 'none' (nothing fabricated)", s.sub_status === "none", `sub_status=${s.sub_status}`);
    check("(b) trial merchant → invoiceLimit=null (Pro-equivalent, uncapped)", s.invoiceLimit === null, `invoiceLimit=${s.invoiceLimit}`);
    const sub = await (await af("/subscription", SESSION_TRIAL)).json() as { tier: string | null; status: string };
    check("(b) /subscription stays truthful for trial → {tier:null,status:'none'}", sub.tier === null && sub.status === "none", JSON.stringify(sub));
  }

  // ── (c) Pro/paid settings gates pass during trial; 402 after expiry ──
  {
    let res = await af("/settings", SESSION_TRIAL, { method: "PUT", body: JSON.stringify({ trust_mode: "full" }) });
    check("(c) trial merchant: Full Auto (Pro) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    res = await af("/settings", SESSION_TRIAL, { method: "PUT", body: JSON.stringify({ stage1_days: 3, stage2_days: 12 }) });
    check("(c) trial merchant: custom escalation timing (Pro) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    res = await af("/settings", SESSION_TRIAL, { method: "PUT", body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 25 }) });
    check("(c) trial merchant: late-fee automation (Pro) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    res = await af("/settings", SESSION_TRIAL, { method: "PUT", body: JSON.stringify({ sender_name: "Trial Brand" }) });
    check("(c) trial merchant: sender branding (Standard+) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    // Expired (out-of-trial free) merchant control — every gate 402s.
    res = await af("/settings", SESSION_EXPIRED, { method: "PUT", body: JSON.stringify({ trust_mode: "full" }) });
    check("(c) expired merchant: Full Auto → 402 (locked out)", res.status === 402, `status=${res.status}`);
    res = await af("/settings", SESSION_EXPIRED, { method: "PUT", body: JSON.stringify({ stage1_days: 3, stage2_days: 12 }) });
    check("(c) expired merchant: custom timing → 402", res.status === 402, `status=${res.status}`);
    res = await af("/settings", SESSION_EXPIRED, { method: "PUT", body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 25 }) });
    check("(c) expired merchant: late fee → 402", res.status === 402, `status=${res.status}`);
    res = await af("/settings", SESSION_EXPIRED, { method: "PUT", body: JSON.stringify({ sender_name: "X" }) });
    check("(c) expired merchant: branding → 402", res.status === 402, `status=${res.status}`);
  }

  // ── (d) Free-draft 5-cap bypass during trial ──
  {
    // Trial merchant: burn 6 drafts (over the 5 cap).
    for (let i = 0; i < 6; i++) seedTask(TRIAL_MERCHANT, `${PREFIX}_trialdraft_${i}`, "reviewed", `Draft ${i}`);
    check("(d) trial merchant has 6+ drafted tasks (past the 5 cap)", draftedTaskCount(TRIAL_MERCHANT) >= 6, `count=${draftedTaskCount(TRIAL_MERCHANT)}`);
    // A fresh PENDING task — /process must draft it without 402.
    const trialPendingId = seedTask(TRIAL_MERCHANT, `${PREFIX}_trialpending`, "pending", "");
    const trialProc = await af(`/tasks/${trialPendingId}/process`, SESSION_TRIAL, { method: "POST" });
    check("(d) trial merchant: /process past the 5-cap → 200 (not 402)", trialProc.status === 200, `status=${trialProc.status}`);
    // Watcher: a webhook still creates a task for the trial merchant.
    const trialWh = await fireOverdue(`${PREFIX}_trialwatch`, 3, "acct_trial");
    check("(d) trial merchant: watcher creates task despite exhausted cap (taskId present)",
      typeof trialWh.taskId === "number" && taskStatus(trialWh.taskId) !== null, JSON.stringify(trialWh));
    // Expired (fresh, separate) merchant control: burn the full 5-draft allowance.
    for (let i = 0; i < 5; i++) seedTask(EXPIRED_MERCHANT, `${PREFIX}_expireddraft_${i}`, "reviewed", `Draft ${i}`);
    check("(d) expired merchant has 5 drafted tasks (allowance exhausted)", draftedTaskCount(EXPIRED_MERCHANT) === 5, `count=${draftedTaskCount(EXPIRED_MERCHANT)}`);
    const expiredPendingId = seedTask(EXPIRED_MERCHANT, `${PREFIX}_expiredpending`, "pending", "");
    const expiredProc = await af(`/tasks/${expiredPendingId}/process`, SESSION_EXPIRED, { method: "POST" });
    const expiredProcBody = await expiredProc.json().catch(() => null) as { error?: string } | null;
    check("(d) expired merchant: /process past the cap → 402 subscription_required",
      expiredProc.status === 402 && expiredProcBody?.error === "subscription_required", `status=${expiredProc.status} ${JSON.stringify(expiredProcBody)}`);
    const expiredWh = await fireOverdue(`${PREFIX}_expiredwatch`, 3, "acct_expired");
    check("(d) expired merchant: watcher skips task creation at cap (no taskId)",
      expiredWh.taskId === undefined && String(expiredWh.action).includes("free draft limit"), JSON.stringify(expiredWh));
  }

  // ── (e) Same merchant self-expires back onto the 5-draft free tier ──
  {
    // The trial merchant is currently full-access (hasActiveSubscription via
    // trial → unlimited drafts). Let its trial lapse by moving created_at past
    // 30 days. NO manual flag, NO manual expiry step.
    setCreatedAt(TRIAL_MERCHANT, 31);
    const s = await stats(SESSION_TRIAL);
    check("(e) same merchant after 30 days → free_trial=false", s.free_trial === false, JSON.stringify(s));
    check("(e) same merchant after 30 days → free_drafts_unlimited=false", s.free_drafts_unlimited === false, JSON.stringify(s));
    check("(e) same merchant after 30 days → free_drafts_remaining=0 (5-cap exhausted)", s.free_drafts_remaining === 0, `remaining=${s.free_drafts_remaining}`);
    // /process past the cap now 402s for the same merchant.
    const expiredPendingId = seedTask(TRIAL_MERCHANT, `${PREFIX}_afterexpiry_pending`, "pending", "");
    const proc = await af(`/tasks/${expiredPendingId}/process`, SESSION_TRIAL, { method: "POST" });
    const procBody = await proc.json().catch(() => null) as { error?: string } | null;
    check("(e) same merchant after 30 days: /process past the cap → 402 subscription_required",
      proc.status === 402 && procBody?.error === "subscription_required", `status=${proc.status} ${JSON.stringify(procBody)}`);
    // And the watcher now skips task creation for the same merchant.
    const wh = await fireOverdue(`${PREFIX}_afterexpiry_watch`, 3, "acct_trial");
    check("(e) same merchant after 30 days: watcher skips (no taskId)",
      wh.taskId === undefined && String(wh.action).includes("free draft limit"), JSON.stringify(wh));
    // Pro trust_mode granted during the trial no longer counts: the FFR gate
    // (isActiveProSubscriber) is now false, so 'full' would be demoted on the
    // next enforcement and the watcher's auto-send branch refuses it.
    check("(e) same merchant after 30 days: Pro gate now closed (Full Auto → 402)",
      (await af("/settings", SESSION_TRIAL, { method: "PUT", body: JSON.stringify({ trust_mode: "full" }) })).status === 402);
  }

  // ── (f) Active subscriber mid-trial wins; the trial never downgrades ──
  {
    // Subscriber is 10 days in (would be in trial if it had no sub), but has an
    // active Standard sub → NOT "in free trial", full access via the sub.
    let s = await stats(SESSION_SUB);
    check("(f) subscriber mid-trial → free_trial=false (not 'in trial')", s.free_trial === false, JSON.stringify(s));
    check("(f) subscriber mid-trial → free_drafts_unlimited=true (via real sub)", s.free_drafts_unlimited === true, JSON.stringify(s));
    check("(f) subscriber mid-trial → plan 'standard' / sub_status 'active'", s.plan === "standard" && s.sub_status === "active", `plan=${s.plan} sub=${s.sub_status}`);
    check("(f) subscriber mid-trial → Standard 50-cap preserved (not downgraded to Pro/uncapped)", s.invoiceLimit === 50, `invoiceLimit=${s.invoiceLimit}`);
    // Let the (hypothetical) trial lapse: the real sub still keeps them active
    // — the trial never downgrades them.
    setCreatedAt(SUB_MIDTRIAL_MERCHANT, 40);
    s = await stats(SESSION_SUB);
    check("(f) subscriber after 30 days → still full access (sub wins, not downgraded)", s.free_drafts_unlimited === true && s.sub_status === "active", JSON.stringify(s));
    check("(f) subscriber after 30 days → still 402-free gates via sub", (await stats(SESSION_SUB)).free_trial === false);
  }

  // ── (g) Standard 50-invoice cap does NOT apply during trial ──
  {
    const d2 = db();
    const ins = d2.prepare("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, 5, 'Cap', 'cap@example.com', 1000, 'usd', datetime('now'), 'overdue')");
    d2.transaction(() => { for (let i = 0; i < 60; i++) ins.run(`${PREFIX}_trialcap_${i}`); })();
    d2.close();
    setCreatedAt(TRIAL_MERCHANT, 10); // back in trial for this check
    const s = await stats(SESSION_TRIAL);
    check("(g) trial merchant with 60+ overdue → invoiceLimit=null, overInvoiceLimit=false (uncapped, not Standard)",
      s.invoiceLimit === null && s.overInvoiceLimit === false, JSON.stringify(s));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
await main();
