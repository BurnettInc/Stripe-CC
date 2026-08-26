/**
 * Lifetime free-Pro giveaway tests (owner grant path, 2026-08).
 *
 * The owner hands out ONE special checkout link (promo=LIFETIME10) that grants
 * a REAL Pro subscription at $0 forever via live coupon EiubBz3c (100%-off,
 * duration=forever). At most 10 grants EVER (atomic cap in db.ts).
 *
 * Contract under test:
 *   (a) attach: checkout with promo=LIFETIME10 for an ELIGIBLE merchant
 *       attaches discounts[0][coupon]=EiubBz3c SERVER-SIDE and drops
 *       allow_promotion_codes (Stripe rejects sessions with both).
 *   (b) cap: with 10 lifetime_members already seeded, an 11th eligible-free
 *       merchant requesting promo=LIFETIME10 gets NO coupon attached
 *       (checkout proceeds normally); recordLifetimeMember returns "full",
 *       and a stray completed subscription carrying the coupon triggers the
 *       best-effort discount strip (quota-race guard).
 *   (c) coupon: the live coupon is percent_off=100, duration=forever
 *       (verified via the Stripe API when LIVE_STRIPE_KEY is provided; the
 *       manual curl check is in the harness notes — this test re-asserts it).
 *   (d) reviewer: promo=REVIEWER100 still attaches the reviewer promotion
 *       code (discounts[0][promotion_code]) — REVIEWER100 path untouched.
 *   (e) webhook recording: a completed checkout/session carrying the lifetime
 *       coupon atomically inserts a lifetime_members row (with account email);
 *       an already-member is left untouched; quota exhaustion strips the
 *       subscription discount.
 *
 * Stripe is stubbed by an in-process HTTP server on STRIPE_STUB_PORT (3199).
 * The app server MUST be booted with:
 *
 *   STRIPE_API_BASE=http://localhost:3199/v1 STRIPE_SECRET_KEY=sk_test_stub \
 *     DB_PATH=/tmp/cc-lifetime.db PORT=3100 bun run src/index.ts
 *
 * and run with:
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-lifetime.db \
 *     [LIVE_STRIPE_KEY=sk_live_...] bun run test-lifetime.ts
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-lifetime.db";
const SESSION = "lifetime-session";
const STRIPE_STUB_PORT = 3199;
const LIFETIME_COUPON_ID = "EiubBz3c";
const REVIEWER_PROMO_CODE_ID = "promo_1U5PYjAD4cJGS9Cro4A2TdbI";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}
// ── In-process Stripe stub ──────────────────────────────────────────────
const stub: {
  /** Form bodies of every POST /v1/checkout/sessions, in order. */
  checkoutBodies: string[];
  /** Sub ids on which a DELETE /v1/subscriptions/<id>/discount was issued. */
  discountDeletes: string[];
  server: ReturnType<typeof Bun.serve>;
} = {
  checkoutBodies: [],
  discountDeletes: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};
function resetStub(): void {
  stub.checkoutBodies = [];
  stub.discountDeletes = [];
}
stub.server = Bun.serve({
  port: STRIPE_STUB_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
      const body = await req.text();
      stub.checkoutBodies.push(body);
      return Response.json({ id: "cs_stub_" + stub.checkoutBodies.length, url: "https://checkout.stripe.com/c/pay/stub" });
    }
    if (url.pathname.startsWith("/v1/subscriptions/") && req.method === "DELETE" && url.pathname.endsWith("/discount")) {
      stub.discountDeletes.push(url.pathname);
      return Response.json({ id: "di_stub", object: "discount", deleted: true });
    }
    return Response.json({ error: { type: "invalid_request_error", message: `stub: not found ${req.method} ${url.pathname}` } }, { status: 404 });
  },
});
// ── Seeding helpers ─────────────────────────────────────────────────────
function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.close();
}
/** Ensure a merchant row exists with the given id (FK-safe seeding). */
function ensureMerchant(id: number): void {
  const d = db();
  d.run(
    "INSERT OR IGNORE INTO merchants (id, stripe_account_id, email) VALUES (?, ?, ?)",
    [id, `acct_m${id}`, `m${id}@example.com`],
  );
  d.close();
}
function clearLifetimeMembers(): void {
  const d = db();
  d.run("DELETE FROM lifetime_members");
  d.close();
}
function clearSubscriptions(): void {
  const d = db();
  d.run("DELETE FROM subscriptions");
  d.close();
}
function lifetimeCount(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM lifetime_members").get() as { n: number };
  d.close();
  return row.n;
}
/** Stripe stub bodies are form-encoded — decode before asserting on params. */
function decoded(s: string | null): string {
  return s ? decodeURIComponent(s) : "";
}
/** Seed N lifetime members (merchants 2..N+1). */
function seedLifetimeMembers(n: number): void {
  const d = db();
  for (let i = 0; i < n; i++) {
    const mid = 2 + i;
    ensureMerchant(mid);
    d.run(
      "INSERT OR IGNORE INTO lifetime_members (merchant_id, subscription_id, account_email) VALUES (?, ?, ?)",
      [mid, `sub_lifetime_${mid}`, `lifetime${mid}@example.com`],
    );
  }
  d.close();
}
function authHeaders(): Record<string, string> {
  return { Cookie: `session=${SESSION}` };
}
/** GET /billing/checkout with a session, return the stub's last body & HTTP res. */
async function doCheckout(qs: string): Promise<{ res: Response; stubBody: string | null }> {
  const res = await fetch(`${BASE}/billing/checkout${qs}`, { headers: authHeaders() });
  return { res, stubBody: stub.checkoutBodies.length ? stub.checkoutBodies[stub.checkoutBodies.length - 1] : null };
}
/** POST /billing (unauthenticated webhook). */
async function postWebhook(obj: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/billing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "checkout.session.completed", data: { object: obj } }),
  });
}
/**
 * Assert /billing/checkout created a session with coupon EiubBz3c attached
 * server-side and allow_promotion_codes dropped.
 */
