/**
 * test-billing-yearly.ts — Phase A billing suite: yearly plans + Founding
 * Member Offer (owner direction 8/13+8/14+8/17, built 2026-08-18).
 *
 * Covers, over HTTP against an isolated app server (see /tmp/run-suite.sh
 * billing-yearly — boots with STRIPE_API_BASE pointed at the in-process stub
 * so no real Stripe API call can escape):
 *
 *   (a) auth gate intact: anonymous GET → branded sign-in page, anonymous
 *       POST → 401 (no regression from the interval/founding changes);
 *   (b) month default unchanged: no interval param → MONTHLY price ids
 *       (quota-open checkout also carries the founding coupon — the intended
 *       new behavior for the first 50 signups, asserted separately);
 *   (c) yearly checkout picks the YEARLY price ids ($135/$250);
 *   (d) interval validation: "weekly" → 400 before any Stripe call;
 *   (e) founding coupon attached when quota is open (discounts[0][coupon],
 *       allow_promotion_codes dropped — Stripe rejects sessions with both);
 *   (f) an ALREADY-founder merchant keeps the coupon on new checkouts
 *       (lifetime benefit follows them across plan changes);
 *   (g) the 51st signup gets NO coupon (50 seeded rows → plain checkout);
 *   (h) reviewer discount precedence: promo=REVIEWER100 attaches the reviewer
 *       promo, never the founding coupon;
 *   (i) checkout.session.completed carrying the coupon records the founding
 *       row + priority_support_until = created_at + 90 days;
 *   (j) idempotent replay: same event → still exactly one row, no strip;
 *   (k) customer.subscription.created fallback records the slot too;
 *   (l) quota race: a completion with the coupon AFTER 50 rows → NO new row
 *       AND the subscription's discount is stripped (DELETE …/discount) so no
 *       51st subscription keeps the founding discount;
 *   (m) an already-founder completion never strips (their benefit is real).
 *
 * Stripe objects under test (LIVE mode — checkout always uses the live key):
 *   monthly standard price_1U4LUtAD4cJGS9CrkqXP6IxH / pro price_1U4LUtAD4cJGS9Cr6Gd2824F
 *   yearly  standard price_1U5ow5AD4cJGS9CrpQGTAUY8 / pro price_1U5ow5AD4cJGS9CrHFfscE7K
 *   founding coupon BIywdq7e (percent_off=50, duration=forever)
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-billing-yearly.db";
const SESSION = "billing-yearly-session";
const STRIPE_STUB_PORT = 3199;

const MONTH_STD = "price_1U4LUtAD4cJGS9CrkqXP6IxH";
const MONTH_PRO = "price_1U4LUtAD4cJGS9Cr6Gd2824F";
const YEAR_STD = "price_1U5ow5AD4cJGS9CrpQGTAUY8";
const YEAR_PRO = "price_1U5ow5AD4cJGS9CrHFfscE7K";
const FOUNDING_COUPON = "BIywdq7e";
const REVIEWER_PROMO_ID = "promo_1U5PYjAD4cJGS9Cro4A2TdbI";
const QUOTA = 50;

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database { return new Database(DB_PATH); }

// ── In-process Stripe stub ──────────────────────────────────────────────
// Records every checkout-session creation (param string) and every
// subscription-discount DELETE so tests can assert what the backend asked for.
const stub: {
  checkoutCalls: string[];
  deleteCalls: string[];
  server: ReturnType<typeof Bun.serve>;
} = {
  checkoutCalls: [],
  deleteCalls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};
function lastCheckoutParams(): URLSearchParams | null {
  if (stub.checkoutCalls.length === 0) return null;
  return new URLSearchParams(stub.checkoutCalls[stub.checkoutCalls.length - 1]);
}
function resetStub(): void {
  stub.checkoutCalls = [];
  stub.deleteCalls = [];
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
    // DELETE /v1/subscriptions/{id}/discount — founding quota-race strip
    const discountMatch = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/discount$/);
    if (discountMatch && req.method === "DELETE") {
      stub.deleteCalls.push(discountMatch[1] ?? "");
      return Response.json({ id: discountMatch[1], deleted: true, coupon: null });
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
/** Ensure merchants (2..n) exist so founding_members FKs resolve (FKs ON). */
function ensureMerchants(ids: number[]): void {
  const d = db();
  for (const id of ids) {
    d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email) VALUES (?, ?, ?)", [id, `acct_m${id}`, `m${id}@example.com`]);
  }
  d.close();
}
/** Replace ALL founding_members rows with the given (merchantId, subId) pairs. */
function seedFounding(rows: Array<{ merchantId: number; subId: string }>): void {
  const d = db();
  d.run("DELETE FROM founding_members");
  ensureMerchants(rows.map((r) => r.merchantId));
  for (const r of rows) {
    d.run(
      "INSERT INTO founding_members (merchant_id, subscription_id, priority_support_until) VALUES (?, ?, datetime('now','+90 days'))",
      [r.merchantId, r.subId]
    );
  }
  d.close();
}
function countFounding(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM founding_members").get() as { n: number };
  d.close();
  return row.n;
}
function getFoundingRow(merchantId: number): { merchant_id: number; subscription_id: string; created_at: string; priority_support_until: string } | null {
  const d = db();
  const row = d.query("SELECT * FROM founding_members WHERE merchant_id=?").get(merchantId) as
    | { merchant_id: number; subscription_id: string; created_at: string; priority_support_until: string }
    | null;
  d.close();
  return row;
}

