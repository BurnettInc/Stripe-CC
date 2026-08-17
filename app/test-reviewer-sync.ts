/**
 * Reviewer discount pre-attach + invoice sync tests (review-blocker fixes A & B, 2026-08).
 *
 * Contract under test:
 *
 * (A) Reviewer checkout discount — the Stripe review harness must be able to
 *     subscribe with a $0 session. Manual promo entry in live Checkout on this
 *     account rejects EVERY code with "This code is invalid" (dahlia-era
 *     behavior, reproduced live), so the discount is PRE-ATTACHED server-side
 *     via discounts[0][promotion_code]. Two scoped triggers:
 *       1. explicit opt-in: ?promo=REVIEWER100 (GET) / {promo:"REVIEWER100"}
 *          (POST) — the documented reviewer path;
 *       2. a TEST-mode marketplace install (oauth_tokens.livemode=0) — the
 *          review harness installs in test mode, so their Settings → Subscribe
 *          (POST /billing/checkout, JSON) must produce a $0 session with zero
 *          extra steps. Real customers (live installs / web connect) never
 *          match, and default checkouts keep allow_promotion_codes=true.
 *
 * (B) Invoice sync — invoices created in Stripe AFTER the marketplace install
 *     never reached the pipeline (install backfill is a one-shot snapshot, no
 *     per-merchant webhook registration). syncMerchantInvoices re-runs the
 *     same idempotent backfill with the merchant's STORED OAuth token:
 *       - POST /invoices/sync (manual sync, E2E target) requires auth;
 *       - never errors for a merchant with no connection token (skips, ok:true);
 *       - skips disconnected merchants;
 *       - with a stored token it pulls invoices into the invoices table;
 *       - sync NEVER creates reminder_tasks (task creation stays webhook-only);
 *       - GET /stats (dashboard load) triggers the same best-effort sync and
 *         still returns 200 with the freshly synced totals.
 *
 * Stripe is stubbed by an in-process HTTP server on STRIPE_STUB_PORT (3199);
 * the app server MUST be booted with STRIPE_API_BASE pointing at the stub and
 * a dummy STRIPE_SECRET_KEY (see /tmp/run-suite.sh reviewer-sync):
 *
 *   STRIPE_API_BASE=http://localhost:3199/v1 STRIPE_SECRET_KEY=sk_test_stub \
 *     TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-reviewer-sync.db \
 *     bun run test-reviewer-sync.ts
 *
 * The REVIEWER_PROMO_CODE_ID constant is verified live (2026-08-17):
 *   GET /v1/promotion_codes/promo_1U5PYjAD4cJGS9Cro4A2TdbI
 *     → { code: "REVIEWER100", active: true, livemode: true }
 *   GET /v1/coupons/REVIEWER100 → { percent_off: 100.0, duration: "forever", valid: true }
 * (The earlier candidate promo_1U5FYjAD4cJGS9Cro4l2A2TbbI does NOT exist in
 * live mode — "No such promotion code" — so the code uses the verified one.)
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-reviewer-sync.db";
const SESSION = "reviewer-sync-session";
const STRIPE_STUB_PORT = 3199;
const REVIEWER_PROMO_CODE_ID = "promo_1U5PYjAD4cJGS9Cro4A2TdbI";

let passed = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`PASS  ${label}`); }
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}

// ── In-process Stripe stub ─────────────────────────────────────────────
// Records every checkout-session creation's form params (so tests can assert
// the discount attach + allow_promotion_codes flag) and counts invoice-list
// fetches (so tests can prove the on-load sync actually ran).
const stub: {
  checkoutCalls: URLSearchParams[];
  invoiceFetches: number;
  invoices: Record<string, unknown>[];
  server: ReturnType<typeof Bun.serve>;
} = {
  checkoutCalls: [],
  invoiceFetches: 0,
  invoices: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};
function resetStub(): void {
  stub.checkoutCalls = [];
  stub.invoiceFetches = 0;
  stub.invoices = [];
}
function lastCheckoutParams(): URLSearchParams {
  return stub.checkoutCalls[stub.checkoutCalls.length - 1] ?? new URLSearchParams();
}
stub.server = Bun.serve({
  port: STRIPE_STUB_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // Checkout session creation (billing.ts calls this via raw fetch on STRIPE_API)
    if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
      const params = new URLSearchParams(await req.text());
      stub.checkoutCalls.push(params);
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_reviewer", id: "cs_test_reviewer" });
    }
    // Invoice list (backfillMerchantInvoices uses the merchant's OAuth token)
    if (url.pathname === "/v1/invoices" && req.method === "GET") {
      stub.invoiceFetches++;
      return Response.json({ data: stub.invoices, has_more: false });
    }
    return Response.json(
      { error: { type: "invalid_request_error", message: `stub: not found ${req.method} ${url.pathname}` } },
      { status: 404 }
    );
  },
});

// ── Seed helpers (merchant 1 is the ensureDefaultMerchant placeholder) ──
function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.close();
}
/** Strip every connection/install/disconnect state so a check starts neutral. */
function clearInstallState(): void {
  const d = db();
  d.run("DELETE FROM oauth_tokens");
  d.run("DELETE FROM stripe_connections");
  d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
  d.close();
}
/** A TEST-mode marketplace install (livemode=0) — the reviewer harness signal. */
function seedTestModeInstall(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO oauth_tokens (stripe_user_id, merchant_id, access_token, refresh_token, stripe_publishable_key, livemode, link_type, expires_at) VALUES (?, 1, ?, ?, ?, 0, 'test', datetime('now','+1 hour'))",
    ["acct_test_install", "tok_test", "rt_test", "pk_test_x"]
  );
  d.close();
}
/** A stored (plaintext — no TOKEN_ENCRYPTION_KEY on the suite server) OAuth
 *  connection token, as saved by the marketplace-install callback. */
