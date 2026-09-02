/**
 * Dev-only Pro flag (merchants.dev_pro) endpoint tests.
 *
 * The owner needs to preview the paid Stripe App drawer (overdue summary +
 * pause/resume) and paid dashboard behavior without a live subscription. The
 * clean way is a dev flag on the MERCHANT row — deliberately NOT a fake
 * subscriptions row (a leftover fake row is what caused the owner's
 * "manage billing" 502: the portal looked up a non-existent Stripe customer).
 *
 * Contract under test:
 *   (a) /subscription: a dev_pro merchant with NO subscription rows gets the
 *       same shape a paid Pro merchant gets ({tier:'pro', status:'active'});
 *       a normal free merchant is untouched ({tier:null, status:'none'});
 *       real Standard/Pro subscribers unchanged.
 *   (b) /stats: dev_pro → free_drafts_unlimited=true, invoiceLimit=null;
 *       free merchant → free_drafts_unlimited=true too (unlimited for all);
 *       Standard subscriber keeps its 50 cap.
 *   (c) PUT /settings Pro gates (Full Auto, custom timing, late fee) and the
 *       Standard+ branding gate all pass for dev_pro; a free merchant still
 *       402s on each.
 *   (d) Free Draft Mode is UNLIMITED and free forever (owner 9/2): dev_pro
 *       with 6+ drafted tasks can still /process a pending task (200, not
 *       402) and the watcher still creates tasks from webhooks; a free
 *       merchant can draft PAST the old 5-cap (200 at the draft/process
 *       step), but every SEND attempt 402s (approve → 402 subscription_required)
 *       and the watcher's semi auto-send never fires (task kept 'reviewed').
 *   (e) Standard 50-invoice cap treated as Pro: dev_pro with 60+ overdue
 *       invoices reports invoiceLimit=null / overInvoiceLimit=false, while a
 *       real Standard subscriber with 60 overdue still reports the cap.
 *   (f) /billing/portal: dev_pro still gets the clean "no subscription"
 *       fallback (404 JSON + checkout_url on POST, 200 HTML fallback page on
 *       GET) — never a fake portal session or a 302.
 *   (g) Watcher auto-send: dev_pro with trust_mode 'full' keeps full at
 *       stage 2 (auto-sends) — the auto-send branch does NOT demote dev_pro
 *       as unpaid.
 *   (h) /support/lookup: dev_pro reports tier 'pro' / subscriptionStatus
 *       'active' with devPro:true; a free merchant reports none/false.
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-dev-pro.db). The
 * server MUST be booted with the provider keys stripped (log-only mode) and
 * SUPPORT_API_TOKEN set (for section h):
 *
 *   DB_PATH=/tmp/cc-dev-pro.db PORT=3100 SUPPORT_API_TOKEN=test-support-token \
 *     env -u RESEND_API_KEY -u SENDGRID_API_KEY -u OPENAI_API_KEY \
 *     nohup bun run src/index.ts > /tmp/cc-dev-pro-server.log 2>&1 &
 *
 * Then: TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-dev-pro.db \
 *       SUPPORT_API_TOKEN=test-support-token bun run test-dev-pro.ts
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-dev-pro.db";
const SUPPORT_TOKEN = process.env.SUPPORT_API_TOKEN || "test-support-token";

const DEV_MERCHANT = 1;   // acct_default — dev_pro=1, NO subscription rows
const FREE_MERCHANT = 2;  // acct_free_control — dev_pro=0, NO subscription rows
const STD_MERCHANT = 3;   // acct_std_control — real active Standard sub
const PRO_MERCHANT = 4;   // acct_pro_control — real active Pro sub

const SESSION_DEV = "dev-pro-session";
const SESSION_FREE = "dev-pro-session-free";
const SESSION_STD = "dev-pro-session-std";
const SESSION_PRO = "dev-pro-session-pro";

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
function subscriptionRows(merchantId: number): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM subscriptions WHERE merchant_id=?").get(merchantId) as { n: number };
  d.close();
  return row.n;
}
function draftedTaskCount(merchantId: number): number {
  const d = db();
  const row = d.query(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=? AND rt.draft_body != ''"
  ).get(merchantId) as { n: number };
  d.close();
  return row.n;
}
function taskStatus(taskId: number | undefined): { status: string; sent_at: string | null } | null {
  if (!taskId) return null;
  const d = db();
  const row = d.query("SELECT status, sent_at FROM reminder_tasks WHERE id=?").get(taskId) as { status: string; sent_at: string | null } | null;
  d.close();
  return row;
}
/** Seed a drafted (or pending, draftBody="") task for a merchant. Returns task id. */
function seedTask(merchantId: number, sid: string, status: string, draftBody: string): number {
  const d = db();
  d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, 'Dev Client', 'devclient@example.com', 5000, 'usd', datetime('now'), 'overdue')",
    [sid, merchantId]
  );
  const inv = d.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(sid) as { id: number };
  const r = d.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Dev', ?)",
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
      data: { object: { id: invId, customer_name: "Dev Client", customer_email: "devclient@example.com", amount_due: 5000, currency: "usd", due_date: daysAgo(days) } },
    }),
  });
  return res.json() as Promise<{ action: string; taskId?: number; invoiceId?: number }>;
}

