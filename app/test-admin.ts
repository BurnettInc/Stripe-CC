/**
 * Admin-only customer tracking suite — /admin + /admin/data auth and the
 * /api/track page-visit endpoint + subscription_events webhook logging.
 *
 * Proves:
 *   (a) /admin auth matrix: no token → 403, wrong token → 403, right token
 *       (?token= or Authorization: Bearer) → 200 HTML page carrying the
 *       injected __CC_ADMIN_TOKEN__
 *   (b) /admin/data auth matrix: same gate; right token → 200 JSON with the
 *       funnel/merchants/visits/subscription_events/waitlist shape
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
 *   (g) visits_by_source channel attribution + utm_content surfacing + per-
 *       bucket detail (display names, raw referrer hosts incl. utm+referrer
 *       combos, direct → empty hosts) + the admin page markup for the
 *       Referrer(s) column, Recent visits panel and UTM campaigns panel
 *   (h) /admin/data waitlist block: total + newest-first entries with
 *       id/email/created_at for seeded rows, per-entry channel attribution
 *       (source_bucket/display/hosts via the shared visit-sources helpers),
 *       the 500-entry cap, and the waitlist panel markup on the admin page
 *       (Source column + 4-cell empty state)
 *   (i) /admin/data utm_campaigns rollup: shape {campaign, medium, visits_total,
 *       visits_7d, first_touch_visitors}, medium from the first row seen per
 *       campaign, sort (visits_total desc then campaign asc), and the
 *       newsletter utm_source bucket (title-cased display + referrer hosts)
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    generated_at: string; funnel: Record<string, unknown>; merchants: unknown[]; visits: unknown[];
    visits_by_source: Array<{ bucket: string; visits_total: number; visits_7d: number; first_touch_visitors: number }>;
    subscription_events: unknown[];
    waitlist: { total: number; entries: Array<{ id: number; email: string; created_at: string }> };
  };
  check("admin/data has funnel + merchants + visits + subscription_events",
    !!data.funnel && Array.isArray(data.merchants) && Array.isArray(data.visits) && Array.isArray(data.subscription_events));
  check("admin/data has waitlist block (empty on fresh DB → total 0, no entries)",
    !!data.waitlist && data.waitlist.total === 0 && Array.isArray(data.waitlist.entries) && data.waitlist.entries.length === 0,
    JSON.stringify(data.waitlist));
  check("admin/data has visits_by_source (channel attribution)",
    Array.isArray(data.visits_by_source) && data.visits_by_source.every((b) =>
      typeof b.bucket === "string" && typeof b.visits_total === "number" &&
      typeof b.visits_7d === "number" && typeof b.first_touch_visitors === "number"));
  check("admin/data funnel has visits/connects/drafts counters",
    "visits_total" in data.funnel && "connects_total" in data.funnel && "drafts_created_total" in data.funnel &&
    "paid_active" in data.funnel && "subs_cancelled" in data.funnel);

  // ── (c) /api/track ──
  const ts = new Date().toISOString();
  const payload = { visitor_id: "11111111-2222-4333-8444-555555555555", page: "/", referrer: "https://google.com", utm_source: "google", utm_medium: "cpc", utm_campaign: "launch", utm_content: "test-content", ts };
  r = await postJson("/api/track", payload);
  check("track valid POST → 200", r.status === 200, `got ${r.status}`);
  const row1 = q1("SELECT * FROM page_visits WHERE visitor_id = ?", payload.visitor_id);
  check("track wrote a page_visits row", !!row1, "no row");
  check("track row stores utm + page", row1?.page === "/" && row1?.utm_source === "google" && row1?.utm_campaign === "launch", JSON.stringify(row1));
  check("track row stores utm_content (post-level attribution)", row1?.utm_content === "test-content", JSON.stringify(row1));

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

  // ── (g) visits_by_source channel attribution ──
  // Two rows already exist for visitor 1111... (both utm_source=google — see
  // section c/d). Add one beacon per attribution path: bare → direct,
  // twitter referrer → x, HN referrer → hackernews, and a visitor whose FIRST
  // visit is a reddit referrer and whose second carries utm google (first-touch
  // must attribute to reddit, not google).
  const t0 = Date.now() + 5000;
  await postJson("/api/track", { visitor_id: "src-bare", page: "/", ts: new Date(t0 + 1000).toISOString() });
  await postJson("/api/track", { visitor_id: "src-x", page: "/", referrer: "https://twitter.com/owner/status/123", ts: new Date(t0 + 2000).toISOString() });
  await postJson("/api/track", { visitor_id: "src-hn", page: "/", referrer: "https://news.ycombinator.com/item?id=1", ts: new Date(t0 + 3000).toISOString() });
  await postJson("/api/track", { visitor_id: "src-first", page: "/", referrer: "https://www.reddit.com/r/saas/comments/1/", ts: new Date(t0 + 4000).toISOString() });
  await postJson("/api/track", { visitor_id: "src-first", page: "/pricing", utm_source: "google", utm_content: "reddit-sideproject", ts: new Date(t0 + 5000).toISOString() });

  const data5 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    visits_by_source: Array<{ bucket: string; display: string; hosts: string[]; visits_total: number; visits_7d: number; first_touch_visitors: number }>;
  };
  const src = (b: string) => data5.visits_by_source.find((x) => x.bucket === b);
  check("visits_by_source buckets google (2 existing + 1 utm second visit)",
    src("google")?.visits_total === 3, JSON.stringify(data5.visits_by_source));
  check("visits_by_source buckets bare visit → direct",
    src("direct")?.visits_total === 1 && src("direct")?.first_touch_visitors === 1, JSON.stringify(src("direct")));
  check("visits_by_source maps twitter referrer → x",
    src("x")?.visits_total === 1 && src("x")?.first_touch_visitors === 1, JSON.stringify(src("x")));
  check("visits_by_source maps news.ycombinator.com → hackernews",
    src("hackernews")?.visits_total === 1 && src("hackernews")?.first_touch_visitors === 1, JSON.stringify(src("hackernews")));
  check("visits_by_source first-touch: earliest visit (reddit referrer) wins over later utm",
    src("reddit")?.visits_total === 1 && src("reddit")?.first_touch_visitors === 1, JSON.stringify(src("reddit")));
  check("visits_by_source 7d counts include the fresh beacons",
    src("google")?.visits_7d === 3 && src("direct")?.visits_7d === 1 && src("x")?.visits_7d === 1, JSON.stringify(data5.visits_by_source));
  const ftSum = data5.visits_by_source.reduce((s, b) => s + b.first_touch_visitors, 0);
  check("visits_by_source first-touch visitors sum to distinct visitors (5)",
    ftSum === 5, `sum=${ftSum}`);

  // Per-bucket detail: friendly display names + raw referrer hosts behind each
  // bucket (utm+referrer combos included — the google bucket's visits carry
  // referrer https://google.com, so its hosts must include google.com).
  check("visits_by_source buckets carry display names",
    src("x")?.display === "X / Twitter" && src("hackernews")?.display === "Hacker News" &&
    src("direct")?.display === "Direct" && src("google")?.display === "Google",
    JSON.stringify(data5.visits_by_source.map((b) => b.display)));
  check("visits_by_source buckets carry raw referrer hosts (utm+referrer combo)",
    Array.isArray(src("google")?.hosts) && src("google")?.hosts.includes("google.com") &&
    Array.isArray(src("x")?.hosts) && src("x")?.hosts.includes("twitter.com") &&
    Array.isArray(src("hackernews")?.hosts) && src("hackernews")?.hosts.includes("news.ycombinator.com"),
    JSON.stringify(data5.visits_by_source.map((b) => ({ bucket: b.bucket, hosts: b.hosts }))));
  check("direct bucket has an empty hosts array",
    Array.isArray(src("direct")?.hosts) && src("direct")?.hosts.length === 0,
    JSON.stringify(src("direct")));

  // utm_content is surfaced in the raw visits list (post-level attribution).
  const data6 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    visits: Array<{ visitor_id: string; utm_content: string }>;
  };
  check("admin/data visits list surfaces utm_content",
    data6.visits.some((v) => v.visitor_id === "src-first" && v.utm_content === "reddit-sideproject"),
    JSON.stringify(data6.visits.find((v) => v.visitor_id === "src-first")));

  // The admin HTML renders the source table (markup present in the served page).
  r = await fetch(`${BASE}/admin?token=${TOKEN}`);
  const html2 = await r.text();
  check("admin page renders the visits-by-source table",
    html2.includes("Visits by source") && html2.includes("sourceBuckets") && html2.includes("First-touch"),
    "source table markup missing");
  check("admin page renders the Referrer(s) detail column",
    html2.includes("Referrer(s)") && html2.includes("hosts"),
    "referrer(s) column markup missing");
  check("admin page renders the Recent visits panel (local time + truncation helper)",
    html2.includes("Recent visits") && html2.includes("localT") && html2.includes("trunc("),
    "recent visits markup missing");
  check("admin page renders the UTM campaigns panel markup",
    html2.includes("UTM campaigns") && html2.includes("utmCampaigns") && html2.includes("utmCampaignsPanel"),
    "utm campaigns markup missing");

  // ── (i) utm_campaigns rollup in /admin/data ──
  // Seed campaign-tagged visits: "banner" (3 visits from one visitor, medium
  // display, one row also carrying an HN referrer to prove utm-bucket hosts
  // still capture it) and "zzz" (1 visit, medium email) — plus the earlier
  // "launch" rows (2 visits, medium cpc). utm_source=newsletter keeps these
  // rows out of the existing channel buckets' assertions.
  const t1 = Date.now() + 20000;
  await postJson("/api/track", { visitor_id: "camp-b", page: "/", utm_source: "newsletter", utm_medium: "display", utm_campaign: "banner", ts: new Date(t1 + 1000).toISOString() });
  await postJson("/api/track", { visitor_id: "camp-b", page: "/pricing", utm_source: "newsletter", utm_medium: "display", utm_campaign: "banner", ts: new Date(t1 + 2000).toISOString() });
  await postJson("/api/track", { visitor_id: "camp-b", page: "/", utm_source: "newsletter", utm_medium: "display", utm_campaign: "banner", referrer: "https://news.ycombinator.com/item?id=7", ts: new Date(t1 + 3000).toISOString() });
  await postJson("/api/track", { visitor_id: "camp-z", page: "/", utm_source: "newsletter", utm_medium: "email", utm_campaign: "zzz", ts: new Date(t1 + 4000).toISOString() });

  const data9 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    utm_campaigns: Array<{ campaign: string; medium: string; visits_total: number; visits_7d: number; first_touch_visitors: number }>;
    visits_by_source: Array<{ bucket: string; display: string; hosts: string[]; visits_total: number }>;
  };
  const camp = (c: string) => data9.utm_campaigns.find((x) => x.campaign === c);
  check("utm_campaigns sorted by visits_total desc then campaign asc",
    data9.utm_campaigns.length === 3 &&
    data9.utm_campaigns[0].campaign === "banner" && data9.utm_campaigns[0].visits_total === 3 &&
    data9.utm_campaigns[1].campaign === "launch" && data9.utm_campaigns[1].visits_total === 2 &&
    data9.utm_campaigns[2].campaign === "zzz" && data9.utm_campaigns[2].visits_total === 1,
    JSON.stringify(data9.utm_campaigns));
  check("utm_campaigns rollup shape + medium (first row seen) + 7d + first-touch",
    camp("banner")?.medium === "display" && camp("banner")?.visits_7d === 3 && camp("banner")?.first_touch_visitors === 1 &&
    camp("launch")?.medium === "cpc" && camp("launch")?.visits_7d === 2 && camp("launch")?.first_touch_visitors === 1 &&
    camp("zzz")?.medium === "email" && camp("zzz")?.visits_7d === 1 && camp("zzz")?.first_touch_visitors === 1,
    JSON.stringify(data9.utm_campaigns));
  // The newsletter rows landed in their own utm_source bucket, carrying the
  // HN referrer host (utm+referrer combo) and a title-cased display name.
  const nl = data9.visits_by_source.find((b) => b.bucket === "newsletter");
  check("newsletter bucket: 4 visits, display title-cased, hosts include the HN referrer",
    nl?.visits_total === 4 && nl?.display === "Newsletter" && nl?.hosts.includes("news.ycombinator.com"),
    JSON.stringify(nl));

  // ── (h) waitlist block in /admin/data ──
  // Seed two signups directly in the DB (the admin suite has no public
  // waitlist endpoint dependency — the waitlist suite owns that path). Each
  // carries attribution: wl-two is a utm_source=x signup that arrived via a
  // t.co link (bucket "x", host "t.co"); wl-one came from a reddit.com
  // referrer with no utm (bucket "reddit", host "reddit.com").
  {
    const d = new Database(DB_PATH);
    d.run(
      "INSERT OR IGNORE INTO waitlist (email, referrer, utm_source, utm_medium, utm_campaign, utm_content, visitor_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["wl-one@example.com", "https://reddit.com/r/saas/comments/1/", "", "", "", "", "vid-wl-one"],
    );
    d.run(
      "INSERT OR IGNORE INTO waitlist (email, referrer, utm_source, utm_medium, utm_campaign, utm_content, visitor_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["wl-two@example.com", "https://t.co/xyz", "x", "social", "launch", "hero", "vid-wl-two"],
    );
    // Deterministic ordering: wl-two is newer by id AND created_at.
    d.run("UPDATE waitlist SET created_at = datetime('now', '+1 minute') WHERE email = 'wl-two@example.com'");
    d.close();
  }
  const data7 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    waitlist: { total: number; entries: Array<{
      id: number; email: string; created_at: string;
      referrer: string; utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string; visitor_id: string;
      source_bucket: string; display: string; hosts: string[];
    }> };
  };
  check("admin/data waitlist total matches seeded rows",
    data7.waitlist.total === 2, JSON.stringify(data7.waitlist));
  check("admin/data waitlist entries newest first with id/email/created_at",
    data7.waitlist.entries.length === 2 &&
    data7.waitlist.entries[0].email === "wl-two@example.com" &&
    data7.waitlist.entries[1].email === "wl-one@example.com" &&
    typeof data7.waitlist.entries[0].id === "number" &&
    typeof data7.waitlist.entries[0].created_at === "string" &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(data7.waitlist.entries[0].created_at),
    JSON.stringify(data7.waitlist));
  const wl0 = data7.waitlist.entries[0];
  const wl1 = data7.waitlist.entries[1];
  check("admin/data waitlist entry carries source attribution (utm x + t.co referrer → X / Twitter over t.co)",
    wl0.source_bucket === "x" && wl0.display === "X / Twitter" &&
    Array.isArray(wl0.hosts) && wl0.hosts.length === 1 && wl0.hosts[0] === "t.co" &&
    wl0.utm_source === "x" && wl0.utm_medium === "social" && wl0.utm_campaign === "launch" &&
    wl0.utm_content === "hero" && wl0.visitor_id === "vid-wl-two" &&
    typeof wl0.id === "number" && wl0.email === "wl-two@example.com" &&
    typeof wl0.created_at === "string",
    JSON.stringify(wl0));
  check("admin/data waitlist entry carries source attribution (reddit referrer → Reddit over reddit.com)",
    wl1.source_bucket === "reddit" && wl1.display === "Reddit" &&
    Array.isArray(wl1.hosts) && wl1.hosts.length === 1 && wl1.hosts[0] === "reddit.com" &&
    wl1.referrer === "https://reddit.com/r/saas/comments/1/" && wl1.utm_source === "",
    JSON.stringify(wl1));

  // Cap: entries limited to the latest 500 even when the table holds more.
  {
    const d = new Database(DB_PATH);
    for (let i = 0; i < 501; i++) {
      d.run("INSERT OR IGNORE INTO waitlist (email) VALUES (?)", [`wl-cap-${i}@example.com`]);
    }
    d.close();
  }
  const data8 = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    waitlist: { total: number; entries: Array<{
      email: string; source_bucket: string; display: string; hosts: string[];
    }> };
  };
  check("admin/data waitlist total counts ALL signups (503)",
    data8.waitlist.total === 503, JSON.stringify(data8.waitlist));
  check("admin/data waitlist entries capped at latest 500",
    data8.waitlist.entries.length === 500 &&
    data8.waitlist.entries[0].email === "wl-cap-500@example.com" &&
    !data8.waitlist.entries.some((e) => e.email === "wl-one@example.com"),
    JSON.stringify(data8.waitlist.entries[0]));
  // Referrer-less cap rows attribute to the direct bucket with an empty hosts
  // array (matching the visits-by-source direct convention).
  check("admin/data waitlist referrer-less entry → direct / empty hosts",
    data8.waitlist.entries[0].source_bucket === "direct" &&
    data8.waitlist.entries[0].display === "Direct" &&
    Array.isArray(data8.waitlist.entries[0].hosts) && data8.waitlist.entries[0].hosts.length === 0,
    JSON.stringify(data8.waitlist.entries[0]));

  // The admin HTML renders the waitlist panel + local-time helper markup.
  r = await fetch(`${BASE}/admin?token=${TOKEN}`);
  const html3 = await r.text();
  check("admin page renders the waitlist section",
    html3.includes("Waitlist signups") && html3.includes("No waitlist signups yet") && html3.includes("localT"),
    "waitlist markup missing");
  check("admin page waitlist table has the Source column (header + 4-cell empty state)",
    html3.includes("<th>Source</th>") && html3.includes('colspan="4"') && html3.includes("source_bucket"),
    "source column markup missing");

  // ── (c2) /api/track accepts DASHBOARD page paths (product activation) ──
  // The dashboard beacon (app/src/ui/dashboard.html + list-page.html) posts the
  // REAL pathname (/dashboard, /reminders, /past-due) to the SAME /api/track
  // endpoint, so activation (signup → opens the dashboard) is measurable in the
  // admin dashboard — same page_visits storage, same cc_vid, same cc_skip.
  // Runs at the END so these extra direct/no-utm visits + the new visitor do
  // not perturb the source-attribution count assertions above.
  const dv = "22222222-3333-4444-8555-666666666666";
  const totalBefore = (q("SELECT COUNT(*) AS n FROM page_visits")[0] as { n: number }).n;
  r = await postJson("/api/track", { visitor_id: dv, page: "/dashboard", ts: new Date(Date.now() + 2000).toISOString() });
  check("track dashboard page /dashboard → 200", r.status === 200, `got ${r.status}`);
  r = await postJson("/api/track", { visitor_id: dv, page: "/reminders", ts: new Date(Date.now() + 3000).toISOString() });
  check("track list page /reminders → 200", r.status === 200, `got ${r.status}`);
  r = await postJson("/api/track", { visitor_id: dv, page: "/past-due", ts: new Date(Date.now() + 4000).toISOString() });
  check("track list page /past-due → 200", r.status === 200, `got ${r.status}`);
  const dash = q("SELECT page FROM page_visits WHERE visitor_id = ? ORDER BY id ASC", dv) as Array<{ page: string }>;
  check("dashboard pages all stored in page_visits",
    dash.length === 3 &&
    dash.some((x) => x.page === "/dashboard") &&
    dash.some((x) => x.page === "/reminders") &&
    dash.some((x) => x.page === "/past-due"),
    JSON.stringify(dash.map((x) => x.page)));
  const totalAfter = (q("SELECT COUNT(*) AS n FROM page_visits")[0] as { n: number }).n;
  check("dashboard beacons added exactly 3 page_visits rows",
    totalAfter === totalBefore + 3, `before=${totalBefore} after=${totalAfter}`);
  // They surface in the admin rollup: funnel totals + the recent-visits list.
  const dataDash = (await (await fetch(`${BASE}/admin/data?token=${TOKEN}`)).json()) as {
    funnel: { visits_total: number; visits_24h: number };
    visits: Array<Record<string, unknown>>;
  };
  check("admin recent-visits list contains the dashboard page",
    dataDash.visits.some((v) => v.page === "/dashboard"),
    JSON.stringify((dataDash.visits as Array<{ page: unknown }>).map((v) => String(v.page ?? ""))));
  check("admin recent-visits list contains /reminders + /past-due",
    dataDash.visits.some((v) => v.page === "/reminders") && dataDash.visits.some((v) => v.page === "/past-due"),
    JSON.stringify((dataDash.visits as Array<{ page: unknown }>).map((v) => String(v.page ?? ""))));
  // The rendered dashboard HTML carries the beacon (fires on load, posts the
  // real pathname, reuses cc_vid, honors cc_skip). /dashboard is served by the
  // backend for anyone (the session guard is client-side); /reminders|/past-due
  // require a session, so assert the shared list-page TEMPLATE embeds it too.
  const dashHtml = await (await fetch(`${BASE}/dashboard`)).text();
  check("served /dashboard HTML embeds the tracking beacon",
    dashHtml.indexOf("navigator.sendBeacon('/api/track'") !== -1, "beacon missing");
  const dashTpl = readFileSync(join(import.meta.dir, "src", "ui", "dashboard.html"), "utf-8");
  check("dashboard.html template embeds the tracking beacon",
    dashTpl.indexOf("navigator.sendBeacon('/api/track'") !== -1, "beacon missing");
  const listTpl = readFileSync(join(import.meta.dir, "src", "ui", "list-page.html"), "utf-8");
  check("list-page.html template embeds the tracking beacon (for /reminders + /past-due)",
    listTpl.indexOf("navigator.sendBeacon('/api/track'") !== -1, "beacon missing");
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll admin/track checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error("Suite crashed:", err); process.exit(1); });