function checkLifetimeAttached(label: string, stubBody: string | null): void {
  const b = decoded(stubBody);
  check(`${label} → coupon attached`, b.includes(`discounts[0][coupon]=${LIFETIME_COUPON_ID}`), `body=${b}`);
  check(`${label} → allow_promotion_codes dropped`, !/allow_promotion_codes=true/.test(b), `body=${b}`);
}
async function main(): Promise<void> {
  const warm = await fetch(`${BASE}/health`);
  check("(warm) server up", warm.status === 200, `status=${warm.status}`);
  seedSession();
  clearLifetimeMembers();
  clearSubscriptions();
  resetStub();

  // ── (c) Coupon on Stripe: percent_off=100, duration=forever ──
  const liveKey = process.env.LIVE_STRIPE_KEY;
  if (liveKey) {
    const res = await fetch("https://api.stripe.com/v1/coupons/" + LIFETIME_COUPON_ID, {
      headers: { Authorization: `Bearer ${liveKey}` },
    });
    const data = await res.json() as { percent_off?: unknown; duration?: unknown; name?: unknown; livemode?: boolean };
    check("(c) coupon HTTP 200 under live key", res.status === 200, `status=${res.status}`);
    check("(c) coupon percent_off=100", data.percent_off === 100, `percent_off=${data.percent_off}`);
    check("(c) coupon duration=forever", data.duration === "forever", `duration=${data.duration}`);
    check("(c) coupon livemode=true", data.livemode === true, `livemode=${data.livemode}`);
  } else {
    console.log("SKIP  (c) coupon property check — set LIVE_STRIPE_KEY to assert against the live Stripe API (verified via curl in harness)");
  }

  // ── (a) Attach for an eligible merchant (0 members seeded; merchant 1 free) ──
  resetStub();
  const attach = await doCheckout("?tier=pro&interval=month&promo=LIFETIME10");
  check("(a) checkout returns 200 JSON {url}", attach.res.status === 200 && /"url":/.test(await attach.res.clone().text()), `status=${attach.res.status}`);
  checkLifetimeAttached("(a) LIFETIME10 eligible → coupon attached + code dropped", attach.stubBody);

  // ── No-promo checkout: normal path keeps allow_promotion_codes, no coupon ──
  resetStub();
  const plain = await doCheckout("?tier=pro&interval=month");
  check("(a) no-promo → allow_promotion_codes kept", !!plain.stubBody && /allow_promotion_codes=true/.test(plain.stubBody), `body=${plain.stubBody}`);
  check("(a) no-promo → no coupon attached", !!plain.stubBody && !plain.stubBody.includes("discounts[0][coupon]"), `body=${plain.stubBody}`);

  // ── (b) no-promo-adjacent normal-path checks via plain checkout (above) — cap: ──
  resetStub();
  clearLifetimeMembers();
  clearSubscriptions();
  seedLifetimeMembers(10); // merchants 2..11
  const full = await doCheckout("?tier=pro&interval=month&promo=LIFETIME10"); // merchant 1, NOT a member
  check("(b) checkout still succeeds (200)", full.res.status === 200, `status=${full.res.status}`);
  check("(b) 11th merchant → NO coupon attached", !decoded(full.stubBody).includes("discounts[0][coupon]"), `body=${decoded(full.stubBody)}`);
  check("(b) 11th merchant → allow_promotion_codes kept (behaves normally)", /allow_promotion_codes=true/.test(decoded(full.stubBody)), `body=${decoded(full.stubBody)}`);

  // ── (2b) recordLifetimeMember semantics via stray completed coupons:
  //      an already-member keeps the coupon (no strip, no double row); a
  //      non-member arriving when the quota is full triggers the strip.
  // Make merchant 1 a member (it is NOT among the seeded 2..11).
  {
    const d = db();
    d.run("INSERT OR IGNORE INTO lifetime_members (merchant_id, subscription_id, account_email) VALUES (1, 'sub_lifetime_1', 'm1@example.com')");
    d.close();
  }
  resetStub();
  const alreadyObj = {
    id: "cs_already", subscription: "sub_already", customer: "cus_already",
    metadata: { merchant_id: "1", tier: "pro" }, customer_details: { email: "existing@example.com" },
    discounts: [{ coupon: { id: LIFETIME_COUPON_ID } }],
  };
  await postWebhook(alreadyObj);
  check("(b) already-member completion → no discount strip", stub.discountDeletes.length === 0, `deletes=${JSON.stringify(stub.discountDeletes)}`);
  check("(b) already-member → no double insert (count unchanged)", lifetimeCountWith("sub_already") === 0, "");

  // non-member merchant 12 when the quota is full → coupon must be stripped
  // and NO 11th slot recorded (baseline = count before the event lands).
  ensureMerchant(12);
  const baselineBeforeFull = lifetimeCount();
  resetStub();
  const fullObj = {
    id: "cs_12", subscription: "sub_12", customer: "cus_12",
    metadata: { merchant_id: "12", tier: "pro" }, customer_details: { email: "m12@example.com" },
    discounts: [{ coupon: { id: LIFETIME_COUPON_ID } }],
  };
  const resp = await postWebhook(fullObj);
  check("(b) full → webhook still 200 (never throws)", resp.status === 200, `status=${resp.status}`);
  check("(b) full → best-effort discount strip issued", stub.discountDeletes.includes("/v1/subscriptions/sub_12/discount"), `deletes=${JSON.stringify(stub.discountDeletes)}`);
  check("(b) full → total unchanged (no 11th slot)", lifetimeCount() === baselineBeforeFull, `count=${lifetimeCount()} baseline=${baselineBeforeFull}`);

  // ── (e) Webhook recording: eligible completion inserts row + account email ──
  clearLifetimeMembers();
  clearSubscriptions();
  resetStub();
  const insertObj = {
    id: "cs_new", subscription: "sub_new", customer: "cus_new",
    metadata: { merchant_id: "1", tier: "pro", interval: "month" }, customer_details: { email: "newguy@example.com" },
    discounts: [{ coupon: { id: LIFETIME_COUPON_ID } }],
  };
  const eRes = await postWebhook(insertObj);
  check("(e) completion webhook 200", eRes.status === 200, `status=${eRes.status}`);
  const d = db();
  const row = d.query("SELECT merchant_id, subscription_id, account_email FROM lifetime_members WHERE merchant_id=1").get() as { merchant_id: number; subscription_id: string; account_email: string } | null;
  d.close();
  check("(e) lifetime_members row recorded", !!row && row.subscription_id === "sub_new", `row=${JSON.stringify(row)}`);
  check("(e) account_email recorded", !!row && row.account_email === "newguy@example.com", `email=${row?.account_email}`);
  const subRow = db().query("SELECT stripe_subscription_id, tier FROM subscriptions WHERE merchant_id=1").get() as { stripe_subscription_id: string; tier: string } | null;
  check("(e) subscription created with tier from metadata", !!subRow && subRow.stripe_subscription_id === "sub_new" && subRow.tier === "pro", `sub=${JSON.stringify(subRow)}`);

  // ── (d) Review path untouched: promo=REVIEWER100 attaches promo code ──
  resetStub();
  clearLifetimeMembers();
  clearSubscriptions();
  const rev = await doCheckout("?tier=standard&interval=month&promo=REVIEWER100");
  check("(d) REVIEWER100 checkout 200", rev.res.status === 200, `status=${rev.res.status}`);
  check("(d) REVIEWER100 → promotion_code attached", decoded(rev.stubBody).includes(`discounts[0][promotion_code]=${REVIEWER_PROMO_CODE_ID}`), `body=${decoded(rev.stubBody)}`);
  check("(d) REVIEWER100 → NO lifetime coupon attached", !decoded(rev.stubBody).includes(`discounts[0][coupon]=${LIFETIME_COUPON_ID}`), `body=${decoded(rev.stubBody)}`);
  check("(d) REVIEWER100 → allow_promotion_codes dropped too", !/allow_promotion_codes=true/.test(decoded(rev.stubBody)), `body=${decoded(rev.stubBody)}`);

  stub.server.stop(true);
  console.log(`\nRESULTS: ${failures === 0 ? "ALL" : failures + " FAILURES"} PASSED (${failures} failed)`);
  process.exit(failures === 0 ? 0 : 1);
}
/** Count lifetime_members rows with the given subscription id. */
function lifetimeCountWith(subId: string): number {
  const row = db().query("SELECT COUNT(*) AS n FROM lifetime_members WHERE subscription_id=?").get(subId) as { n: number };
  return row.n;
}
main().catch((err) => {
  console.error("test-lifetime crashed:", err);
  process.exit(1);
});
