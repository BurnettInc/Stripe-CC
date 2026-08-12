/**
 * Billing portal robustness tests (portal hardening, 2026-08).
 *
 * Contract under test for GET/POST /billing/portal when stored Stripe
 * customer/subscription ids are stale or unresolvable:
 *   (a) happy path: valid stored customer id → 200 {url} (POST) and
 *       302 → Stripe portal URL (GET), identical to pre-hardening behavior;
 *   (b) stored customer id unresolvable (resource_missing) but the stored
 *       subscription id resolves → customer derived from Stripe's copy of the
 *       subscription (fallback a) → still 302, no error leaked;
 *   (c) stored customer id AND subscription id unresolvable → GET returns a
 *       200 HTML "no active subscription" page with a checkout link, POST
 *       returns 404 JSON with checkout_url — never a 502, never Stripe
 *       internals in the body;
 *   (d) test-mode/live-mode key mismatch style error → same clean response,
 *       mismatch message text NOT leaked;
 *   (e) no subscription row at all → clean response with checkout link
 *       (no Stripe call attempted);
 *   (f) latest subscription row unresolvable but an OLDER row's customer
 *       resolves → portal session created from the older row (fallback b);
 *   (g) subscription row with no stored customer id → customer derived from
 *       the Stripe subscription fetch (the pre-existing fallback path).
 *
 * Stripe is stubbed by an in-process HTTP server on STRIPE_STUB_PORT (default
 * 3199) whose behavior the test mutates per scenario via `stub.mode`. The app
 * server MUST be booted with STRIPE_API_BASE pointing at the stub and
 * STRIPE_SECRET_KEY set to a dummy value (see /tmp/run-suite.sh billing-portal):
 *
 *   STRIPE_API_BASE=http://localhost:3199/v1 STRIPE_SECRET_KEY=sk_test_stub \
 *     TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-billing-portal.db \
 *     bun run test-billing-portal.ts
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-billing-portal.db";
const SESSION = "billing-portal-session";
const STRIPE_STUB_PORT = 3199;

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}

// ── In-process Stripe stub ──────────────────────────────────────────────
// Route table is mutated per scenario; every request is recorded so tests can
// assert the FALLBACK ORDER the backend actually walked.
interface StubMode {
  /** Customer ids whose portal-session POST fails with resource_missing. */
  badCustomers: Set<string>;
  /** Subscription ids whose GET fails with resource_missing. */
  badSubscriptions: Set<string>;
  /** Return the test-mode/live-mode mismatch message for bad ids. */
  modeMismatch: boolean;
}
const stub: {
  mode: StubMode;
  portalCalls: string[];
  subFetchCalls: string[];
  server: ReturnType<typeof Bun.serve>;
} = {
  mode: { badCustomers: new Set(), badSubscriptions: new Set(), modeMismatch: false },
  portalCalls: [],
  subFetchCalls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};

function resetStub(m: { badCustomers?: string[]; badSubscriptions?: string[]; modeMismatch?: boolean } = {}): void {
  stub.mode = {
    badCustomers: new Set(m.badCustomers ?? []),
    badSubscriptions: new Set(m.badSubscriptions ?? []),
    modeMismatch: m.modeMismatch ?? false,
  };
  stub.portalCalls = [];
  stub.subFetchCalls = [];
}

function stubErrorMessage(id: string, kind: "customer" | "subscription"): string {
  const base = kind === "customer" ? `No such customer: '${id}'` : `No such subscription: '${id}'`;
  return stub.mode.modeMismatch
    ? `${base}; a similar object exists in test mode, but a live mode key was used.`
    : base;
}

stub.server = Bun.serve({
  port: STRIPE_STUB_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // Portal session creation
    if (url.pathname === "/v1/billing_portal/sessions" && req.method === "POST") {
      const params = new URLSearchParams(await req.text());
      const customer = params.get("customer") ?? "";
      stub.portalCalls.push(customer);
      if (stub.mode.badCustomers.has(customer)) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "resource_missing", message: stubErrorMessage(customer, "customer") } },
          { status: 404 }
        );
      }
      return Response.json({ url: `https://billing.stripe.com/session/${customer}`, id: "cs_test_stub" });
    }
    // Subscription lookup (fallback a: derive the customer from the sub)
    if (url.pathname.startsWith("/v1/subscriptions/") && req.method === "GET") {
      const subId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      stub.subFetchCalls.push(subId);
      if (stub.mode.badSubscriptions.has(subId)) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "resource_missing", message: stubErrorMessage(subId, "subscription") } },
          { status: 404 }
        );
      }
      return Response.json({ id: subId, customer: "cus_from_sub", status: "active" });
    }
    return Response.json({ error: { type: "invalid_request_error", message: `stub: not found ${req.method} ${url.pathname}` } }, { status: 404 });
  },
});

// ── Seeding ──────────────────────────────────────────────────────────────

