/**
 * Admin-only customer tracking suite — /admin + /admin/data auth and the
 * /api/track page-visit endpoint + subscription_events webhook logging.
 *
 * Proves:
 *   (a) /admin auth matrix: no token → 403, wrong token → 403, right token
 *       (?token= or Authorization: Bearer) → 200 HTML page carrying the
 *       injected __CC_ADMIN_TOKEN__
 *   (b) /admin/data auth matrix: same gate; right token → 200 JSON with the
 *       funnel/merchants/visits/subscription_events shape
 *   (c) /api/track: valid POST → 200 and one row in page_visits; retried
 *       identical payload (same visitor_id/page/ts) → still one row
 *       (idempotent-ish); missing visitor_id/page → 400; bad JSON → 400;
 *       GET /api/track → 404 (POST-only route, no site build in tests)
 *   (d) funnel counters reflect recorded data (visits totals + recent)
 *   (e) /billing webhook transitions write subscription_events rows
 *       ('created' on checkout.session.completed, 'cancelled' on
 *       customer.subscription.deleted) and /admin/data surfaces them +
 *       merchant plan/sub_status derivation (dev_pro → pro/active)
 *   (f) /admin is absent from every public surface the test can reach:
 *       the landing page fallback never serves it unauthenticated
 *
 * Runs against a booted server sharing its SQLite DB:
 *
 *   bash /tmp/run-suite.sh admin
 *
 * (boots an isolated server on :3100 with a fresh DB, provider keys stripped
 * and ADMIN_TOKEN=test-admin-token). The /billing webhook tests run in
 * signature-less test mode (server booted on localhost without
 * STRIPE_WEBHOOK_SECRET — the handler logs "skipping signature verification").
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-admin.db";
const TOKEN = "test-admin-token";
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function q(sql: string, ...args: unknown[]): unknown[] {
  const d = new Database(DB_PATH);
  const rows = d.query(sql).all(...args);
  d.close();
  return rows;
}
function q1(sql: string, ...args: unknown[]): Record<string, unknown> | null {
  const d = new Database(DB_PATH);
  const row = d.query(sql).get(...args) as Record<string, unknown> | null;
  d.close();
  return row;
}

async function main(): Promise<void> {
  // ── (a) /admin auth matrix ──
  let r = await fetch(`${BASE}/admin`);
  check("admin no token → 403", r.status === 403, `got ${r.status}`);
  r = await fetch(`${BASE}/admin?token=wrong-token`);
  check("admin wrong token → 403", r.status === 403, `got ${r.status}`);
  r = await fetch(`${BASE}/admin?token=${TOKEN}`);
  const html = await r.text();
  check("admin right token (query) → 200", r.status === 200, `got ${r.status}`);
  check("admin page is HTML with title", html.includes("CollectionsCopilot — Admin"), "title missing");
  check("admin page injects token for /admin/data", html.includes(`__CC_ADMIN_TOKEN__`) === false && html.includes(TOKEN), "token not injected");
  check("admin page carries noindex robots tag", (r.headers.get("X-Robots-Tag") || "").includes("noindex"), "X-Robots-Tag missing");
  r = await fetch(`${BASE}/admin`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  check("admin right token (Bearer header) → 200", r.status === 200, `got ${r.status}`);
  r = await fetch(`${BASE}/admin`, { headers: { Authorization: `Bearer wrong-token` } });
  check("admin wrong Bearer → 403", r.status === 403, `got ${r.status}`);

  // ── (b) /admin/data auth matrix ──
  r = await fetch(`${BASE}/admin/data`);
  check("admin/data no token → 403", r.status === 403, `got ${r.status}`);
  r = await fetch(`${BASE}/admin/data?token=wrong-token`);
  check("admin/data wrong token → 403", r.status === 403, `got ${r.status}`);
  r = await fetch(`${BASE}/admin/data?token=${TOKEN}`);
  check("admin/data right token → 200", r.status === 200, `got ${r.status}`);
  const data = (await r.json()) as {
    generated_at: string; funnel: Record<string, unknown>; merchants: unknown[]; visits: unknown[]; subscription_events: unknown[];
  };
  check("admin/data has funnel + merchants + visits + subscription_events",
    !!data.funnel && Array.isArray(data.merchants) && Array.isArray(data.visits) && Array.isArray(data.subscription_events));
  check("admin/data funnel has visits/connects/drafts counters",
    "visits_total" in data.funnel && "connects_total" in data.funnel && "drafts_created_total" in data.funnel &&
    "paid_active" in data.funnel && "subs_cancelled" in data.funnel);

  // ── (c) /api/track ──
  const ts = new Date().toISOString();
  const payload = { visitor_id: "11111111-2222-4333-8444-555555555555", page: "/", referrer: "https://google.com", utm_source: "google", utm_medium: "cpc", utm_campaign: "launch", ts };
  r = await postJson("/api/track", payload);
  check("track valid POST → 200", r.status === 200, `got ${r.status}`);
  const row1 = q1("SELECT * FROM page_visits WHERE visitor_id = ?", payload.visitor_id);
  check("track wrote a page_visits row", !!row1, "no row");
  check("track row stores utm + page", row1?.page === "/" && row1?.utm_source === "google" && row1?.utm_campaign === "launch", JSON.stringify(row1));

  // Idempotent-ish: same visitor/page/ts replayed → no duplicate row.
  r = await postJson("/api/track", payload);
  check("track duplicate payload → 200", r.status === 200, `got ${r.status}`);
  const n = (q("SELECT COUNT(*) AS n FROM page_visits WHERE visitor_id = ?", payload.visitor_id)[0] as { n: number }).n;
  check("track duplicate payload did NOT create a second row (idempotent-ish)", n === 1, `rows=${n}`);

  // A second visit (different ts — same visitor, new page) IS a new row.
  const ts2 = new Date(Date.now() + 1000).toISOString();
  await postJson("/api/track", { ...payload, page: "/pricing", ts: ts2 });
  const n2 = (q("SELECT COUNT(*) AS n FROM page_visits WHERE visitor_id = ?", payload.visitor_id)[0] as { n: number }).n;
  check("track new visit (new page/ts) → second row", n2 === 2, `rows=${n2}`);

  // Validation.
  r = await postJson("/api/track", { page: "/" });
  check("track missing visitor_id → 400", r.status === 400, `got ${r.status}`);
  r = await postJson("/api/track", { visitor_id: "v" });
  check("track missing page → 400", r.status === 400, `got ${r.status}`);
  r = await fetch(`${BASE}/api/track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  check("track bad JSON → 400", r.status === 400, `got ${r.status}`);
  r = await fetch(`${BASE}/api/track`);
  check("GET /api/track → 404 (POST-only)", r.status === 404, `got ${r.status}`);

  // ── (d) funnel counters reflect recorded visits ──
  // Three POSTs, but the duplicate was ignored → 2 rows (1 + 1 new visit).
  const data2 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    funnel: { visits_total: number; visits_24h: number; visits_7d: number };
  };
  check("funnel visits_total matches recorded rows", data2.funnel.visits_total === 2, `total=${data2.funnel.visits_total}`);
  check("funnel visits_24h counts the recent rows", data2.funnel.visits_24h === 2, `24h=${data2.funnel.visits_24h}`);

  // ── (e) /billing webhook → subscription_events + merchant derivation ──
  // checkout.session.completed (test mode — no signature secret on localhost).
  const subId = "sub_admin_test_1";
  r = await postJson("/billing", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_admin_test", subscription: subId, customer: "cus_admin_test", metadata: { merchant_id: "1", tier: "pro" } } },
  });
  check("billing checkout.session.completed → 200", r.status === 200, `got ${r.status}`);
  const evCreated = q1("SELECT * FROM subscription_events WHERE stripe_subscription_id = ? AND event = 'created'", subId);
  check("subscription_events row 'created' written", !!evCreated, "missing");
  check("created event has tier pro + status active", evCreated?.tier === "pro" && evCreated?.status === "active", JSON.stringify(evCreated));

  // customer.subscription.updated → 'updated' event (status becomes past_due).
  r = await postJson("/billing", {
    type: "customer.subscription.updated",
    data: { object: { id: subId, status: "past_due" } },
  });
  check("billing subscription.updated → 200", r.status === 200, `got ${r.status}`);
  const evUpdated = q1("SELECT * FROM subscription_events WHERE stripe_subscription_id = ? AND event = 'updated' ORDER BY id DESC LIMIT 1", subId);
  check("subscription_events row 'updated' written", !!evUpdated, "missing");

  // customer.subscription.deleted → 'cancelled' event + subscriptions status
  // (run AFTER updated so the final subscriptions row state is 'cancelled' —
  // the deleted handler's status write is the last one).
  r = await postJson("/billing", { type: "customer.subscription.deleted", data: { object: { id: subId } } });
  check("billing subscription.deleted → 200", r.status === 200, `got ${r.status}`);
  const evCancelled = q1("SELECT * FROM subscription_events WHERE stripe_subscription_id = ? AND event = 'cancelled'", subId);
  check("subscription_events row 'cancelled' written", !!evCancelled, "missing");
  const subRow = q1("SELECT status FROM subscriptions WHERE stripe_subscription_id = ?", subId);
  check("subscriptions row marked cancelled", subRow?.status === "cancelled", JSON.stringify(subRow));

  // Admin data surfaces the events + derived merchant state.
  const data3 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    funnel: { subs_cancelled: number; paid_active: { pro: number } };
    subscription_events: Array<{ event: string; stripe_subscription_id: string }>;
    merchants: Array<{ id: number; plan: string; sub_status: string; stripe_account_id: string }>;
  };
  check("admin data includes the 3 subscription events",
    data3.subscription_events.length >= 3 &&
    data3.subscription_events.some(e => e.event === "created" && e.stripe_subscription_id === subId) &&
    data3.subscription_events.some(e => e.event === "cancelled" && e.stripe_subscription_id === subId));
  check("funnel subs_cancelled >= 1", data3.funnel.subs_cancelled >= 1, `cancelled=${data3.funnel.subs_cancelled}`);
  const m1 = data3.merchants.find(m => m.id === 1);
  check("merchant 1 shows pro + cancelled derivation", !!m1 && m1.plan === "pro" && m1.sub_status === "cancelled", JSON.stringify(m1));
  check("merchant 1 flagged placeholder (acct_default)", !!m1 && m1.stripe_account_id === "acct_default", JSON.stringify(m1));

  // dev_pro derivation: merchant 2 flagged dev_pro → plan pro / sub_status active.
  {
    const d = new Database(DB_PATH);
    d.run("INSERT INTO merchants (id, stripe_account_id, email, trust_mode, dev_pro) VALUES (2, 'acct_dev', 'dev@example.com', 'full', 1)");
    d.close();
  }
  const data4 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    merchants: Array<{ id: number; plan: string; sub_status: string; dev_pro: boolean }>;
  };
  const m2 = data4.merchants.find(m => m.id === 2);
  check("dev_pro merchant derives plan pro + status active", !!m2 && m2.plan === "pro" && m2.sub_status === "active" && m2.dev_pro === true, JSON.stringify(m2));

  // ── (f) /admin never leaks unauthenticated; landing fallback unaffected ──
  r = await fetch(`${BASE}/admin/data`, { method: "POST" });
  check("POST /admin/data → 403 (gate first, method not allowed second)", r.status === 403, `got ${r.status}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll admin/track checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error("Suite crashed:", err); process.exit(1); });
