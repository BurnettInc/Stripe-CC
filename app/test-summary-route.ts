/**
 * Manual weekly-summary route (POST /summary/send) — connect-window guard suite.
 *
 * Context: the 2026-10-28 incident (send_logs id 135, 08:56:45) was a brand-new
 * trial merchant who clicked the dashboard "Send weekly summary" button 16
 * minutes after connecting and received a report covering the week BEFORE she
 * connected (no summary_sends row — the manual route). PR #242 hardened the
 * SCHEDULED pass only; this suite covers the on-demand path, which now applies
 * the same shared rule (pipeline/summary.summaryWindowPredatesConnect).
 *
 * Covers:
 *   (a) POST /summary/send without a session → 401;
 *   (b) brand-new connect (2 days, paid Standard) → 200 {skipped:true} with the
 *       connect-window message, NO send_logs row, NO summary_sends row;
 *   (c) free-TRIAL merchant connected 2 days ago → also skipped (trial still
 *       counts as paid, and is still guarded — no 402, no email);
 *   (d) GET /summary for that same merchant is UNCHANGED (200, full summary,
 *       periodStart present) and the window genuinely predates her connect —
 *       proof the skip in (b) was warranted, and that the stats view is not
 *       clamped;
 *   (e) established merchant (connected 10 days ago) → sends normally (200,
 *       sendResult.success true, one send_logs weekly_summary row);
 *   (f) merchant with NO stripe_connections row → falls back to
 *       merchants.created_at (9 days ago) and sends;
 *   (g) free merchant outside the 30-day trial → still 402 (the paid gate is
 *       untouched by this fix);
 *   (h) the manual route never writes summary_sends (a skip is not an attempt
 *       and a manual send is not part of the 7-day cadence ledger).
 *
 * Runs against a booted server sharing its SQLite DB — use the suite driver:
 *   bash /home/team/shared/scripts/run-suite.sh summary-route
 * (boots a fresh /tmp/cc-summary-route.db on :3100 with provider keys stripped,
 * so sends go through the log-only stub and never touch a real provider).
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-summary-route.db";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}

function db(): Database {
  return new Database(DB_PATH);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** SQLite datetime('now') shape — 'YYYY-MM-DD HH:MM:SS' (UTC, no zone). */
function sqliteAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 19).replace("T", " ");
}
/** ISO-8601 — the format the OAuth handshake writes to stripe_connections. */
function isoAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

interface Seeded {
  id: number;
  session: string;
  email: string;
}

/**
 * Seed one merchant (+ session). `connectedDaysAgo === null` = no
 * stripe_connections row at all (the merchants.created_at fallback path).
 */