/** Replace ALL subscription rows for merchant 1 (portal candidates). */
function seedSubscriptions(rows: Array<{ subId: string; customerId?: string | null; tier?: string; status?: string; createdAt?: string }>): void {
  const d = db();
  d.run("DELETE FROM subscriptions WHERE merchant_id=1");
  for (const r of rows) {
    d.run(
      "INSERT OR REPLACE INTO subscriptions (merchant_id, stripe_subscription_id, stripe_customer_id, tier, status, created_at) VALUES (1, ?, ?, ?, ?, COALESCE(?, datetime('now')))",
      [r.subId, r.customerId ?? null, r.tier ?? "pro", r.status ?? "active", r.createdAt ?? null]
    );
  }
  d.close();
}

function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.close();
}

const authHeaders = { "Content-Type": "application/json", Cookie: `session=${SESSION}` };
// redirect: "manual" — the happy-path assertions must see the 302 + Location
// header itself; Bun's fetch would otherwise follow it to the external
// billing.stripe.com page (whose body is not ours to assert on).
async function getPortal(): Promise<Response> {
  return fetch(`${BASE}/billing/portal`, { headers: authHeaders, redirect: "manual" });
}
async function postPortal(): Promise<Response> {
  return fetch(`${BASE}/billing/portal`, { method: "POST", headers: authHeaders });
}

/** Assert a response is the graceful no-subscription outcome: no 502, no Stripe internals. */
function checkGraceful(res: Response, label: string, opts: { expectJson: boolean }): void {
  check(`${label} → not 502`, res.status !== 502, `status=${res.status}`);
  const body = res.status === 200 ? String(res.headers.get("Content-Type")) : "";
  if (opts.expectJson) {
    check(`${label} → 404 JSON`, res.status === 404 && String(res.headers.get("Content-Type")).includes("application/json"), `status=${res.status} ct=${res.headers.get("Content-Type")}`);
  } else {
    check(`${label} → 200 HTML`, res.status === 200 && String(res.headers.get("Content-Type")).includes("text/html"), `status=${res.status} ct=${res.headers.get("Content-Type")}`);
  }
  void body;
}

const LEAK_PATTERNS = ["No such customer", "No such subscription", "resource_missing", "similar object exists", "api.stripe.com", "Stripe billing portal session creation failed"];
function checkNoLeak(body: string, label: string): void {
  const leaked = LEAK_PATTERNS.filter((p) => body.includes(p));
  check(`${label} → no Stripe internals leaked`, leaked.length === 0, `leaked=${JSON.stringify(leaked)}`);
}

