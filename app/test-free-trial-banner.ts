/**
 * Free-trial banner / /subscription trial-state tests.
 *
 * Every newly connected merchant is inside an automatic 30-day FULL-ACCESS
 * free trial anchored to merchants.created_at (FREE_TRIAL_DAYS = 30 in
 * db.ts, isWithinFreeTrial helper). There was no user-facing trial signal on
 * the dashboard, so:
 *   - GET /subscription now exposes `free_trial` (same isWithinFreeTrial
 *     source as /stats -> free_trial) — true only while in-window AND not an
 *     active subscriber AND not a dev-preview merchant.
 *   - The dashboard home screen renders a small trial banner driven by that
 *     flag (renderTrialBanner in dashboard.html), hidden by default in the
 *     markup so it never flashes, and toggled off automatically on expiry,
 *     on subscribe, and for dev-preview merchants.
 *
 * This suite proves:
 *   - in-window merchant: /subscription free_trial === true (and /stats
 *     agrees, so the two banner sources can't diverge)
 *   - expired merchant (created_at -31 days): free_trial === false
 *   - exact-boundary merchant (created_at -30 days): free_trial === false
 *     (strict-< semantics — at exactly 30 days the window has elapsed)
 *   - fresh merchant WITH an active subscription: free_trial === false and
 *     the subscription fields still come through intact (backward compat)
 *   - fresh merchant with a CANCELLED subscription: free_trial === true
 *     (trial still applies when no ACTIVE sub)
 *   - dev-preview merchant (dev_pro=1, fresh): free_trial === false and the
 *     dev Pro shape is unchanged
 *   - the served dashboard HTML contains the trial banner element, hidden by
 *     default (style="display:none"), wired to renderTrialBanner() with a
 *     "Pick a plan" CTA (scrollToPricing), and the stale "founders see their
 *     locked-in 50% price" comment is gone (replaced with current pricing
 *     reality after the founding offer was removed).
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-free-trial-banner.db).
 * Run via:
 *
 *   /tmp/run-suite.sh free-trial-banner
 *
 * (boots an isolated server on port 3100 with a fresh DB and stripped
 * email-provider keys), or manually with:
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-free-trial-banner.db bun run test-free-trial-banner.ts
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const SESSION = "test-free-trial-banner-session";

// Dedicated merchants, one per state (never collide with placeholder users).
const M_IN = 201; // in-window (created now)
const M_EX = 202; // expired (created 31 days ago)
const M_BOUND = 203; // exact boundary (created 30 days ago)
const M_SUB = 204; // fresh + ACTIVE subscription
const M_CANCEL = 205; // fresh + CANCELLED subscription
const M_DEV = 206; // dev-preview (dev_pro=1)

function db(): Database {
  // Bun 1.3.x throws SQLITE_MISUSE when options contain `create: false` —
  // use the default constructor (the server already created the file).
  return new Database(DB_PATH);
}

function seedMerchants(): void {
  const d = db();
  // NOTE: created_at must be a SQL datetime expression INLINE in the SQL text
  // (never a bound parameter — a bound parameter stores the literal string
  // "datetime('now')", which isWithinFreeTrial then can't parse).
  const insert = (id: number, acct: string, createdSql: string, devPro = 0) => {
    d.run(
      `INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, drafts_used, dev_pro, created_at)
       VALUES (?, ?, ?, 'draft', 0, ?, ${createdSql})`,
      [id, acct, `trial${id}@example.com`, devPro]
    );
    d.run(
      "INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
      [`${SESSION}-${id}`, id]
    );
  };
  insert(M_IN, "acct_trial_in", "datetime('now')");
  insert(M_EX, "acct_trial_ex", "datetime('now', '-31 days')");
  insert(M_BOUND, "acct_trial_bound", "datetime('now', '-30 days')");
  insert(M_SUB, "acct_trial_sub", "datetime('now')");
  insert(M_CANCEL, "acct_trial_cancel", "datetime('now')");
  insert(M_DEV, "acct_trial_dev", "datetime('now')", 1);
  d.run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_trial_std', 'standard', 'active')",
    [M_SUB]
  );
  d.run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_trial_cancel', 'pro', 'cancelled')",
    [M_CANCEL]
  );
  d.close();
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  }
}

async function getAuthed(path: string, merchantId: number): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { Cookie: `session=${SESSION}-${merchantId}` },
  });
}

async function subscription(merchantId: number): Promise<any> {
  const res = await getAuthed("/subscription", merchantId);
  if (!res.ok) throw new Error(`GET /subscription -> HTTP ${res.status}`);
  return res.json();
}

async function stats(merchantId: number): Promise<any> {
  const res = await getAuthed("/stats", merchantId);
  if (!res.ok) throw new Error(`GET /stats -> HTTP ${res.status}`);
  return res.json();
}

async function main(): Promise<void> {
  seedMerchants();

  // 1. In-window: free_trial true on /subscription, and /stats agrees.
  const inSub = await subscription(M_IN);
  check("1a in-window /subscription free_trial === true", inSub.free_trial === true, inSub);
  check("1b in-window /subscription shape: tier null, status none", inSub.tier === null && inSub.status === "none", inSub);
  const inStats = await stats(M_IN);
  check("1c in-window /stats free_trial === true (same source, no divergence)", inStats.free_trial === true, inStats);
  check("1d in-window /stats + /subscription agree", inStats.free_trial === inSub.free_trial, { stats: inStats.free_trial, sub: inSub.free_trial });

  // 2. Expired: banner flag must be off.
  const exSub = await subscription(M_EX);
  check("2a expired /subscription free_trial === false", exSub.free_trial === false, exSub);
  const exStats = await stats(M_EX);
  check("2b expired /stats free_trial === false", exStats.free_trial === false, exStats);

  // 3. Exact boundary (30 days): strict-< semantics → window elapsed.
  const bSub = await subscription(M_BOUND);
  check("3a boundary (-30d) free_trial === false", bSub.free_trial === false, bSub);

  // 4. Active subscription: banner must hide even though the trial window
  //    would still be open (active subscriber always wins). Backward compat:
  //    subscription fields still present.
  const subSub = await subscription(M_SUB);
  check("4a subscribed free_trial === false", subSub.free_trial === false, subSub);
  check("4b subscribed shape intact (tier standard, status active)", subSub.tier === "standard" && subSub.status === "active", subSub);
  check("4c subscribed created_at still returned", typeof subSub.created_at === "string", subSub.created_at);

  // 5. Cancelled subscription: no ACTIVE sub → trial still in effect.
  const cnSub = await subscription(M_CANCEL);
  check("5a cancelled + in-window free_trial === true", cnSub.free_trial === true, cnSub);
  check("5b cancelled shape (tier pro, status cancelled)", cnSub.tier === "pro" && cnSub.status === "cancelled", cnSub);

  // 6. Dev preview: never "in trial".
  const devSub = await subscription(M_DEV);
  check("6a dev_pro free_trial === false", devSub.free_trial === false, devSub);
  check("6b dev_pro shape intact (dev_pro true, status active)", devSub.dev_pro === true && devSub.status === "active" && devSub.tier === "pro", devSub);

  // 7. Dashboard static wiring: the banner element ships hidden by default,
  //    is wired to renderTrialBanner()/scrollToPricing(), and the stale
  //    founders comment is gone.
  const dashRes = await fetch(`${BASE}/dashboard`);
  check("7a /dashboard serves 200", dashRes.status === 200);
  const html = await dashRes.text();
  check("7b banner element present (id=trial-banner)", html.includes('id="trial-banner"'));
  check("7c banner hidden by default (style=display:none)", html.includes('id="trial-banner" style="display:none;"'));
  check("7d banner wired to renderTrialBanner()", html.includes("renderTrialBanner(sub)"));
  check("7e banner has Pick-a-plan CTA + scrollToPricing()", html.includes('onclick="scrollToPricing()"') && html.includes("Pick a plan"));
  check("7f banner copy mentions 30-day trial + no card", html.includes("Free 30-day trial") && html.includes("no card needed"));
  check("7g stale founders comment removed", !html.includes("lock-in") && !html.includes("locked-in 50%"));
  check("7h pricing comment now states founding offer removed", html.includes("founding 50% offer was removed") && html.includes("there is no founder") && html.includes("pricing to special-case"));

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SUITE CRASH:", e);
  process.exit(2);
});