function seedMerchant(opts: {
  key: string;
  createdDaysAgo: number;
  connectedDaysAgo: number | null;
  paid: "standard" | "pro" | "trial" | null;
}): Seeded {
  const d = db();
  const email = `${opts.key}@example.com`;
  const info = d.run(
    `INSERT INTO merchants (stripe_account_id, email, trust_mode, created_at, stage1_days, stage2_days)
     VALUES (?, ?, 'draft', ?, 6, 20)`,
    [`acct_${opts.key}`, email, sqliteAgo(opts.createdDaysAgo)]
  );
  const id = Number(info.lastInsertRowid);
  if (opts.connectedDaysAgo !== null) {
    const when = isoAgo(opts.connectedDaysAgo);
    d.run(
      `INSERT INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
      [`acct_conn_${opts.key}`, id, `tok_${opts.key}`, `rt_${opts.key}`, when, when]
    );
  }
  if (opts.paid === "standard" || opts.paid === "pro") {
    d.run(
      "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, ?, ?, 'active')",
      [id, `sub_${opts.key}`, opts.paid]
    );
  }
  const session = `sess_${opts.key}`;
  d.run("INSERT INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))", [session, id]);
  d.close();
  return { id, session, email };
}

async function postSummarySend(session: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) headers.Cookie = `session=${session}`;
  const res = await fetch(`${BASE}/summary/send`, { method: "POST", headers });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

function weeklySummaryLogCount(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='weekly_summary'").get() as { n: number };
  d.close();
  return row.n;
}
function summarySendsCount(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM summary_sends").get() as { n: number };
  d.close();
  return row.n;
}

const SKIP_MESSAGE =
  "Your weekly summary covers the past 7 days. You'll receive your first one once your account has been connected for a full week.";

async function main(): Promise<void> {
  // ── (a) auth ──
  {
    const res = await postSummarySend(null);
    check("(a) POST /summary/send without a session → 401", res.status === 401, `status=${res.status}`);
  }

  // Fixtures
  const fresh = seedMerchant({ key: "sr_fresh", createdDaysAgo: 10, connectedDaysAgo: 2, paid: "standard" });
  const trialFresh = seedMerchant({ key: "sr_trial", createdDaysAgo: 3, connectedDaysAgo: 2, paid: "trial" });
  const established = seedMerchant({ key: "sr_est", createdDaysAgo: 20, connectedDaysAgo: 10, paid: "pro" });
  const noConn = seedMerchant({ key: "sr_noconn", createdDaysAgo: 9, connectedDaysAgo: null, paid: "standard" });
  const freeExpired = seedMerchant({ key: "sr_free", createdDaysAgo: 60, connectedDaysAgo: 40, paid: null });

  // ── (b) brand-new connect (paid) → skipped, nothing sent, nothing logged ──
  {
    const before = weeklySummaryLogCount();
    const res = await postSummarySend(fresh.session);
    const sendResult = (res.body.sendResult ?? {}) as Record<string, unknown>;
    check("(b) fresh connect (2d) → 200 (not an error)", res.status === 200, `status=${res.status}`);
    check("(b) response is the placeholder-skip shape {skipped:true}", res.body.skipped === true, JSON.stringify(res.body));
    check("(b) sentTo echoes the merchant email", res.body.sentTo === fresh.email, `sentTo=${String(res.body.sentTo)}`);
    check(
      "(b) sendResult {success:false, skipped:true} with the connect-window message",
      sendResult.success === false &&
        sendResult.skipped === true &&
        sendResult.message === SKIP_MESSAGE,
      JSON.stringify(sendResult)
    );
    check("(b) no email content generated (no `email` field on a skip)", res.body.email === undefined, JSON.stringify(Object.keys(res.body)));
    check("(b) NOTHING logged in send_logs", weeklySummaryLogCount() === before, `before=${before} after=${weeklySummaryLogCount()}`);
    check("(b) no summary_sends row written", summarySendsCount() === 0, `rows=${summarySendsCount()}`);
  }

  // ── (c) free-TRIAL merchant, same fresh connect → skipped too ──
  {
    const before = weeklySummaryLogCount();
    const res = await postSummarySend(trialFresh.session);
    const sendResult = (res.body.sendResult ?? {}) as Record<string, unknown>;
    check("(c) trial merchant is not 402'd (trial still counts as paid)", res.status === 200, `status=${res.status}`);
    check("(c) trial merchant connected 2 days ago → skipped, same message", res.body.skipped === true && sendResult.message === SKIP_MESSAGE, JSON.stringify(res.body));
    check("(c) trial skip sends nothing", weeklySummaryLogCount() === before, `before=${before} after=${weeklySummaryLogCount()}`);
  }

  // ── (d) GET /summary unchanged + the skipped window really did predate connect ──
  {
    const res = await fetch(`${BASE}/summary`, { headers: { Cookie: `session=${fresh.session}` } });
    const body = (await res.json()) as { periodStart?: string; periodEnd?: string; merchantId?: number; skipped?: unknown };
    const connectDate = isoAgo(2).slice(0, 10);
    check("(d) GET /summary still 200 for the fresh merchant", res.status === 200, `status=${res.status}`);
    check(
      "(d) GET /summary is NOT clamped: full summary with a periodStart",
      typeof body.periodStart === "string" && typeof body.periodEnd === "string" && body.merchantId === fresh.id && body.skipped === undefined,
      JSON.stringify(body)
    );
    check(
      "(d) that window genuinely starts before the connect date (the skip was warranted)",
      typeof body.periodStart === "string" && body.periodStart < connectDate,
      `periodStart=${String(body.periodStart)} connectDate=${connectDate}`
    );
  }

  // ── (e) established merchant (connected 10d) → the button still works ──
  {
    const before = weeklySummaryLogCount();
    const res = await postSummarySend(established.session);
    const sendResult = (res.body.sendResult ?? {}) as Record<string, unknown>;
    check("(e) established (connected 10d) → 200, not skipped", res.status === 200 && res.body.skipped !== true, JSON.stringify(res.body));
    check("(e) sendResult.success true (log-only stub) and targeted at the merchant", sendResult.success === true && res.body.sentTo === established.email, JSON.stringify(sendResult));
    check("(e) exactly one weekly_summary send_logs row recorded", weeklySummaryLogCount() === before + 1, `before=${before} after=${weeklySummaryLogCount()}`);
    check("(e) manual send writes no summary_sends row", summarySendsCount() === 0, `rows=${summarySendsCount()}`);
  }

  // ── (f) no stripe_connections row → merchants.created_at fallback ──
  {
    const before = weeklySummaryLogCount();
    const res = await postSummarySend(noConn.session);
    const sendResult = (res.body.sendResult ?? {}) as Record<string, unknown>;
    check("(f) no connection row (created 9d ago) → sends normally", res.status === 200 && res.body.skipped !== true && sendResult.success === true, JSON.stringify(res.body));
    check("(f) send logged", weeklySummaryLogCount() === before + 1, `before=${before} after=${weeklySummaryLogCount()}`);
  }

  // ── (g) paid gate untouched: free + outside the trial → 402 ──
  {
    const before = weeklySummaryLogCount();
    const res = await postSummarySend(freeExpired.session);
    check("(g) free merchant outside the trial → 402", res.status === 402, `status=${res.status}`);
    check("(g) 402 sends nothing", weeklySummaryLogCount() === before, `before=${before} after=${weeklySummaryLogCount()}`);
  }

  // ── (h) ledger untouched by the manual route across the whole suite ──
  check("(h) no summary_sends rows were ever written by POST /summary/send", summarySendsCount() === 0, `rows=${summarySendsCount()}`);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