async function main(): Promise<void> {
  // First request creates the default merchant (ensureDefaultMerchant), so the
  // session/subscription seeds below can reference merchant 1 safely.
  const warm = await fetch(`${BASE}/health`);
  check("(warm) server up", warm.status === 200, `status=${warm.status}`);
  seedSession();

  // ── (a) Happy path: valid stored customer id ──
  resetStub();
  seedSubscriptions([{ subId: "sub_ok", customerId: "cus_ok" }]);
  {
    const post = await postPortal();
    const data = await post.json() as { url?: string };
    check("(a) POST happy → 200 {url}", post.status === 200 && data.url === "https://billing.stripe.com/session/cus_ok", `status=${post.status} url=${data.url}`);
    check("(a) portal called with the stored customer", stub.portalCalls.length === 1 && stub.portalCalls[0] === "cus_ok", JSON.stringify(stub.portalCalls));
  }
  {
    const get = await getPortal();
    check("(a) GET happy → 302 to portal URL", get.status === 302 && get.headers.get("Location") === "https://billing.stripe.com/session/cus_ok", `status=${get.status} loc=${get.headers.get("Location")}`);
  }

  // ── (b) Stored customer unresolvable, subscription resolves → fallback (a) ──
  resetStub({ badCustomers: ["cus_stale"] });
  seedSubscriptions([{ subId: "sub_good", customerId: "cus_stale" }]);
  {
    const get = await getPortal();
    check("(b) stale customer + valid sub → 302 via derived customer", get.status === 302 && get.headers.get("Location") === "https://billing.stripe.com/session/cus_from_sub", `status=${get.status} loc=${get.headers.get("Location")}`);
    check("(b) fallback order: stale customer first, then sub fetch, then derived", stub.portalCalls[0] === "cus_stale" && stub.subFetchCalls[0] === "sub_good" && stub.portalCalls[1] === "cus_from_sub", `portal=${JSON.stringify(stub.portalCalls)} subFetch=${JSON.stringify(stub.subFetchCalls)}`);
    const text = await get.clone().text();
    checkNoLeak(text, "(b)");
  }

  // ── (c) Customer AND subscription unresolvable → graceful page/JSON ──
  resetStub({ badCustomers: ["cus_bad"], badSubscriptions: ["sub_bad"] });
  seedSubscriptions([{ subId: "sub_bad", customerId: "cus_bad" }]);
  {
    const get = await getPortal();
    const html = await get.text();
    check("(c) GET all-unresolvable → 200 HTML (not 302, not 502)", get.status === 200 && String(get.headers.get("Content-Type")).includes("text/html"), `status=${get.status} ct=${get.headers.get("Content-Type")}`);
    check("(c) HTML carries X-Billing-Fallback", get.headers.get("X-Billing-Fallback") === "no-subscription", `hdr=${get.headers.get("X-Billing-Fallback")}`);
    check("(c) HTML links to checkout", html.includes('/billing/checkout?tier=pro'), "checkout link missing");
    check("(c) HTML mentions no active subscription", html.includes("No active subscription"), "title text missing");
    checkNoLeak(html, "(c)");
  }
  {
    const post = await postPortal();
    const body = await post.json() as { error?: string; checkout_url?: string };
    check("(c) POST all-unresolvable → 404 JSON", post.status === 404, `status=${post.status}`);
    check("(c) POST JSON has checkout_url", body.checkout_url === "/billing/checkout?tier=pro", JSON.stringify(body));
    checkNoLeak(JSON.stringify(body), "(c POST)");
  }

  // ── (d) Test-mode/live-mode mismatch style error → same graceful response ──
  resetStub({ badCustomers: ["cus_live"], badSubscriptions: ["sub_live"], modeMismatch: true });
  seedSubscriptions([{ subId: "sub_live", customerId: "cus_live" }]);
  {
    const get = await getPortal();
    const html = await get.text();
    check("(d) mode-mismatch GET → 200 HTML", get.status === 200 && String(get.headers.get("Content-Type")).includes("text/html"), `status=${get.status}`);
    check("(d) mode-mismatch message NOT leaked", !html.includes("similar object exists") && !html.includes("test mode"), "mismatch text leaked");
    checkNoLeak(html, "(d)");
  }
  {
    const post = await postPortal();
    const body = await post.json() as { error?: string };
    check("(d) mode-mismatch POST → 404 JSON, clean", post.status === 404 && String(body.error).includes("No active subscription"), `status=${post.status} ${JSON.stringify(body)}`);
    checkNoLeak(JSON.stringify(body), "(d POST)");
  }

  // ── (e) No subscription row at all → graceful, no Stripe call ──
  resetStub();
  seedSubscriptions([]);
  {
    const get = await getPortal();
    const html = await get.text();
    check("(e) no sub row GET → 200 HTML", get.status === 200 && String(get.headers.get("Content-Type")).includes("text/html"), `status=${get.status}`);
    check("(e) no Stripe call attempted", stub.portalCalls.length === 0 && stub.subFetchCalls.length === 0, JSON.stringify({ portal: stub.portalCalls, sub: stub.subFetchCalls }));
    check("(e) HTML links to checkout", html.includes("/billing/checkout?tier=pro"), "checkout link missing");
    checkNoLeak(html, "(e)");
  }
  {
    const post = await postPortal();
    const body = await post.json() as { error?: string; checkout_url?: string };
    check("(e) no sub row POST → 404 JSON + checkout_url", post.status === 404 && body.checkout_url === "/billing/checkout?tier=pro", `status=${post.status} ${JSON.stringify(body)}`);
  }

  // ── (f) Latest row unresolvable, older row's customer resolves → fallback (b) ──
  resetStub({ badCustomers: ["cus_new"], badSubscriptions: ["sub_new"] });
  seedSubscriptions([
    { subId: "sub_new", customerId: "cus_new", createdAt: "2026-08-01 10:00:00" },
    { subId: "sub_old", customerId: "cus_old", createdAt: "2026-07-01 10:00:00" },
  ]);
  {
    const get = await getPortal();
    check("(f) older-row fallback → 302 via older customer", get.status === 302 && get.headers.get("Location") === "https://billing.stripe.com/session/cus_old", `status=${get.status} loc=${get.headers.get("Location")}`);
    check("(f) order: latest pair, latest sub fetch, then older customer", stub.portalCalls[0] === "cus_new" && stub.subFetchCalls[0] === "sub_new" && stub.portalCalls[1] === "cus_old", `portal=${JSON.stringify(stub.portalCalls)} subFetch=${JSON.stringify(stub.subFetchCalls)}`);
  }

  // ── (g) No stored customer id → derived from Stripe subscription fetch ──
  resetStub();
  seedSubscriptions([{ subId: "sub_noc", customerId: null }]);
  {
    const get = await getPortal();
    check("(g) no stored customer → derived from sub fetch → 302", get.status === 302 && get.headers.get("Location") === "https://billing.stripe.com/session/cus_from_sub", `status=${get.status} loc=${get.headers.get("Location")}`);
    check("(g) sub fetched once, portal called with derived customer", stub.subFetchCalls.length === 1 && stub.subFetchCalls[0] === "sub_noc" && stub.portalCalls.length === 1 && stub.portalCalls[0] === "cus_from_sub", JSON.stringify({ portal: stub.portalCalls, sub: stub.subFetchCalls }));
  }

  stub.server.stop(true);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); stub.server?.stop(true); process.exit(2); });