const authHeaders = { "Content-Type": "application/json", Cookie: `session=${SESSION}` };
async function postCheckout(body: unknown): Promise<Response> {
  return fetch(`${BASE}/billing/checkout`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
}
async function postWebhook(event: { type: string; data: { object: Record<string, unknown> } }): Promise<Response> {
  return fetch(`${BASE}/billing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
}
/** checkout.session.completed event body with the founding coupon attached. */
function completedSession(obj: Record<string, unknown>): { type: string; data: { object: Record<string, unknown> } } {
  return {
    type: "checkout.session.completed",
    data: { object: { discounts: [{ coupon: { id: FOUNDING_COUPON } }], ...obj } },
  };
}

async function main(): Promise<void> {
  // First request creates the default merchant (ensureDefaultMerchant), so
  // the webhook/merchant-1 assumptions hold before we seed anything.
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

  // ── (b) Month default unchanged (quota open → founding also attaches) ──
  resetStub();
  seedFounding([]);
  {
    const res = await postCheckout({ tier: "standard" });
    const p = lastCheckoutParams();
    check("(b) default month → 200", res.status === 200, `status=${res.status}`);
    check("(b) default month uses MONTHLY standard price", p?.get("line_items[0][price]") === MONTH_STD, p?.get("line_items[0][price]") ?? "no call");
    check("(b) mode=subscription unchanged", p?.get("mode") === "subscription", p?.get("mode") ?? "");
    check("(b) metadata[interval]=month on default checkout", p?.get("metadata[interval]") === "month", p?.get("metadata[interval]") ?? "no interval");
  }
  {
    const res = await postCheckout({ tier: "pro" });
    const p = lastCheckoutParams();
    check("(b) default month pro → MONTHLY pro price", res.status === 200 && p?.get("line_items[0][price]") === MONTH_PRO, `status=${res.status} price=${p?.get("line_items[0][price]")}`);
  }

  // ── (c) Yearly checkout picks the yearly prices ──
  {
    const res = await postCheckout({ tier: "standard", interval: "year" });
    const p = lastCheckoutParams();
    check("(c) yearly standard → YEARLY standard price ($135)", res.status === 200 && p?.get("line_items[0][price]") === YEAR_STD, `status=${res.status} price=${p?.get("line_items[0][price]")}`);
    check("(c) metadata[interval]=year on yearly checkout", p?.get("metadata[interval]") === "year", p?.get("metadata[interval]") ?? "no interval");
  }
  {
    const res = await postCheckout({ tier: "pro", interval: "year" });
    const p = lastCheckoutParams();
    check("(c) yearly pro → YEARLY pro price ($250)", res.status === 200 && p?.get("line_items[0][price]") === YEAR_PRO, `status=${res.status} price=${p?.get("line_items[0][price]")}`);
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

  // ── (e) Founding coupon attached when quota open ──
  resetStub();
  seedFounding([]);
  {
    const res = await postCheckout({ tier: "pro", interval: "year" });
    const p = lastCheckoutParams();
    check("(e) quota open → 200", res.status === 200, `status=${res.status}`);
    check("(e) discounts[0][coupon] = founding coupon", p?.get("discounts[0][coupon]") === FOUNDING_COUPON, p?.get("discounts[0][coupon]") ?? "no coupon");
    check("(e) allow_promotion_codes dropped (Stripe rejects both)", p?.get("allow_promotion_codes") === null, p?.get("allow_promotion_codes") ?? "present");
  }

  // ── (f) Already-founder merchant keeps the coupon on new checkouts ──
  resetStub();
  seedFounding([{ merchantId: 1, subId: "sub_founder_old" }]);
  {
    const res = await postCheckout({ tier: "pro", interval: "year" });
    const p = lastCheckoutParams();
    check("(f) founder re-checkout still gets coupon", res.status === 200 && p?.get("discounts[0][coupon]") === FOUNDING_COUPON, `status=${res.status} coupon=${p?.get("discounts[0][coupon]")}`);
  }

  // ── (g) 51st signup gets NO coupon ──
  resetStub();
  seedFounding(Array.from({ length: QUOTA }, (_, i) => ({ merchantId: 2 + i, subId: `sub_seed_${i}` }))); // merchants 2..51, merchant 1 free
  {
    const res = await postCheckout({ tier: "pro", interval: "year" });
    const p = lastCheckoutParams();
    check("(g) quota full → 200", res.status === 200, `status=${res.status}`);
    check("(g) NO discounts param on 51st checkout", p?.get("discounts[0][coupon]") === null, p?.get("discounts[0][coupon]") ?? "coupon present!");
    check("(g) allow_promotion_codes stays true for the 51st", p?.get("allow_promotion_codes") === "true", p?.get("allow_promotion_codes") ?? "");
    check("(g) yearly price still correct for 51st", p?.get("line_items[0][price]") === YEAR_PRO, p?.get("line_items[0][price]") ?? "");
  }
  // month default with quota exhausted → monthly price, no coupon
  {
    const res = await postCheckout({ tier: "standard" });
    const p = lastCheckoutParams();
    check("(g) quota-full month default → monthly price, no coupon", res.status === 200 && p?.get("line_items[0][price]") === MONTH_STD && p?.get("discounts[0][coupon]") === null, `status=${res.status} price=${p?.get("line_items[0][price]")} coupon=${p?.get("discounts[0][coupon]")}`);
  }

  // ── (h) Reviewer discount precedence: never the founding coupon ──
  resetStub();
  seedFounding([]);
  {
    const res = await postCheckout({ tier: "pro", promo: "REVIEWER100" });
    const p = lastCheckoutParams();
    check("(h) reviewer checkout → 200", res.status === 200, `status=${res.status}`);
    check("(h) reviewer promo attached", p?.get("discounts[0][promotion_code]") === REVIEWER_PROMO_ID, p?.get("discounts[0][promotion_code]") ?? "no promo");
    check("(h) founding coupon NOT attached alongside reviewer promo", p?.get("discounts[0][coupon]") === null, p?.get("discounts[0][coupon]") ?? "coupon present!");
  }

  // ── (i) Webhook records the founder + 90-day priority support ──
  seedFounding([]);
  {
    const res = await postWebhook(completedSession({ id: "cs_f1", subscription: "sub_f1", customer: "cus_f1", metadata: { merchant_id: "1", tier: "pro" } }));
    check("(i) checkout.session.completed → 200", res.status === 200, `status=${res.status}`);
    const row = getFoundingRow(1);
    check("(i) founding row created for merchant 1", !!row && row.subscription_id === "sub_f1", JSON.stringify(row));
    const days = row ? (() => {
      const d = db();
      const r = d.query("SELECT CAST(julianday(priority_support_until) - julianday(created_at) AS INTEGER) AS days FROM founding_members WHERE merchant_id=1").get() as { days: number };
      d.close();
      return r.days;
    })() : -1;
    check("(i) priority_support_until = created_at + 90 days", days === 90, `days=${days}`);
    check("(i) count is 1", countFounding() === 1, `count=${countFounding()}`);
  }

  // ── (j) Idempotent replay → still one row, no strip ──
  resetStub();
  {
    const res = await postWebhook(completedSession({ id: "cs_f1", subscription: "sub_f1", customer: "cus_f1", metadata: { merchant_id: "1", tier: "pro" } }));
    check("(j) replay → 200", res.status === 200, `status=${res.status}`);
    check("(j) still exactly one row for merchant 1", countFounding() === 1 && getFoundingRow(1)?.subscription_id === "sub_f1", `count=${countFounding()}`);
    check("(j) no discount strip on replay", stub.deleteCalls.length === 0, JSON.stringify(stub.deleteCalls));
  }

  // ── (k) customer.subscription.created fallback records the slot ──
  resetStub();
  ensureMerchants([2]);
  {
    const res = await postWebhook({
      type: "customer.subscription.created",
      data: { object: { id: "sub_f2", discounts: [{ coupon: { id: FOUNDING_COUPON } }], metadata: { merchant_id: "2", tier: "standard" } } },
    });
    check("(k) subscription.created → 200", res.status === 200, `status=${res.status}`);
    const row = getFoundingRow(2);
    check("(k) founding row created via subscription.created", !!row && row.subscription_id === "sub_f2", JSON.stringify(row));
    check("(k) count is 2", countFounding() === 2, `count=${countFounding()}`);
  }

  // ── (l) Quota race: coupon completion after 50 rows → no row + strip ──
  resetStub();
  {
    // Currently rows: merchant 1 (sub_f1), merchant 2 (sub_f2) → seed 48 more
    // to reach exactly 50 (merchants 3..50), leaving merchant 51 as the 51st.
    const d = db();
    ensureMerchants(Array.from({ length: 48 }, (_, i) => 3 + i));
    for (let i = 0; i < 48; i++) {
      d.run("INSERT INTO founding_members (merchant_id, subscription_id, priority_support_until) VALUES (?, ?, datetime('now','+90 days'))", [3 + i, `sub_seed2_${i}`]);
    }
    d.close();
    check("(l) pre-state: exactly 50 founders", countFounding() === QUOTA, `count=${countFounding()}`);
    const res = await postWebhook(completedSession({ id: "cs_51", subscription: "sub_51", customer: "cus_51", metadata: { merchant_id: "51", tier: "pro" } }));
    check("(l) 51st completion → 200", res.status === 200, `status=${res.status}`);
    check("(l) NO founding row for the 51st", getFoundingRow(51) === null, JSON.stringify(getFoundingRow(51)));
    check("(l) count stays at 50 (never oversubscribed)", countFounding() === QUOTA, `count=${countFounding()}`);
    check("(l) subscription discount stripped (DELETE …/discount)", stub.deleteCalls.length === 1 && stub.deleteCalls[0] === "sub_51", JSON.stringify(stub.deleteCalls));
  }

  // ── (m) Already-founder completion never strips ──
  resetStub();
  {
    const res = await postWebhook(completedSession({ id: "cs_f99", subscription: "sub_f99", customer: "cus_f99", metadata: { merchant_id: "1", tier: "standard" } }));
    check("(m) founder completion → 200", res.status === 200, `status=${res.status}`);
    check("(m) no new row for founder (still 50)", countFounding() === QUOTA, `count=${countFounding()}`);
    check("(m) no strip for a founder", stub.deleteCalls.length === 0, JSON.stringify(stub.deleteCalls));
  }

  // ── (n) /subscription founding state + interval (Phase B dashboard UI) ──
  // The dashboard's pricing block reads foundingOpen/isFounder/foundingRemaining
  // from /subscription to decide whether to show founding pricing and the
  // "N of 50 spots left" note; the plan card reads interval to show the honest
  // yearly price. The UI only DISPLAYS — checkout attaches the coupon server-side.
  {
    seedFounding([]);
    const d = db();
    d.run("DELETE FROM subscriptions WHERE merchant_id=1"); // clear (i)/(m) rows
    d.close();
    const res = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${SESSION}` } });
    const body = await res.json() as Record<string, unknown>;
    check("(n) /subscription 200", res.status === 200, `status=${res.status}`);
    check("(n) foundingOpen=true with quota open", body.foundingOpen === true, JSON.stringify(body));
    check("(n) isFounder=false when not a founder", body.isFounder === false, JSON.stringify(body));
    check("(n) foundingRemaining=50 with empty quota", body.foundingRemaining === 50, JSON.stringify(body));
  }
  {
    seedFounding([{ merchantId: 1, subId: "sub_founder_dash" }]);
    const res = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${SESSION}` } });
    const body = await res.json() as Record<string, unknown>;
    check("(n) isFounder=true for a founder", body.isFounder === true, JSON.stringify(body));
    check("(n) foundingOpen=true for a founder (lifetime benefit)", body.foundingOpen === true, JSON.stringify(body));
    check("(n) foundingRemaining=49 with one slot taken", body.foundingRemaining === 49, JSON.stringify(body));
  }
  {
    // Quota full and merchant 1 NOT a founder → window closed, no founding
    // pricing for them (standard display only).
    seedFounding(Array.from({ length: QUOTA }, (_, i) => ({ merchantId: 2 + i, subId: `sub_n_${i}` })));
    const res = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${SESSION}` } });
    const body = await res.json() as Record<string, unknown>;
    check("(n) foundingOpen=false with quota full", body.foundingOpen === false, JSON.stringify(body));
    check("(n) isFounder=false for a non-founder", body.isFounder === false, JSON.stringify(body));
    check("(n) foundingRemaining=0 when full", body.foundingRemaining === 0, JSON.stringify(body));
  }
  {
    // Interval passthrough: a yearly subscription row → /subscription says year
    // (the dashboard plan card then shows "$250/yr"-style pricing, not $29/mo).
    const d = db();
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status, interval) VALUES (1, 'sub_dash_year', 'pro', 'active', 'year')");
    d.close();
    const res = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${SESSION}` } });
    const body = await res.json() as Record<string, unknown>;
    check("(n) interval=year on a yearly subscription row", body.interval === "year", JSON.stringify(body));
    check("(n) tier pro preserved on the row", body.tier === "pro", JSON.stringify(body));
  }
  {
    // Webhook interval recording: a checkout completion with metadata.interval
    // = year stores interval='year' on the new subscription row (default month
    // when absent — already covered by (i)).
    seedFounding([]);
    const d = db();
    d.run("DELETE FROM subscriptions WHERE merchant_id=2");
    d.close();
    const res = await postWebhook(completedSession({ id: "cs_year1", subscription: "sub_year1", customer: "cus_year1", metadata: { merchant_id: "2", tier: "standard", interval: "year" } }));
    check("(n) yearly completion → 200", res.status === 200, `status=${res.status}`);
    const row = db().query("SELECT interval FROM subscriptions WHERE stripe_subscription_id='sub_year1'").get() as { interval: string } | null;
    check("(n) subscription row interval=year recorded from metadata", row?.interval === "year", JSON.stringify(row));
  }

  stub.server.stop(true);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); stub.server?.stop(true); process.exit(2); });