function seedStoredConnection(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES (?, 1, ?, NULL, 'pk_test_x')",
    ["acct_sync_merchant", "tok_sync"]
  );
  d.close();
}
function countInvoices(merchantId = 1): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) as count FROM invoices WHERE merchant_id=?").get(merchantId) as { count: number };
  d.close();
  return row.count;
}
function countTasks(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) as count FROM reminder_tasks").get() as { count: number };
  d.close();
  return row.count;
}

// ── HTTP helpers ───────────────────────────────────────────────────────
const authHeaders = { Cookie: `session=${SESSION}` };
function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers, redirect: "manual" });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ── Checkout discount pre-attach (blocker A) ───────────────────────────
async function run(): Promise<void> {
  seedSession();
  clearInstallState();
  resetStub();

  // 1. GET explicit promo opt-in: ?promo=REVIEWER100 → discount pre-attached.
  {
    const res = await get("/billing/checkout?tier=standard&promo=REVIEWER100", authHeaders);
    const p = lastCheckoutParams();
    check("A1 GET ?promo=REVIEWER100 → 302 to Stripe Checkout", res.status === 302, `status=${res.status}`);
    check("A1 GET ?promo=REVIEWER100 → Location is the stub checkout URL", res.headers.get("location") === "https://checkout.stripe.com/c/pay/cs_test_reviewer", String(res.headers.get("location")));
    check("A1 GET ?promo=REVIEWER100 → session carries discounts[0][promotion_code]", p.get("discounts[0][promotion_code]") === REVIEWER_PROMO_CODE_ID, String(p.get("discounts[0][promotion_code]")));
    check("A1 GET ?promo=REVIEWER100 → allow_promotion_codes turned OFF", p.get("allow_promotion_codes") === "false", String(p.get("allow_promotion_codes")));
  }

  // 2. GET without promo (no test-mode install) → real-customer path unchanged.
  {
    const before = stub.checkoutCalls.length;
    const res = await get("/billing/checkout?tier=standard", authHeaders);
    const p = lastCheckoutParams();
    check("A2 GET plain → 302 to Stripe Checkout", res.status === 302, `status=${res.status}`);
    check("A2 GET plain → NO discount attached", p.get("discounts[0][promotion_code]") === null, String(p.get("discounts[0][promotion_code]")));
    check("A2 GET plain → allow_promotion_codes stays TRUE", p.get("allow_promotion_codes") === "true", String(p.get("allow_promotion_codes")));
    check("A2 GET plain → a checkout was created", stub.checkoutCalls.length === before + 1, `calls=${stub.checkoutCalls.length}`);
  }

  // 3. POST for a TEST-mode marketplace install (the reviewer's actual
  //    Settings → Subscribe path) → discount pre-attached, $0 session.
  {
    seedTestModeInstall();
    const res = await post("/billing/checkout", { tier: "standard" }, authHeaders);
    const body = await res.json().catch(() => ({})) as { url?: string };
    const p = lastCheckoutParams();
    check("A3 POST test-mode install → 200 {url}", res.status === 200 && typeof body.url === "string", `status=${res.status} body=${JSON.stringify(body).slice(0, 120)}`);
    check("A3 POST test-mode install → session carries discounts[0][promotion_code]", p.get("discounts[0][promotion_code]") === REVIEWER_PROMO_CODE_ID, String(p.get("discounts[0][promotion_code]")));
    check("A3 POST test-mode install → allow_promotion_codes turned OFF", p.get("allow_promotion_codes") === "false", String(p.get("allow_promotion_codes")));
  }

  // 4. POST explicit promo param → discount pre-attached.
  {
    const res = await post("/billing/checkout", { tier: "pro", promo: "REVIEWER100" }, authHeaders);
    const body = await res.json().catch(() => ({})) as { url?: string };
    const p = lastCheckoutParams();
    check("A4 POST {promo:REVIEWER100} → 200 {url}", res.status === 200 && typeof body.url === "string", `status=${res.status}`);
    check("A4 POST {promo:REVIEWER100} → session carries discounts[0][promotion_code]", p.get("discounts[0][promotion_code]") === REVIEWER_PROMO_CODE_ID, String(p.get("discounts[0][promotion_code]")));
    check("A4 POST {promo:REVIEWER100} → allow_promotion_codes turned OFF", p.get("allow_promotion_codes") === "false", String(p.get("allow_promotion_codes")));
  }

  // 5. GET without a session → branded sign-in page (fail-closed stays intact).
  {
    const res = await get("/billing/checkout?tier=standard");
    const text = await res.text();
    check("A5 GET no session → 200 HTML sign-in page", res.status === 200 && text.includes("Sign in to continue"), `status=${res.status}`);
  }

  // ── Invoice sync (blocker B) ─────────────────────────────────────────
  // 6. POST /invoices/sync requires auth.
  {
    const res = await post("/invoices/sync", {});
    check("B1 POST /invoices/sync without session → 401", res.status === 401, `status=${res.status}`);
  }

  // 7. No connection token → ok:true, skipped, never an error.
  {
    clearInstallState();
    const res = await post("/invoices/sync", {}, authHeaders);
    const body = await res.json().catch(() => ({})) as { ok?: boolean; synced?: boolean; reason?: string };
    check("B2 POST /invoices/sync no connection → 200", res.status === 200, `status=${res.status}`);
    check("B2 POST /invoices/sync no connection → {ok:true, synced:false, reason:no-connection}", body.ok === true && body.synced === false && body.reason === "no-connection", JSON.stringify(body));
    check("B2 POST /invoices/sync no connection → no Stripe fetch attempted", stub.invoiceFetches === 0, `fetches=${stub.invoiceFetches}`);
  }

  // 8. Disconnected merchant → ok:true, skipped, never an error.
  {
    const d = db();
    d.run("UPDATE merchants SET disconnected=1 WHERE id=1");
    d.close();
    const res = await post("/invoices/sync", {}, authHeaders);
    const body = await res.json().catch(() => ({})) as { ok?: boolean; synced?: boolean; reason?: string };
    check("B3 POST /invoices/sync disconnected → {ok:true, synced:false, reason:disconnected}", body.ok === true && body.synced === false && body.reason === "disconnected", JSON.stringify(body));
    check("B3 POST /invoices/sync disconnected → no Stripe fetch attempted", stub.invoiceFetches === 0, `fetches=${stub.invoiceFetches}`);
  }

  // 9. Stored token + 2 new invoices → pulled in; tasks NEVER created by sync.
  {
    clearInstallState();
    seedStoredConnection();
    const nowSec = Math.floor(Date.now() / 1000);
    stub.invoices = [
      { id: "in_after_connect_1", status: "open", amount_due: 4500, currency: "usd", customer_name: "Acme", customer_email: "acme@example.com", created: nowSec - 86400, due_date: nowSec - 43200 },
      { id: "in_after_connect_2", status: "open", amount_due: 9900, currency: "usd", customer_name: "Beta", customer_email: "beta@example.com", created: nowSec, due_date: nowSec + 86400 },
    ];
    const res = await post("/invoices/sync", {}, authHeaders);
    const body = await res.json().catch(() => ({})) as { ok?: boolean; synced?: boolean; inserted?: number };
    check("B4 POST /invoices/sync with token → {ok:true, synced:true, inserted:2}", body.ok === true && body.synced === true && body.inserted === 2, JSON.stringify(body));
    check("B4 POST /invoices/sync with token → invoices table has the 2 pulled rows", countInvoices() === 2, `count=${countInvoices()}`);
    check("B4 POST /invoices/sync with token → stripe was fetched exactly once", stub.invoiceFetches === 1, `fetches=${stub.invoiceFetches}`);
    check("B4 POST /invoices/sync with token → sync NEVER creates reminder_tasks", countTasks() === 0, `tasks=${countTasks()}`);
  }

  // 10. GET /stats (dashboard load) triggers the on-load sync and stays 200.
  {
    const res = await get("/stats", authHeaders);
    const body = await res.json().catch(() => ({})) as { totalInvoices?: number };
    check("B5 GET /stats → 200 JSON", res.status === 200, `status=${res.status}`);
    check("B5 GET /stats → on-load sync ran (second invoice fetch)", stub.invoiceFetches === 2, `fetches=${stub.invoiceFetches}`);
    check("B5 GET /stats → totalInvoices reflects the synced rows", body.totalInvoices === 2, `totalInvoices=${body.totalInvoices}`);
    check("B5 GET /stats → sync still never creates reminder_tasks", countTasks() === 0, `tasks=${countTasks()}`);
  }

  console.log(`\nRESULTS: ${passed} passed, ${failures} failed`);
  stub.server.stop(true);
  if (failures > 0) process.exit(1);
}

run().catch((err) => {
  console.error("SUITE CRASHED:", err);
  stub.server.stop(true);
  process.exit(2);
});
