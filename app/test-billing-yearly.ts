/**
 * test-billing-yearly.ts — billing suite: yearly plans + repriced plans
 * (Standard $7/mo or $50/yr, Pro $15/mo or $100/yr; founding offer removed
 * 2026-08-26).
 *
 * Covers, over HTTP against an isolated app server (see /tmp/run-suite.sh
 * billing-yearly — boots with STRIPE_API_BASE pointed at the in-process stub
 * so no real Stripe API call can escape):
 *
 *   (a) auth gate intact: anonymous GET → branded sign-in page, anonymous
 *       POST → 401 (no regression from the interval/reprice changes);
 *   (b) month default unchanged: no interval param → MONTHLY price ids;
 *   (c) yearly checkout picks the YEARLY price ids ($50/$100);
 *   (d) interval validation: "weekly" → 400 before any Stripe call; bad tier
 *       → 400;
 *   (e) reviewer discount path still works (promo=REVIEWER100 attaches the
 *       reviewer promo; NO coupon is ever attached now that the founding offer
 *       is gone);
 *   (f) /subscription no longer exposes founding fields (offer removed);
 *   (g) interval=year passthrough + webhook interval recording unchanged.
 *
 * Stripe objects under test (LIVE mode — checkout always uses the live key):
 *   monthly standard price_1U8VZyAD4cJGS9CrReqgDCtd / pro price_1U8VZyAD4cJGS9CroFf7Znpm
 *   yearly  standard price_1U8VZyAD4cJGS9Cru85iFOEh / pro price_1U8VZyAD4cJGS9CrcW0OHVVB
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-billing-yearly.db";
const SESSION = "billing-yearly-session";
const STRIPE_STUB_PORT = 3199;

const MONTH_STD = "price_1U8VZyAD4cJGS9CrReqgDCtd";
const MONTH_PRO = "price_1U8VZyAD4cJGS9CroFf7Znpm";
const YEAR_STD = "price_1U8VZyAD4cJGS9Cru85iFOEh";
const YEAR_PRO = "price_1U8VZyAD4cJGS9CrcW0OHVVB";
const REVIEWER_PROMO_ID = "promo_1U5PYjAD4cJGS9Cro4A2TdbI";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database { return new Database(DB_PATH); }

// ── In-process Stripe stub ──────────────────────────────────────────────
const stub: {
  checkoutCalls: string[];
  server: ReturnType<typeof Bun.serve>;
} = {
  checkoutCalls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};
function lastCheckoutParams(): URLSearchParams | null {
  if (stub.checkoutCalls.length === 0) return null;
  return new URLSearchParams(stub.checkoutCalls[stub.checkoutCalls.length - 1]);
}
function resetStub(): void {
  stub.checkoutCalls = [];
}
stub.server = Bun.serve({
  port: STRIPE_STUB_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
      const body = await req.text();
      stub.checkoutCalls.push(body);
      return Response.json({ url: "https://checkout.stripe.com/c/pay/stub", id: "cs_test_stub" });
    }
    return Response.json({ error: { type: "invalid_request_error", message: `stub: not found ${req.method} ${url.pathname}` } }, { status: 404 });
  },
});

// ── Seeding ──────────────────────────────────────────────────────────────
function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.close();
}

const authHeaders = { "Content-Type": "application/json", Cookie: `session=${SESSION}` };
async function postCheckout(body: unknown): Promise<Response> {
  return fetch(`${BASE}/billing/checkout`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
}
async function postWebhook(event: { type: string; data: { object: Record<string, unknown> } }): Promise<Response> {
  return fetch(`${BASE}/billing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
}
function completedSession(obj: Record<string, unknown>): { type: string; data: { object: Record<string, unknown> } } {
  return {
    type: "checkout.session.completed",
    data: { object: { ...obj } },
  };
}

async function main(): Promise<void> {
  const warm = await fetch(`${BASE}/health`);
  if (!warm.ok) throw new Error(`server not healthy: ${warm.status}`);
  seedSession();

  // ── (a) Auth gate intact ──
  resetStub();
  {
    const anonGet = await fetch(`${BASE}/billing/checkout?tier=pro&interval=year`);
    check("(a) anonymous GET → branded sign-in page", anonGet.status === 200 && anonGet.headers.get("X-Billing-Fallback") === "sign-in-required", `status=${anonGet.status} hdr=${anonGet.headers.get("X-Billing-Fallback")}`);
    const html = await anonGet.text();
    check("(a) sign-in page mentions signing in", html.includes("Sign in to continue"), "copy missing");
    check("(a) no Stripe call from anonymous GET", stub.checkoutCalls.length === 0, JSON.stringify(stub.checkoutCalls));
  }
  {
    const anonPost = await fetch(`${BASE}/billing/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: "pro", interval: "year" }) });
    check("(a) anonymous POST → 401", anonPost.status === 401, `status=${anonPost.status}`);
    check("(a) no Stripe call from anonymous POST", stub.checkoutCalls.length === 0, JSON.stringify(stub.checkoutCalls));
  }

  // ── (b) Month default → monthly prices, no coupon ──
  resetStub();
  {
    const res = await postCheckout({ tier: "standard" });
    const p = lastCheckoutParams();
    check("(b) default month → 200", res.status === 200, `status=${res.status}`);
    check("(b) default month uses MONTHLY standard price ($7)", p?.get("line_items[0][price]") === MONTH_STD, p?.get("line_items[0][price]") ?? "no call");
    check("(b) mode=subscription unchanged", p?.get("mode") === "subscription", p?.get("mode") ?? "");
    check("(b) metadata[interval]=month on default checkout", p?.get("metadata[interval]") === "month", p?.get("metadata[interval]") ?? "no interval");
    check("(b) NO coupon attached (founding offer removed)", p?.get("discounts[0][coupon]") === null, p?.get("discounts[0][coupon]") ?? "coupon present!");
  }
  {
    const res = await postCheckout({ tier: "pro" });
    const p = lastCheckoutParams();
    check("(b) default month pro → MONTHLY pro price ($15)", res.status === 200 && p?.get("line_items[0][price]") === MONTH_PRO, `status=${res.status} price=${p?.get("line_items[0][price]")}`);
  }

  // ── (c) Yearly checkout picks the yearly prices ──
  {
    const res = await postCheckout({ tier: "standard", interval: "year" });
    const p = lastCheckoutParams();
    check("(c) yearly standard → YEARLY standard price ($50)", res.status === 200 && p?.get("line_items[0][price]") === YEAR_STD, `status=${res.status} price=${p?.get("line_items[0][price]")}`);
    check("(c) metadata[interval]=year on yearly checkout", p?.get("metadata[interval]") === "year", p?.get("metadata[interval]") ?? "no interval");
  }
  {
    const res = await postCheckout({ tier: "pro", interval: "year" });
    const p = lastCheckoutParams();
    check("(c) yearly pro → YEARLY pro price ($100)", res.status === 200 && p?.get("line_items[0][price]") === YEAR_PRO, `status=${res.status} price=${p?.get("line_items[0][price]")}`);
  }

  // ── (d) Interval validation ──
  resetStub();
  {
    const res = await postCheckout({ tier: "standard", interval: "weekly" });
    const body = await res.json() as { error?: string };
    check("(d) invalid interval → 400", res.status === 400 && body.error === "interval must be 'month' or 'year'", `status=${res.status} ${JSON.stringify(body)}`);
    check("(d) invalid interval makes no Stripe call", stub.checkoutCalls.length === 0, JSON.stringify(stub.checkoutCalls));
  }
  {
    const res = await postCheckout({ tier: "bogus", interval: "year" });
    check("(d) invalid tier → 400 (unchanged)", res.status === 400, `status=${res.status}`);
  }

  // ── (e) Reviewer discount path still works, no coupon anywhere ──
  resetStub();
  {
    const res = await postCheckout({ tier: "pro", promo: "REVIEWER100" });
    const p = lastCheckoutParams();
    check("(e) reviewer checkout → 200", res.status === 200, `status=${res.status}`);
    check("(e) reviewer promo attached", p?.get("discounts[0][promotion_code]") === REVIEWER_PROMO_ID, p?.get("discounts[0][promotion_code]") ?? "no promo");
    check("(e) NO coupon attached alongside reviewer promo", p?.get("discounts[0][coupon]") === null, p?.get("discounts[0][coupon]") ?? "coupon present!");
  }

  // ── (f) /subscription no longer exposes founding fields ──
  {
    const d = db();
    d.run("DELETE FROM subscriptions WHERE merchant_id=1");
    d.close();
    const res = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${SESSION}` } });
    const body = await res.json() as Record<string, unknown>;
    check("(f) /subscription 200", res.status === 200, `status=${res.status}`);
    check("(f) no foundingOpen field (offer removed)", body.foundingOpen === undefined, JSON.stringify(body));
    check("(f) no foundingRemaining field (offer removed)", body.foundingRemaining === undefined, JSON.stringify(body));
    check("(f) no isFounder field (offer removed)", body.isFounder === undefined, JSON.stringify(body));
  }

  // ── (g) Interval passthrough + webhook interval recording ──
  {
    const d = db();
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status, interval) VALUES (1, 'sub_dash_year', 'pro', 'active', 'year')");
    d.close();
    const res = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${SESSION}` } });
    const body = await res.json() as Record<string, unknown>;
    check("(g) interval=year on a yearly subscription row", body.interval === "year", JSON.stringify(body));
    check("(g) tier pro preserved on the row", body.tier === "pro", JSON.stringify(body));
  }
  {
    const d = db();
    d.run("DELETE FROM subscriptions WHERE merchant_id=1");
    d.close();
    const res = await postWebhook(completedSession({ id: "cs_year1", subscription: "sub_year1", customer: "cus_year1", metadata: { merchant_id: "1", tier: "standard", interval: "year" } }));
    check("(g) yearly completion → 200", res.status === 200, `status=${res.status}`);
    const row = db().query("SELECT interval FROM subscriptions WHERE stripe_subscription_id='sub_year1'").get() as { interval: string } | null;
    check("(g) subscription row interval=year recorded from metadata", row?.interval === "year", JSON.stringify(row));
  }

  stub.server.stop(true);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); stub.server?.stop(true); process.exit(2); });