async function main(): Promise<void> {
  const PREFIX = `devpro_${Date.now()}`;
  const d = db();
  // Merchants 2–4 (merchant 1 already exists as the default). dev_pro defaults 0.
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, created_at) VALUES (2, 'acct_free_control', 'free@control.com', 'draft', datetime('now', '-40 days'))");
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (3, 'acct_std_control', 'std@control.com', 'draft')");
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (4, 'acct_pro_control', 'pro@control.com', 'draft')");
  // Real subscription rows for the control merchants (dev_pro must have NONE).
  d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (3, 'sub_std_control', 'standard', 'active')");
  d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (4, 'sub_pro_control', 'pro', 'active')");
  // Sessions.
  for (const [token, mid] of [[SESSION_DEV, DEV_MERCHANT], [SESSION_FREE, FREE_MERCHANT], [SESSION_STD, STD_MERCHANT], [SESSION_PRO, PRO_MERCHANT]] as const) {
    d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [token, mid]);
  }
  // Stripe connections so webhooks with an explicit account resolve to the
  // right merchant (with NO account the resolver would pick the most recently
  // updated connection, i.e. merchant 2 — always pass an account below).
  d.run("INSERT OR REPLACE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES ('acct_default', 1, 'plain', NULL, 'pk_test')");
  d.run("INSERT OR REPLACE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES ('acct_free_control', 2, 'plain', NULL, 'pk_test')");
  d.close();

  // ── (a) /subscription ──
  {
    const noAuth = await fetch(`${BASE}/subscription`);
    check("(a) /subscription without session → 401", noAuth.status === 401, `status=${noAuth.status}`);

    // 1. dev_pro merchant BEFORE the flag is set: free shape (control within
    //    the suite — the flag flip is what changes the answer).
    let res = await af("/subscription", SESSION_DEV);
    let body = await res.json() as { tier: string | null; status: string };
    check("(a) dev merchant without flag → {tier:null,status:'none'}", res.status === 200 && body.tier === null && body.status === "none", JSON.stringify(body));

    // 2. Flip the dev flag — no subscription row is created.
    db().run("UPDATE merchants SET dev_pro=1 WHERE id=?", [DEV_MERCHANT]);
    check("(a) flag flip creates NO subscription row", subscriptionRows(DEV_MERCHANT) === 0, `subs=${subscriptionRows(DEV_MERCHANT)}`);

    res = await af("/subscription", SESSION_DEV);
    body = await res.json() as { tier: string | null; status: string; dev_pro?: boolean };
    check("(a) dev_pro merchant → {tier:'pro',status:'active',dev_pro:true} (no sub rows)",
      res.status === 200 && body.tier === "pro" && body.status === "active" && body.dev_pro === true,
      JSON.stringify(body));

    // 3. Free merchant control — untouched.
    res = await af("/subscription", SESSION_FREE);
    body = await res.json() as { tier: string | null; status: string };
    check("(a) free merchant unaffected → {tier:null,status:'none'}", res.status === 200 && body.tier === null && body.status === "none", JSON.stringify(body));

    // 4/5. Real subscribers unchanged.
    res = await af("/subscription", SESSION_STD);
    body = await res.json() as { tier: string | null; status: string };
    check("(a) real Standard subscriber → {tier:'standard',status:'active'}", res.status === 200 && body.tier === "standard" && body.status === "active", JSON.stringify(body));
    res = await af("/subscription", SESSION_PRO);
    body = await res.json() as { tier: string | null; status: string };
    check("(a) real Pro subscriber → {tier:'pro',status:'active'}", res.status === 200 && body.tier === "pro" && body.status === "active", JSON.stringify(body));
  }

  // ── (b) /stats ──
  {
    let stats = await (await af("/stats", SESSION_DEV)).json() as { free_drafts_unlimited: boolean; invoiceLimit: number | null; overInvoiceLimit: boolean };
    check("(b) dev_pro → free_drafts_unlimited=true", stats.free_drafts_unlimited === true, JSON.stringify(stats));
    check("(b) dev_pro → invoiceLimit=null (not Standard-capped)", stats.invoiceLimit === null, `invoiceLimit=${stats.invoiceLimit}`);
    const freeStats = await (await af("/stats", SESSION_FREE)).json() as { free_drafts_unlimited: boolean };
    check("(b) free merchant → free_drafts_unlimited=true (unlimited for every merchant)", freeStats.free_drafts_unlimited === true, JSON.stringify(freeStats));
    const stdStats = await (await af("/stats", SESSION_STD)).json() as { invoiceLimit: number | null; overInvoiceLimit: boolean };
    check("(b) real Standard subscriber keeps 50 cap (0 overdue → not over)", stdStats.invoiceLimit === 50 && stdStats.overInvoiceLimit === false, JSON.stringify(stdStats));
  }

  // ── (c) PUT /settings Pro + paid gates ──
  {
    let res = await af("/settings", SESSION_DEV, { method: "PUT", body: JSON.stringify({ trust_mode: "full" }) });
    check("(c) dev_pro: Full Auto (Pro) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    res = await af("/settings", SESSION_DEV, { method: "PUT", body: JSON.stringify({ stage1_days: 3, stage2_days: 12 }) });
    check("(c) dev_pro: custom escalation timing (Pro) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    res = await af("/settings", SESSION_DEV, { method: "PUT", body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 25 }) });
    check("(c) dev_pro: late-fee automation (Pro) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);
    res = await af("/settings", SESSION_DEV, { method: "PUT", body: JSON.stringify({ sender_name: "Dev Brand" }) });
    check("(c) dev_pro: sender branding (Standard+) allowed → 200", res.status === 200, `status=${res.status} ${await res.text()}`);

    // Free merchant control — every gate still 402s.
    res = await af("/settings", SESSION_FREE, { method: "PUT", body: JSON.stringify({ trust_mode: "full" }) });
    check("(c) free merchant: Full Auto → 402 (unchanged)", res.status === 402, `status=${res.status}`);
    res = await af("/settings", SESSION_FREE, { method: "PUT", body: JSON.stringify({ stage1_days: 3, stage2_days: 12 }) });
    check("(c) free merchant: custom timing → 402 (unchanged)", res.status === 402, `status=${res.status}`);
    res = await af("/settings", SESSION_FREE, { method: "PUT", body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 25 }) });
    check("(c) free merchant: late fee → 402 (unchanged)", res.status === 402, `status=${res.status}`);
    res = await af("/settings", SESSION_FREE, { method: "PUT", body: JSON.stringify({ sender_name: "No Brand" }) });
    check("(c) free merchant: branding → 402 (unchanged)", res.status === 402, `status=${res.status}`);
  }

  // ── (d) Free-draft 5-cap bypass ──
  {
    // dev_pro: burn 6 drafts (over the 5 cap).
    for (let i = 0; i < 6; i++) seedTask(DEV_MERCHANT, `${PREFIX}_devdraft_${i}`, "reviewed", `Draft ${i}`);
    check("(d) dev_pro has 6 drafted tasks (past the 5 cap)", draftedTaskCount(DEV_MERCHANT) >= 6, `count=${draftedTaskCount(DEV_MERCHANT)}`);

    // A fresh PENDING task (no draft) — /process must draft it without 402.
    const pendingId = seedTask(DEV_MERCHANT, `${PREFIX}_devpending`, "pending", "");
    const proc = await af(`/tasks/${pendingId}/process`, SESSION_DEV, { method: "POST" });
    check("(d) dev_pro: /process on pending task past the 5-cap → 200 (not 402)",
      proc.status === 200, `status=${proc.status}`);

    // Watcher: a webhook still creates a task for dev_pro despite 6+ drafts.
    const wh = await fireOverdue(`${PREFIX}_devwatch`, 3, "acct_default");
    check("(d) dev_pro: watcher creates task despite exhausted draft cap (taskId present)",
      typeof wh.taskId === "number" && taskStatus(wh.taskId) !== null, JSON.stringify(wh));

    // Free merchant control (Free Draft Mode unlimited): draft PAST the old
    // 5-cap without 402; the SEND step is where the plan gate lives.
    for (let i = 0; i < 6; i++) seedTask(FREE_MERCHANT, `${PREFIX}_freedraft_${i}`, "reviewed", `Draft ${i}`);
    check("(d) free merchant has 6+ drafted tasks (past the old 5-cap)", draftedTaskCount(FREE_MERCHANT) >= 6, `count=${draftedTaskCount(FREE_MERCHANT)}`);
    // A pending task with no draft — /process must DRAFT it without 402.
    const freePendingId = seedTask(FREE_MERCHANT, `${PREFIX}_freepending`, "pending", "");
    const freeProc = await af(`/tasks/${freePendingId}/process`, SESSION_FREE, { method: "POST" });
    const freeProcBody = await freeProc.json().catch(() => null) as { error?: string } | null;
    check("(d) free merchant: /process drafts a pending task past the old cap → 200 (not 402 at draft step)",
      freeProc.status === 200, `status=${freeProc.status} ${JSON.stringify(freeProcBody)}`);
    // SENDING is the paid unlock: approve → 402 subscription_required.
    const freeApproveId = seedTask(FREE_MERCHANT, `${PREFIX}_freeapprove`, "reviewed", "Ready");
    const freeApprove = await af(`/tasks/${freeApproveId}/approve`, SESSION_FREE, { method: "POST" });
    const freeApproveBody = await freeApprove.json().catch(() => null) as { error?: string } | null;
    check("(d) free merchant: approve to SEND → 402 subscription_required (send step, not draft step)",
      freeApprove.status === 402 && freeApproveBody?.error === "subscription_required", `status=${freeApprove.status} ${JSON.stringify(freeApproveBody)}`);
    // Watcher free control: webhook for the free merchant (draft Trust Mode) →
    // task still CREATED + auto-drafted (unlimited), never skipped.
    const freeWh = await fireOverdue(`${PREFIX}_freewatch`, 3, "acct_free_control");
    check("(d) free merchant: watcher creates + auto-drafts a task despite 6+ drafts (no taskId skip)",
      typeof freeWh.taskId === "number" && taskStatus(freeWh.taskId) !== null, JSON.stringify(freeWh));
  }

  // ── (e) Standard 50-invoice cap treated as Pro ──
  {
    const d2 = db();
    // 60 overdue invoices for the dev_pro merchant.
    const ins = d2.prepare("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, 1, 'Cap', 'cap@example.com', 1000, 'usd', datetime('now'), 'overdue')");
    d2.transaction(() => { for (let i = 0; i < 60; i++) ins.run(`${PREFIX}_devcap_${i}`); })();
    // 60 overdue invoices for the real Standard merchant.
    const ins2 = d2.prepare("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, 3, 'Cap', 'cap@example.com', 1000, 'usd', datetime('now'), 'overdue')");
    d2.transaction(() => { for (let i = 0; i < 60; i++) ins2.run(`${PREFIX}_stdcap_${i}`); })();
    d2.close();

    const devStats = await (await af("/stats", SESSION_DEV)).json() as { invoiceLimit: number | null; overInvoiceLimit: boolean };
    check("(e) dev_pro with 60+ overdue → invoiceLimit=null, overInvoiceLimit=false (treated as Pro, not Standard)",
      devStats.invoiceLimit === null && devStats.overInvoiceLimit === false, JSON.stringify(devStats));
    const stdStats = await (await af("/stats", SESSION_STD)).json() as { invoiceLimit: number | null; overInvoiceLimit: boolean };
    check("(e) real Standard subscriber with 60+ overdue → cap still enforced (invoiceLimit=50, over=true)",
      stdStats.invoiceLimit === 50 && stdStats.overInvoiceLimit === true, JSON.stringify(stdStats));
  }

  // ── (f) /billing/portal stays clean for dev_pro (no fake portal session) ──
  {
    const post = await af("/billing/portal", SESSION_DEV, { method: "POST" });
    const postBody = await post.json().catch(() => null) as { error?: string; checkout_url?: string } | null;
    check("(f) dev_pro: POST /billing/portal → clean 404 JSON + checkout_url (no fake portal)",
      post.status === 404 && typeof postBody?.error === "string" && postBody.checkout_url === "/billing/checkout?tier=pro",
      `status=${post.status} ${JSON.stringify(postBody)}`);
    const get = await af("/billing/portal", SESSION_DEV, { redirect: "manual" });
    const getText = await get.clone().text();
    check("(f) dev_pro: GET /billing/portal → 200 HTML fallback (not a 302 to Stripe)",
      get.status === 200 && get.headers.get("x-billing-fallback") === "no-subscription" &&
        (get.headers.get("content-type") || "").includes("text/html") && getText.includes("/billing/checkout?tier=pro"),
      `status=${get.status} loc=${get.headers.get("location")} fallback=${get.headers.get("x-billing-fallback")}`);
    // And dev_pro must still see NO subscription in the DB (nothing fabricated).
    check("(f) dev_pro still has zero subscription rows", subscriptionRows(DEV_MERCHANT) === 0, `subs=${subscriptionRows(DEV_MERCHANT)}`);
    const freePost = await af("/billing/portal", SESSION_FREE, { method: "POST" });
    check("(f) free merchant: POST /billing/portal → 404 JSON (unchanged)", freePost.status === 404, `status=${freePost.status}`);
  }

  // ── (g) Watcher auto-send does not reject dev_pro as unpaid ──
  {
    // trust_mode is already 'full' from (c). A stage-2 overdue (10 days, but
    // the dev merchant's custom ladder from (c) is 3/12 → still stage 2) only
    // auto-sends if 'full' survives — a demoted 'semi' would hold at stage 2.
    const wh = await fireOverdue(`${PREFIX}_devfull`, 10, "acct_default");
    const t = taskStatus(wh.taskId);
    check("(g) dev_pro: full trust mode NOT demoted — stage 2 auto-sent at webhook",
      t !== null && t.status === "sent" && t.sent_at !== null, JSON.stringify({ wh, t }));
  }

  // ── (h) /support/lookup ──
  {
    const sup = async (email: string): Promise<{ tier: string | null; subscriptionStatus: string | null; devPro: boolean }> => {
      const res = await fetch(`${BASE}/support/lookup?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${SUPPORT_TOKEN}` },
      });
      return res.json() as Promise<{ tier: string | null; subscriptionStatus: string | null; devPro: boolean }>;
    };
    const devLookup = await sup("default@collections-copilot.local");
    check("(h) support lookup: dev_pro merchant → tier 'pro', status 'active', devPro true",
      devLookup.tier === "pro" && devLookup.subscriptionStatus === "active" && devLookup.devPro === true, JSON.stringify(devLookup));
    const freeLookup = await sup("free@control.com");
    check("(h) support lookup: free merchant → tier null, status 'none', devPro false",
      freeLookup.tier === null && freeLookup.subscriptionStatus === "none" && freeLookup.devPro === false, JSON.stringify(freeLookup));
  }

  // ── (i) Engagement pill is a Pro-tier feature (owner 9/2) ──
  {
    // Seed one sent reminder + Resend engagement data for BOTH the dev-pro
    // merchant (1) and the free merchant (2): data collection is un-gated
    // (webhook records for everyone), but the /reminders DISPLAY only renders
    // for active Pro / dev-pro.
    const d = db();
    const seedSend = (merchantId: number, sid: string, resendId: string): number => {
      d.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, 'Pill', 'pill@example.com', 3000, 'usd', datetime('now'), 'overdue')", [sid, merchantId]);
      const inv = d.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(sid) as { id: number };
      const t = d.run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, 'sent', 'Pill', 'Body')", [inv.id]);
      d.run("INSERT INTO send_logs (reminder_task_id, type, status, provider_message, created_at, resend_message_id, opened_at, open_count, clicked_at, click_count) VALUES (?, 'reminder', 'success', 'Sent via Resend', datetime('now','-1 day'), ?, datetime('now','-1 hour'), 2, datetime('now','-1 hour'), 1)", [Number(t.lastInsertRowid), resendId]);
      return Number(t.lastInsertRowid);
    };
    seedSend(DEV_MERCHANT, `${PREFIX}_pilldev`, "pill-dev-resend");
    seedSend(FREE_MERCHANT, `${PREFIX}_pillfree`, "pill-free-resend");
    d.close();

    const devRem = await (await fetch(`${BASE}/reminders`, { headers: { Cookie: `session=${SESSION_DEV}` } })).text();
    // Assert on the rendered pill MARKUP (the CSS rules are in the shared
    // template and would false-positive a plain-text match).
    check("(i) dev_pro merchant: engagement pill element renders (Opened & clicked)", devRem.includes('class="chip chip-engagement chip-engagement-clicked"'), "");
    check("(i) dev_pro merchant: pill label is Opened & clicked", devRem.includes(">Opened &amp; clicked</span>") || devRem.includes(">Opened & clicked</span>"), "");
    const freeRem = await (await fetch(`${BASE}/reminders`, { headers: { Cookie: `session=${SESSION_FREE}` } })).text();
    check("(i) free merchant: engagement pill does NOT render (bare —)", freeRem.includes('class="cell-muted">—</span>'), "");
    // The shared template ships the .chip-engagement CSS rules for every page,
    // so assert on the pill MARKUP, not the stylesheet class strings.
    check("(i) free merchant: no engagement pill element renders", !freeRem.includes('class="chip chip-engagement'), "");
    check("(i) free merchant: no open/click copy leaks", !freeRem.includes(">Opened") && !freeRem.includes(">clicked") && !freeRem.includes("open or clicked"), "");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
