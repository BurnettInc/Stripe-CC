/**
 * Stripe Apps OAuth v2 install flow tests (marketplace install).
 *
 * Covers the whole flow end-to-end against a booted server (fresh DB, Stripe
 * stubbed in-process on STRIPE_STUB_PORT) plus unit tests for the state and
 * token helpers:
 *
 * HTTP level (server booted with STRIPE_API_BASE → stub, STRIPE_CLIENT_ID,
 * STRIPE_APP_TEST_KEY/STRIPE_APP_LIVE_KEY, TOKEN_ENCRYPTION_KEY, and
 * BASE_URL=https://stripe-cc-production.up.railway.app so the authorize
 * redirect_uri is EXACTLY the manifest's allowed_redirect_uris entry):
 *   (a) /oauth/install renders the branded install page: SIGNED-OUT it shows
 *       the sign-in/create-account card (email input + "Email me a sign-in
 *       link") and NO connect buttons; SIGNED-IN (account cookie from the
 *       magic-link flow) it shows the per-mode "Connect with Stripe" buttons
 *       (test + live), step instructions and "Signed in as … · sign out";
 *       ?auto=1 302s into the authorize flow (install/start still enforces
 *       the cookie)
 *   (b) /oauth/install/start WITHOUT an account cookie → 302 back to
 *       /oauth/install (the reviewer's flow signs in BEFORE connecting);
 *       WITH the cookie → 302 to
 *       https://marketplace.stripe.com/oauth/v2/authorize with
 *       client_id=STRIPE_CLIENT_ID (legacy fallback — the suite server has no
 *       mode-specific client ids), redirect_uri=the manifest URI, a CSRF-safe
 *       state ("<48 hex>:<link-type>") stored in oauth_install_states and
 *       stamped with the signed-in account's account_id
 *   (c) callback happy path: /oauth/callback?code=…&state=… exchanges the code
 *       with the stub (Basic auth = the TEST developer key), stores
 *       oauth_tokens (encrypted at rest) + stripe_connections mirror, creates
 *       the merchant, mints a session, and 302s through the www-host
 *       /oauth/session handoff with the session cookie
 *   (d) state is one-time: replaying the same state fails with a clean page
 *   (e) unknown state / missing params / denial (error param) → clean error
 *       pages, never a 500, never a Stripe call for invalid states
 *   (f) the Express web-connect callback branch is untouched: /oauth/callback
 *       without a code (with `account`) still dispatches to the existing
 *       handler (missing-account redirect behavior preserved)
 *   (c2) post-connect backfill: the callback fetches the merchant's own
 *       /v1/invoices (Bearer access token) and stores them with the watcher's
 *       exact semantics — overdue (past-due open), paid (amount_paid +
 *       created-as-due_date), open (future-due), em-dash name/email fallback,
 *       and void/draft/uncollectible skipped as not active
 *   (c3) backfill idempotency: a re-install (fresh state, same account)
 *       updates in place — never duplicates rows
 *   (c4) backfill never fails the install: invoices 500 → callback still 302s,
 *       existing rows untouched, backfillMerchantInvoices returns an error
 *       result instead of throwing
 *   (c5) /stats carries the banner's inputs: stripeConnected + plan +
 *       sub_status + stripe_livemode (from oauth_tokens) for a fresh install
 *   (c6) dashboard HTML carries the status banner markup + renderer covering
 *       all three states ("Not connected to Stripe" / "Connected to Stripe —
 *       subscription required" / "Active — Connected to Stripe")
 *
 * Unit level (direct module imports in this process, own DB handle, env
 * mutated locally and restored):
 *   (g) create/consume install state (roundtrip, one-time, unknown → null)
 *   (h) appDevKeyFor picks test/live key, null when unset (graceful no-op);
 *       live mode FALLS BACK to STRIPE_SECRET_KEY when STRIPE_APP_LIVE_KEY is
 *       unset (the suite process deletes the shell-exported STRIPE_SECRET_KEY
 *       to exercise the true null/missing paths); appClientIdFor picks per-mode
 *       STRIPE_APP_{TEST|LIVE}_CLIENT_ID with a STRIPE_CLIENT_ID fallback,
 *       null when nothing resolves
 *   (i) buildAuthorizeUrl: per-mode client_id (mode env wins, STRIPE_CLIENT_ID
 *       falls back) + redirect_uri + state, or a clear error naming the
 *       missing env vars
 *   (m) installPageHtml: a mode's button appears only when BOTH its client id
 *       and its developer key resolve (live key slot satisfied by
 *       STRIPE_SECRET_KEY alone); the "not configured" notice lists the
 *       missing env vars per mode ("set STRIPE_APP_LIVE_KEY or
 *       STRIPE_SECRET_KEY" when both live key vars are unset)
 *   (j) exchangeCodeForTokens: happy path through the stub; missing-key error
 *       (naming STRIPE_APP_LIVE_KEY + STRIPE_SECRET_KEY fallback for live)
 *       without any network call; live exchange authenticates with the
 *       STRIPE_SECRET_KEY value as Basic auth when STRIPE_APP_LIVE_KEY is unset
 *   (k) save/getAppOAuthTokens: encrypted at rest, decrypted on read, upsert
 *   (l) refreshAppAccessToken: expired pair → refresh (stub, grant_type=
 *       refresh_token, rolling refresh token stored), valid pair → no network
 *       call, missing refresh token / missing key / unknown user → clean
 *       errors; live refresh falls back to STRIPE_SECRET_KEY as Basic auth
 *
 * Run via: bash /tmp/run-suite.sh oauth-install
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-oauth-install.db";
const STRIPE_STUB_PORT = 3199;
const MANIFEST_REDIRECT_URI = "https://stripe-cc-production.up.railway.app/oauth/callback";
const WWW_DASHBOARD = "https://www.getcollectionscopilot.com/dashboard";
// The server is booted with this exact key (see /tmp/run-suite.sh); the test
// process sets the same value so its own encrypt/decrypt roundtrips match.
const ENC_KEY = "test-encryption-key-0123456789abcdef";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function db(): Database {
  return new Database(DB_PATH);
}

// ── In-process Stripe stub (OAuth token + account + invoices endpoints) ──
const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);
// Deterministic invoice list for the post-connect backfill (the merchant's
// own account via their access token). Timestamps are fixed relative to
// "now" so the expected statuses/dates are computable in this test process.
const BACKFILL_INVOICES = [
  { id: "in_ovd1", status: "open", due_date: nowSec - 10 * DAY, created: nowSec - 40 * DAY, amount_due: 12345, amount_paid: 0, currency: "usd", customer_name: "Overdue Co", customer_email: "overdue@example.com" },
  { id: "in_paid1", status: "paid", created: nowSec - 30 * DAY, amount_due: 5000, amount_paid: 5000, currency: "usd", customer_name: "Paid Co", customer_email: "paid@example.com" },
  { id: "in_open1", status: "open", due_date: nowSec + 20 * DAY, created: nowSec - 5 * DAY, amount_due: 777, amount_paid: 0, currency: "eur", customer_name: "Future Co", customer_email: "future@example.com" },
  // Not-active statuses: must NOT be stored by the backfill.
  { id: "in_void1", status: "void", created: nowSec - 3 * DAY, amount_due: 555, amount_paid: 0, currency: "usd" },
  { id: "in_draft1", status: "draft", created: nowSec - 2 * DAY, amount_due: 444, amount_paid: 0, currency: "usd" },
  { id: "in_unc1", status: "uncollectible", created: nowSec - 1 * DAY, amount_due: 333, amount_paid: 0, currency: "usd" },
  // No customer fields → the em-dash fallback.
  { id: "in_nameless1", status: "open", due_date: nowSec + 5 * DAY, created: nowSec - 4 * DAY, amount_due: 999, amount_paid: 0, currency: "usd" },
];
const iso = (unix: number) => new Date(unix * 1000).toISOString().split("T")[0];
const EXPECTED_BACKFILL_DATES = {
  ovd: iso(nowSec - 10 * DAY),
  paid: iso(nowSec - 30 * DAY),
  open: iso(nowSec + 20 * DAY),
  nameless: iso(nowSec + 5 * DAY),
};

const stub: {
  calls: { path: string; method: string; auth: string; body: string }[];
  server: ReturnType<typeof Bun.serve>;
  failInvoices: boolean;
} = {
  calls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
  failInvoices: false,
};

function resetStub(): void {
  stub.calls = [];
  stub.failInvoices = false;
}

function startStub(): void {
  stub.server = Bun.serve({
    port: STRIPE_STUB_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") || "";
      const bodyText = await req.text().catch(() => "");
      stub.calls.push({ path: url.pathname, method: req.method, auth, body: bodyText });

      if (url.pathname === "/v1/oauth/token" && req.method === "POST") {
        const form = new URLSearchParams(bodyText);
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          return Response.json({
            access_token: "acct_access_token",
            livemode: false,
            refresh_token: "rt_code",
            scope: "stripe_apps",
            stripe_publishable_key: "pk_test_abc",
            stripe_user_id: "acct_market_test",
            token_type: "bearer",
          });
        }
        if (grant === "refresh_token") {
          return Response.json({
            access_token: "new_access_token",
            livemode: false,
            refresh_token: "rt_refreshed",
            scope: "stripe_apps",
            stripe_publishable_key: "pk_test_abc",
            stripe_user_id: "acct_refresh_test",
            token_type: "bearer",
          });
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (url.pathname === "/v1/account" && req.method === "GET") {
        return Response.json({ id: "acct_market_test", email: "merchant@example.com", display_name: "Merchant Co" });
      }
      if (url.pathname === "/v1/invoices" && req.method === "GET") {
        // Backfill failure mode: a 500 must degrade gracefully, never break
        // the install callback.
        if (stub.failInvoices) {
          return Response.json({ error: "server_error" }, { status: 500 });
        }
        return Response.json({ data: BACKFILL_INVOICES, has_more: false });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}

function get(u: string, cookie?: string): Promise<Response> {
  return fetch(u, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}

async function main(): Promise<void> {
  // Unit helpers must see the stub base + encryption key from module load.
  process.env.STRIPE_API_BASE = `http://localhost:${STRIPE_STUB_PORT}/v1`;
  process.env.TOKEN_ENCRYPTION_KEY = ENC_KEY;
  const mod = await import("./src/routes/oauth-app-install");

  startStub();
  resetStub();

  // ── (a0) account setup — the install flow is now GATED on a platform
  // account (reviewer round-2): sign up + verify via the magic-link flow and
  // reuse the cc_account cookie for every /oauth/install/start request. The
  // callback itself needs no cookie (the state row carries the account_id),
  // but the state is created by the signed-in /oauth/install/start, so the
  // cookie is required to reach the authorize hop in the first place.
  const accRes = await fetch(`${BASE}/api/account/request-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.99" },
    body: JSON.stringify({ email: "installer@example.com" }),
  });
  check("a0: account signup via magic link succeeds", accRes.status === 200 && (await accRes.json()).ok === true, `status=${accRes.status}`);
  const accDb = db();
  const accMagic = accDb.query(
    "SELECT ml.token FROM account_magic_links ml JOIN accounts a ON a.id = ml.account_id WHERE a.email = 'installer@example.com' ORDER BY ml.id DESC LIMIT 1"
  ).get() as { token: string } | null;
  const accVerify = await get(`${BASE}/api/account/verify?token=${encodeURIComponent(accMagic?.token ?? "")}&next=/oauth/install`);
  check("a0b: account verify mints the cc_account cookie", accVerify.status === 302 && (accVerify.headers.get("set-cookie") || "").startsWith("cc_account="), `status=${accVerify.status}`);
  const ACC_COOKIE = (accVerify.headers.get("set-cookie") || "").split(";")[0];
  const ACC_ID = (accDb.query("SELECT id FROM accounts WHERE email = 'installer@example.com'").get() as { id: number }).id;

  // ── (a) install page ──
  // Signed-OUT state (no account cookie): the page renders the sign-in /
  // create-account card, NOT the connect buttons.
  const page = await fetch(`${BASE}/oauth/install`);
  const pageHtml = await page.text();
  check("a1: install page 200 html", page.status === 200 && page.headers.get("content-type")?.includes("text/html"), `status=${page.status}`);
  check("a2: branded title", pageHtml.includes("Install CollectionsCopilot"), "");
  check("a2b: signed-out page shows the sign-in card (email input + magic-link button)", pageHtml.includes("Email me a sign-in link") && pageHtml.includes('type="email"') && pageHtml.includes("magic-link-form"), "");
  check("a2c: signed-out page shows NO connect buttons", !pageHtml.includes("oauth/install/start?link="), "");
  // Signed-IN state (account cookie): connect buttons + signed-in line.
  const pageIn = await (await fetch(`${BASE}/oauth/install`, { headers: { Cookie: ACC_COOKIE } })).text();
  check("a3: test-mode connect button (railway base from env)", pageIn.includes("https://stripe-cc-production.up.railway.app/oauth/install/start?link=test"), "");
  check("a4: live-mode connect button", pageIn.includes("https://stripe-cc-production.up.railway.app/oauth/install/start?link=live"), "");
  check("a4b: signed-in line (email + sign out)", pageIn.includes("Signed in as") && pageIn.includes("installer@example.com") && pageIn.includes("sign out"), "");
  check("a5: step instructions present", pageIn.includes("Click <strong>Connect with Stripe</strong>"), "");
  const auto = await get(`${BASE}/oauth/install?auto=1`);
  check("a6: ?auto=1 302s into authorize flow", auto.status === 302 && auto.headers.get("location") === "https://stripe-cc-production.up.railway.app/oauth/install/start?link=test", `loc=${auto.headers.get("location")}`);

  // ── (b) install start → marketplace authorize (account-gated) ──
  const startNoCookie = await get(`${BASE}/oauth/install/start?link=test`);
  check("b0: install/start WITHOUT account cookie → 302 back to /oauth/install", startNoCookie.status === 302 && startNoCookie.headers.get("location") === "https://stripe-cc-production.up.railway.app/oauth/install", `status=${startNoCookie.status} loc=${startNoCookie.headers.get("location")}`);
  const start = await get(`${BASE}/oauth/install/start?link=test`, ACC_COOKIE);
  check("b1: start 302s", start.status === 302, `status=${start.status}`);
  const loc = start.headers.get("location") || "";
  check("b2: marketplace authorize host", loc.startsWith("https://marketplace.stripe.com/oauth/v2/authorize?"), loc);
  const authUrl = new URL(loc);
  check("b3: client_id = STRIPE_CLIENT_ID", authUrl.searchParams.get("client_id") === "ca_test_client", authUrl.searchParams.get("client_id") || "");
  check("b4: redirect_uri = manifest allowed_redirect_uris entry", authUrl.searchParams.get("redirect_uri") === MANIFEST_REDIRECT_URI, authUrl.searchParams.get("redirect_uri") || "");
  const stateTest = authUrl.searchParams.get("state") || "";
  check("b5: state is CSRF-safe (48 hex + :test)", /^[0-9a-f]{48}:test$/.test(stateTest), stateTest);
  const d1 = db();
  const stateRow = d1.query("SELECT link_type, account_id FROM oauth_install_states WHERE state = ?").get(stateTest) as { link_type: string; account_id: number | null } | null;
  check("b6: state row stored with link type", stateRow?.link_type === "test", JSON.stringify(stateRow));
  check("b6b: state row stamped with the signed-in account_id", stateRow?.account_id === ACC_ID, JSON.stringify(stateRow));
  d1.close();

  const startLive = await get(`${BASE}/oauth/install/start?link=live`, ACC_COOKIE);
  const stateLive = new URL(startLive.headers.get("location") || "").searchParams.get("state") || "";
  check("b7: live link encodes :live in state", /^[0-9a-f]{48}:live$/.test(stateLive), stateLive);
  const startBogus = await get(`${BASE}/oauth/install/start?link=bogus`, ACC_COOKIE);
  const stateBogus = new URL(startBogus.headers.get("location") || "").searchParams.get("state") || "";
  check("b8: unknown link falls back to test", /^[0-9a-f]{48}:test$/.test(stateBogus), stateBogus);

  // ── (c) callback happy path ──
  resetStub();
  const cb = await get(`${BASE}/oauth/callback?code=code_test&state=${encodeURIComponent(stateTest)}`);
  check("c1: callback 302s", cb.status === 302, `status=${cb.status}`);
  const cbLoc = cb.headers.get("location") || "";
  const handoffUrl = new URL(cbLoc);
  check("c2: bounces through www-host /oauth/session", handoffUrl.origin === "https://www.getcollectionscopilot.com" && handoffUrl.pathname === "/oauth/session", cbLoc);
  const sessionToken = handoffUrl.searchParams.get("token") || "";
  check("c3: handoff next = www dashboard", handoffUrl.searchParams.get("next") === WWW_DASHBOARD, handoffUrl.searchParams.get("next") || "");
  const sc = cb.headers.get("set-cookie") || "";
  check("c4: session cookie set for the token", sc.startsWith(`session=${sessionToken};`), sc);
  check("c5: cookie matches production string", sc.includes("HttpOnly") && sc.includes("Secure") && sc.includes("SameSite=None") && sc.includes("Path=/") && sc.includes("Max-Age=2592000"), sc);

  const tokenCall = stub.calls.find((c) => c.path === "/v1/oauth/token");
  check("c6: token exchange called with grant_type=authorization_code", !!tokenCall && tokenCall.body.includes("grant_type=authorization_code") && tokenCall.body.includes("code=code_test"), JSON.stringify(stub.calls));
  check("c7: exchange uses Basic auth with the TEST developer key", tokenCall?.auth === `Basic ${Buffer.from("sk_test_app_dev:").toString("base64")}`, tokenCall?.auth || "");
  const acctCall = stub.calls.find((c) => c.path === "/v1/account");
  check("c8: account fetched with Bearer access token", acctCall?.auth === "Bearer acct_access_token", acctCall?.auth || "");

  const d2 = db();
  const tokRow = d2.query("SELECT * FROM oauth_tokens WHERE stripe_user_id = 'acct_market_test'").get() as Record<string, unknown> | null;
  check("c9: oauth_tokens row stored", !!tokRow, JSON.stringify(tokRow));
  check("c10: access token encrypted at rest", typeof tokRow?.access_token === "string" && tokRow.access_token.startsWith("enc:v1:"), String(tokRow?.access_token));
  check("c11: refresh token encrypted at rest", typeof tokRow?.refresh_token === "string" && tokRow.refresh_token.startsWith("enc:v1:"), String(tokRow?.refresh_token));
  check("c12: livemode + link_type recorded", tokRow?.livemode === 0 && tokRow?.link_type === "test", JSON.stringify({ livemode: tokRow?.livemode, link_type: tokRow?.link_type }));
  check("c13: expires_at in the future", typeof tokRow?.expires_at === "string" && tokRow.expires_at > "2026-01-01", String(tokRow?.expires_at));
  const connRow = d2.query("SELECT id, merchant_id FROM stripe_connections WHERE id = 'acct_market_test'").get() as { id: string; merchant_id: number } | null;
  check("c14: stripe_connections mirror row", !!connRow, JSON.stringify(connRow));
  const merchRow = d2.query("SELECT email, trust_mode, account_id FROM merchants WHERE stripe_account_id = 'acct_market_test'").get() as { email: string; trust_mode: string; account_id: number | null } | null;
  check("c15: merchant created with account email", merchRow?.email === "merchant@example.com", JSON.stringify(merchRow));
  check("c15b: merchant LINKED to the platform account (account_id from the state row)", merchRow?.account_id === ACC_ID, JSON.stringify(merchRow));
  const sessRow = d2.query("SELECT merchant_id FROM sessions WHERE token = ?").get(sessionToken) as { merchant_id: number } | null;
  check("c16: session minted for the merchant", !!sessRow && sessRow.merchant_id === connRow?.merchant_id, JSON.stringify(sessRow));
  const stateAfter = d2.query("SELECT 1 AS ok FROM oauth_install_states WHERE state = ?").get(stateTest);
  check("c17: state consumed (one-time)", stateAfter === null, JSON.stringify(stateAfter));

  // ── (c2) post-connect backfill: invoices synced from the merchant's account ──
  const invCall = stub.calls.find((c) => c.path === "/v1/invoices");
  check("c18: backfill fetched /v1/invoices with the merchant's Bearer access token", !!invCall && invCall.auth === "Bearer acct_access_token", JSON.stringify(stub.calls));
  const invRows = d2.query(
    "SELECT stripe_invoice_id, customer_name, customer_email, amount_cents, currency, due_date, status FROM invoices WHERE merchant_id = ?"
  ).all(connRow.merchant_id) as Array<Record<string, unknown>>;
  const invById = new Map(invRows.map((r) => [r.stripe_invoice_id, r]));
  const ovd = invById.get("in_ovd1");
  check("c19: overdue open invoice stored as 'overdue' with amount_due + due_date", !!ovd && ovd.status === "overdue" && ovd.amount_cents === 12345 && ovd.currency === "usd" && ovd.due_date === EXPECTED_BACKFILL_DATES.ovd && ovd.customer_name === "Overdue Co" && ovd.customer_email === "overdue@example.com", JSON.stringify(ovd));
  const paid = invById.get("in_paid1");
  check("c20: paid invoice stored as 'paid' with amount_paid + created-as-due_date", !!paid && paid.status === "paid" && paid.amount_cents === 5000 && paid.due_date === EXPECTED_BACKFILL_DATES.paid, JSON.stringify(paid));
  const open = invById.get("in_open1");
  check("c21: future-due open invoice stored as 'open'", !!open && open.status === "open" && open.amount_cents === 777 && open.currency === "eur" && open.due_date === EXPECTED_BACKFILL_DATES.open, JSON.stringify(open));
  const nameless = invById.get("in_nameless1");
  check("c22: missing customer name/email fall back to em-dash", !!nameless && nameless.customer_name === "—" && nameless.customer_email === "—", JSON.stringify(nameless));
  check("c23: void/draft/uncollectible invoices not stored (not active)", !invById.has("in_void1") && !invById.has("in_draft1") && !invById.has("in_unc1"), JSON.stringify([...invById.keys()]));

  // ── (c3) backfill idempotency: a re-install (fresh state, same Stripe
  // account) must NOT duplicate invoice rows — upsertInvoice updates in place ──
  const start2 = await get(`${BASE}/oauth/install/start?link=test`, ACC_COOKIE);
  const state2 = new URL(start2.headers.get("location") || "").searchParams.get("state") || "";
  resetStub();
  const cb2 = await get(`${BASE}/oauth/callback?code=code_test&state=${encodeURIComponent(state2)}`);
  check("c24: re-install callback still 302s through the handoff", cb2.status === 302 && (cb2.headers.get("location") || "").includes("/oauth/session"), `status=${cb2.status}`);
  const d3 = db();
  const invRows2 = d3.query("SELECT stripe_invoice_id FROM invoices WHERE merchant_id = ?").all(connRow.merchant_id) as Array<{ stripe_invoice_id: string }>;
  check("c25: re-run upserts in place — no duplicate rows", invRows2.length === invRows.length && invRows2.every((r) => invById.has(r.stripe_invoice_id)), JSON.stringify(invRows2));
  d3.close();

  // ── (c4) backfill never fails the install when the invoices call errors ──
  const start3 = await get(`${BASE}/oauth/install/start?link=test`, ACC_COOKIE);
  const state3 = new URL(start3.headers.get("location") || "").searchParams.get("state") || "";
  resetStub();
  stub.failInvoices = true;
  const cb3 = await get(`${BASE}/oauth/callback?code=code_test&state=${encodeURIComponent(state3)}`);
  check("c26: invoices 500 → callback still succeeds (302 handoff)", cb3.status === 302 && (cb3.headers.get("location") || "").includes("/oauth/session"), `status=${cb3.status} loc=${cb3.headers.get("location")}`);
  const d4 = db();
  const invRows3 = d4.query("SELECT stripe_invoice_id FROM invoices WHERE merchant_id = ?").all(connRow.merchant_id) as Array<{ stripe_invoice_id: string }>;
  check("c27: failed backfill leaves existing rows untouched", invRows3.length === invRows.length, JSON.stringify(invRows3));
  // Unit-level never-throw check against the failing stub (keep failInvoices on).
  const bfFail = await mod.backfillMerchantInvoices(d4, connRow.merchant_id, "acct_access_token");
  check("c28: backfillMerchantInvoices returns an error result, never throws", bfFail.inserted === 0 && typeof bfFail.error === "string", JSON.stringify(bfFail));
  d4.close();

  // ── (c5) /stats carries the banner's inputs (plan/sub_status/livemode) ──
  const statsRes = await fetch(`${BASE}/stats`, { headers: { Cookie: `session=${sessionToken}` } });
  const stats = await statsRes.json();
  check("c29: /stats reports stripeConnected for the installed merchant", statsRes.status === 200 && stats.stripeConnected === true, JSON.stringify(stats));
  check("c30: /stats reports plan=free + sub_status=none for a fresh install (subscription required)", stats.plan === "free" && stats.sub_status === "none", JSON.stringify(stats));
  check("c31: /stats reports the connection's livemode from oauth_tokens (test → false)", stats.stripe_livemode === false, JSON.stringify(stats));

  // ── (c6) dashboard HTML carries the status banner (markup + renderer) ──
  const dash = await (await fetch(`${BASE}/dashboard`)).text();
  check("c32: dashboard has the status banner markup", dash.includes('id="status-banner"') && dash.includes('id="status-banner-title"') && dash.includes('id="status-banner-actions"') && dash.includes('id="status-banner-dot"'), "");
  check("c33: dashboard banner renderer covers all three states (reviewer wording)", dash.includes("renderStatusBanner") && dash.includes("Connected to Stripe — subscription required") && dash.includes("Active — Connected to Stripe") && dash.includes("Subscribe Standard — $15/mo") && dash.includes("Subscribe Pro — $29/mo") && dash.includes("Not connected to Stripe"), "");
  d2.close();

  // ── (d) state replay fails cleanly ──
  resetStub();
  const replay = await get(`${BASE}/oauth/callback?code=code_again&state=${encodeURIComponent(stateTest)}`);
  const replayHtml = await replay.text();
  check("d1: replayed state → 200 error page", replay.status === 200 && replayHtml.includes("invalid or has expired"), `status=${replay.status}`);
  check("d2: no Stripe exchange attempted", stub.calls.length === 0, JSON.stringify(stub.calls));

  // ── (e) invalid states / missing params / denial ──
  const unknown = await get(`${BASE}/oauth/callback?code=x&state=deadbeef`);
  check("e1: unknown state → clean error page", unknown.status === 200 && (await unknown.text()).includes("invalid or has expired"), `status=${unknown.status}`);
  const missing = await get(`${BASE}/oauth/callback?code=x`);
  check("e2: code without state → specific clean error page (bare-link diagnosis)", missing.status === 200 && (await missing.text()).includes("no state parameter"), `status=${missing.status}`);
  const stateOnly = await get(`${BASE}/oauth/callback?state=abc`);
  check("e2a: state without code → specific clean error page", stateOnly.status === 200 && (await stateOnly.text()).includes("no authorization code"), `status=${stateOnly.status}`);
  const bare = await get(`${BASE}/oauth/callback`);
  check("e2b: bare callback (no params) keeps pre-existing Express redirect", bare.status === 302 && (bare.headers.get("location") || "").includes("/dashboard?error=missing_account"), `status=${bare.status} loc=${bare.headers.get("location")}`);
  const denied = await get(`${BASE}/oauth/callback?error=access_denied&error_description=User+declined`);
  const deniedHtml = await denied.text();
  check("e3: denial → friendly page", denied.status === 200 && deniedHtml.includes("Authorization was not completed"), `status=${denied.status}`);
  const mismatch = await get(`${BASE}/oauth/callback?error=redirect_uri_mismatch&error_description=The+redirect_uri+is+not+registered`);
  const mismatchHtml = await mismatch.text();
  check("e4: redirect_uri_mismatch → page shows Stripe's error + App Settings hint", mismatch.status === 200 && mismatchHtml.includes("redirect_uri_mismatch") && mismatchHtml.includes("The redirect_uri is not registered") && mismatchHtml.includes("Stripe App Settings") && mismatchHtml.includes("no trailing slash"), `status=${mismatch.status}`);
  const descOnly = await get(`${BASE}/oauth/callback?error_description=Something+broke`);
  const descOnlyHtml = await descOnly.text();
  check("e4b: error_description alone → handled as unknown error, not generic missing-params", descOnly.status === 200 && descOnlyHtml.includes("unknown_error") && descOnlyHtml.includes("Something broke") && !descOnlyHtml.includes("missing the authorization code or state"), `status=${descOnly.status}`);
  const invalidClient = await get(`${BASE}/oauth/callback?error=invalid_client_id&error_description=bad`);
  const invalidClientHtml = await invalidClient.text();
  check("e4c: invalid_client_id → hints at server env check", invalidClient.status === 200 && invalidClientHtml.includes("STRIPE_APP_LIVE_CLIENT_ID"), `status=${invalidClient.status}`);

  // ── (f) Express web-connect branch untouched: account param (no code) ──
  // `?account=` (empty) takes the Express handler's missing-account path — a
  // 302 to the dashboard error, NOT the install handler's 200 HTML page — and
  // makes no Stripe call (the Express handler would otherwise hit the SDK,
  // which doesn't honor STRIPE_API_BASE in tests).
  const express = await get(`${BASE}/oauth/callback?account=`);
  check("f1: account param → Express callback (302 to dashboard error, no code exchange)", express.status === 302 && (express.headers.get("location") || "").includes("/dashboard?error=missing_account"), `status=${express.status} loc=${express.headers.get("location")}`);

  // ── (g) unit: state helpers ──
  const u = db();
  const s1 = mod.createInstallState(u, "test");
  check("g1: created state matches shape", /^[0-9a-f]{48}:test$/.test(s1), s1);
  check("g2: consume returns link type", mod.consumeInstallState(u, s1)?.link_type === "test", "");
  check("g3: consume is one-time", mod.consumeInstallState(u, s1) === null, "");
  check("g4: unknown state → null", mod.consumeInstallState(u, "nope:test") === null, "");
  check("g5: empty state → null", mod.consumeInstallState(u, "") === null, "");
  const s2 = mod.createInstallState(u, "live", 7);
  const consumed2 = mod.consumeInstallState(u, s2);
  check("g6: account_id roundtrips through create/consume", consumed2?.link_type === "live" && consumed2.account_id === 7, JSON.stringify(consumed2));
  const s3 = mod.createInstallState(u, "test", null);
  check("g7: legacy create (no account) → consumed account_id null", mod.consumeInstallState(u, s3)?.account_id === null, "");

  // ── (h) unit: developer key selection (graceful when unset) ──
  process.env.STRIPE_APP_TEST_KEY = "sk_test_unit";
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";
  check("h1: test key selected", mod.appDevKeyFor("test") === "sk_test_unit", "");
  check("h2: live key selected", mod.appDevKeyFor("live") === "sk_live_unit", "");
  delete process.env.STRIPE_APP_LIVE_KEY;
  // The shell exports STRIPE_SECRET_KEY — strip it so the null path is real.
  delete process.env.STRIPE_SECRET_KEY;
  check("h3: live key null when neither STRIPE_APP_LIVE_KEY nor STRIPE_SECRET_KEY set (no crash)", mod.appDevKeyFor("live") === null, "");
  process.env.STRIPE_SECRET_KEY = "sk_live_fallback";
  check("h3b: live key falls back to STRIPE_SECRET_KEY", mod.appDevKeyFor("live") === "sk_live_fallback", "");
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";
  check("h3c: STRIPE_APP_LIVE_KEY overrides the STRIPE_SECRET_KEY fallback", mod.appDevKeyFor("live") === "sk_live_unit", "");
  delete process.env.STRIPE_SECRET_KEY;

  // ── (h2) unit: per-mode client id selection (mode env wins, fallback) ──
  process.env.STRIPE_CLIENT_ID = "ca_fallback";
  process.env.STRIPE_APP_TEST_CLIENT_ID = "ca_test_mode";
  process.env.STRIPE_APP_LIVE_CLIENT_ID = "ca_live_mode";
  check("h4: test client id from STRIPE_APP_TEST_CLIENT_ID", mod.appClientIdFor("test") === "ca_test_mode", "");
  check("h5: live client id from STRIPE_APP_LIVE_CLIENT_ID", mod.appClientIdFor("live") === "ca_live_mode", "");
  delete process.env.STRIPE_APP_TEST_CLIENT_ID;
  delete process.env.STRIPE_APP_LIVE_CLIENT_ID;
  check("h6: falls back to STRIPE_CLIENT_ID when mode vars unset", mod.appClientIdFor("test") === "ca_fallback" && mod.appClientIdFor("live") === "ca_fallback", "");
  delete process.env.STRIPE_CLIENT_ID;
  check("h7: null when nothing set", mod.appClientIdFor("test") === null && mod.appClientIdFor("live") === null, "");
  check("h7b: missingEnvFor names the client id var when unset", mod.missingEnvFor("test").includes("STRIPE_APP_TEST_CLIENT_ID"), JSON.stringify(mod.missingEnvFor("test")));
  process.env.STRIPE_CLIENT_ID = "ca_fallback";
  process.env.STRIPE_APP_TEST_CLIENT_ID = "ca_test_mode";
  process.env.STRIPE_APP_LIVE_CLIENT_ID = "ca_live_mode";
  check("h8: missingEnvFor empty when everything resolves", mod.missingEnvFor("test").length === 0 && mod.missingEnvFor("live").length === 0, JSON.stringify([mod.missingEnvFor("test"), mod.missingEnvFor("live")]));
  delete process.env.STRIPE_APP_LIVE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  check("h9: missingEnvFor reports the combined live key entry when both unset", mod.missingEnvFor("live").length === 1 && mod.missingEnvFor("live")[0] === "STRIPE_APP_LIVE_KEY or STRIPE_SECRET_KEY", JSON.stringify(mod.missingEnvFor("live")));
  process.env.STRIPE_SECRET_KEY = "sk_live_fallback";
  check("h9b: STRIPE_SECRET_KEY satisfies live's key slot (no key entry)", mod.missingEnvFor("live").length === 0, JSON.stringify(mod.missingEnvFor("live")));
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";

  // ── (i) unit: authorize URL builder (per-mode client id) ──
  process.env.STRIPE_CLIENT_ID = "ca_unit_client";
  delete process.env.STRIPE_APP_TEST_CLIENT_ID;
  const built = mod.buildAuthorizeUrl("abc:test", "test");
  check("i1: test mode falls back to STRIPE_CLIENT_ID", "url" in built && (built as { url: string }).url.includes("client_id=ca_unit_client") && (built as { url: string }).url.includes("redirect_uri=") && (built as { url: string }).url.includes("state=abc%3Atest"), JSON.stringify(built));
  process.env.STRIPE_APP_TEST_CLIENT_ID = "ca_test_unit";
  const builtTest = mod.buildAuthorizeUrl("abc:test", "test");
  check("i1b: test mode prefers STRIPE_APP_TEST_CLIENT_ID", "url" in builtTest && (builtTest as { url: string }).url.includes("client_id=ca_test_unit"), JSON.stringify(builtTest));
  process.env.STRIPE_APP_LIVE_CLIENT_ID = "ca_live_unit";
  const builtLive = mod.buildAuthorizeUrl("abc:live", "live");
  check("i1c: live mode prefers STRIPE_APP_LIVE_CLIENT_ID", "url" in builtLive && (builtLive as { url: string }).url.includes("client_id=ca_live_unit"), JSON.stringify(builtLive));
  delete process.env.STRIPE_APP_LIVE_CLIENT_ID;
  const builtLiveFallback = mod.buildAuthorizeUrl("abc:live", "live");
  check("i1d: live mode falls back to STRIPE_CLIENT_ID", "url" in builtLiveFallback && (builtLiveFallback as { url: string }).url.includes("client_id=ca_unit_client"), JSON.stringify(builtLiveFallback));
  delete process.env.STRIPE_CLIENT_ID;
  delete process.env.STRIPE_APP_TEST_CLIENT_ID;
  const builtMissing = mod.buildAuthorizeUrl("abc:test", "test");
  check("i2: missing client id → clear error naming both env vars", "error" in builtMissing && (builtMissing as { error: string }).error.includes("STRIPE_APP_TEST_CLIENT_ID") && (builtMissing as { error: string }).error.includes("STRIPE_CLIENT_ID"), JSON.stringify(builtMissing));
  const builtMissingLive = mod.buildAuthorizeUrl("abc:live", "live");
  check("i2b: missing live client id → error names STRIPE_APP_LIVE_CLIENT_ID", "error" in builtMissingLive && (builtMissingLive as { error: string }).error.includes("STRIPE_APP_LIVE_CLIENT_ID"), JSON.stringify(builtMissingLive));
  // ── (i3) unit: trailing-slash normalization of BASE_URL / redirect_uri ──
  // The redirect_uri must be byte-identical to the manifest's
  // allowed_redirect_uris entry; a BASE_URL (or STRIPE_APP_REDIRECT_URI) that
  // carries a trailing slash must be normalized before building the URL.
  const prevBase = process.env.BASE_URL;
  process.env.STRIPE_CLIENT_ID = "ca_unit_client";
  process.env.BASE_URL = "https://stripe-cc-production.up.railway.app/";
  delete process.env.STRIPE_APP_REDIRECT_URI;
  const builtSlash = mod.buildAuthorizeUrl("abc:test", "test");
  check("i3a: BASE_URL trailing slash normalized — redirect_uri byte-identical to manifest", "url" in builtSlash && (builtSlash as { url: string }).url.includes("redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback"), JSON.stringify(builtSlash));
  process.env.STRIPE_APP_REDIRECT_URI = "https://stripe-cc-production.up.railway.app/oauth/callback/";
  const builtSlashOverride = mod.buildAuthorizeUrl("abc:test", "test");
  check("i3b: STRIPE_APP_REDIRECT_URI trailing slash normalized", "url" in builtSlashOverride && (builtSlashOverride as { url: string }).url.includes("redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback"), JSON.stringify(builtSlashOverride));
  delete process.env.STRIPE_APP_REDIRECT_URI;
  if (prevBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prevBase;
  process.env.STRIPE_CLIENT_ID = "ca_unit_client";

  // ── (j) unit: code exchange (through the stub) ──
  resetStub();
  process.env.STRIPE_APP_TEST_KEY = "sk_test_app_dev";
  const ex = await mod.exchangeCodeForTokens("code_unit", "test");
  check("j1: exchange succeeds", ex.ok && ex.tokens.access_token === "acct_access_token", JSON.stringify(ex));
  check("j2: scope stripe_apps captured", ex.ok && ex.tokens.scope === "stripe_apps", "");
  const exCall = stub.calls.find((c) => c.path === "/v1/oauth/token");
  check("j3: stub got the code + grant", exCall?.body.includes("code=code_unit") && exCall.body.includes("grant_type=authorization_code"), exCall?.body || "");
  delete process.env.STRIPE_APP_LIVE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const exLive = await mod.exchangeCodeForTokens("code_unit", "live");
  check("j4: neither live key nor STRIPE_SECRET_KEY → error naming both, no network call", !exLive.ok && exLive.error.includes("STRIPE_APP_LIVE_KEY") && exLive.error.includes("STRIPE_SECRET_KEY"), JSON.stringify(exLive));
  process.env.STRIPE_SECRET_KEY = "sk_live_fallback";
  const exLiveFallback = await mod.exchangeCodeForTokens("code_fallback", "live");
  const exLiveCall = stub.calls.find((c) => c.path === "/v1/oauth/token" && c.body.includes("code=code_fallback"));
  check("j5: live exchange falls back to STRIPE_SECRET_KEY as Basic auth", exLiveFallback.ok && exLiveCall?.auth === `Basic ${Buffer.from("sk_live_fallback:").toString("base64")}`, JSON.stringify({ exLiveFallback, calls: stub.calls }));
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";

  // ── (k) unit: token storage (encrypted at rest) ──
  mod.saveAppOAuthTokens(u, {
    stripe_user_id: "acct_unit",
    merchant_id: 1,
    access_token: "plain_access",
    refresh_token: "plain_refresh",
    stripe_publishable_key: "pk_unit",
    livemode: false,
    link_type: "test",
  });
  const stored = u.query("SELECT access_token, refresh_token FROM oauth_tokens WHERE stripe_user_id = 'acct_unit'").get() as { access_token: string; refresh_token: string };
  check("k1: tokens encrypted at rest", stored.access_token.startsWith("enc:v1:") && stored.refresh_token.startsWith("enc:v1:"), JSON.stringify(stored));
  const read = mod.getAppOAuthTokens(u, "acct_unit");
  check("k2: decrypted on read", read?.access_token === "plain_access" && read.refresh_token === "plain_refresh", JSON.stringify(read));
  mod.saveAppOAuthTokens(u, { stripe_user_id: "acct_unit", merchant_id: 1, access_token: "plain_access2", refresh_token: "plain_refresh2", stripe_publishable_key: "pk_unit", livemode: true, link_type: "test" });
  const read2 = mod.getAppOAuthTokens(u, "acct_unit");
  check("k3: upsert updates pair", read2?.access_token === "plain_access2" && read2.refresh_token === "plain_refresh2" && read2.livemode === 1, JSON.stringify(read2));

  // ── (l) unit: refresh ──
  // Seed an EXPIRED pair directly in the DB (the module stores tokens in its
  // own format, so write the encrypted value through the module for realism).
  mod.saveAppOAuthTokens(u, {
    stripe_user_id: "acct_refresh_test",
    merchant_id: 1,
    access_token: "old_access",
    refresh_token: "rt_old",
    stripe_publishable_key: "pk_unit",
    livemode: false,
    link_type: "test",
  });
  u.run("UPDATE oauth_tokens SET expires_at = datetime('now', '-1 hour') WHERE stripe_user_id = 'acct_refresh_test'");
  resetStub();
  const rf1 = await mod.refreshAppAccessToken(u, "acct_refresh_test");
  check("l1: expired pair refreshes", rf1.ok && rf1.refreshed && rf1.access_token === "new_access_token", JSON.stringify(rf1));
  const rfCall = stub.calls.find((c) => c.path === "/v1/oauth/token");
  check("l2: refresh used grant_type=refresh_token + stored refresh token", rfCall?.body.includes("grant_type=refresh_token") && rfCall.body.includes("refresh_token=rt_old"), rfCall?.body || "");
  check("l3: refresh used the TEST developer key", rfCall?.auth === `Basic ${Buffer.from("sk_test_app_dev:").toString("base64")}`, rfCall?.auth || "");
  const afterRf = mod.getAppOAuthTokens(u, "acct_refresh_test");
  check("l4: new pair stored (access + ROLLED refresh)", afterRf?.access_token === "new_access_token" && afterRf.refresh_token === "rt_refreshed", JSON.stringify(afterRf));
  const fresh = u.query("SELECT expires_at FROM oauth_tokens WHERE stripe_user_id = 'acct_refresh_test'").get() as { expires_at: string };
  check("l5: new expires_at in the future", fresh.expires_at > "2026-01-01", fresh.expires_at);
  resetStub();
  const rf2 = await mod.refreshAppAccessToken(u, "acct_refresh_test");
  check("l6: still-valid pair → no network call", rf2.ok && !rf2.refreshed && rf2.access_token === "new_access_token" && stub.calls.length === 0, JSON.stringify({ rf2, calls: stub.calls }));
  const rf3 = await mod.refreshAppAccessToken(u, "acct_refresh_test", true);
  check("l7: force refreshes anyway", rf3.ok && rf3.refreshed && stub.calls.length === 1, JSON.stringify({ rf3, calls: stub.calls }));

  mod.saveAppOAuthTokens(u, { stripe_user_id: "acct_no_refresh", merchant_id: 1, access_token: "a", refresh_token: null, stripe_publishable_key: "", livemode: false, link_type: "test" });
  u.run("UPDATE oauth_tokens SET expires_at = datetime('now', '-1 hour') WHERE stripe_user_id = 'acct_no_refresh'");
  const rf4 = await mod.refreshAppAccessToken(u, "acct_no_refresh");
  check("l8: missing refresh token → clean error", !rf4.ok && rf4.error.includes("No refresh token"), JSON.stringify(rf4));
  const rf5 = await mod.refreshAppAccessToken(u, "acct_ghost");
  check("l9: unknown user → clean error", !rf5.ok && rf5.error.includes("No stored tokens"), JSON.stringify(rf5));
  mod.saveAppOAuthTokens(u, { stripe_user_id: "acct_live_no_key", merchant_id: 1, access_token: "a", refresh_token: "rt", stripe_publishable_key: "", livemode: 1, link_type: "live" });
  u.run("UPDATE oauth_tokens SET expires_at = datetime('now', '-1 hour') WHERE stripe_user_id = 'acct_live_no_key'");
  delete process.env.STRIPE_APP_LIVE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const rf6 = await mod.refreshAppAccessToken(u, "acct_live_no_key");
  check("l10: neither live key nor STRIPE_SECRET_KEY → clean error naming both", !rf6.ok && rf6.error.includes("STRIPE_APP_LIVE_KEY") && rf6.error.includes("STRIPE_SECRET_KEY"), JSON.stringify(rf6));
  process.env.STRIPE_SECRET_KEY = "sk_live_fallback";
  mod.saveAppOAuthTokens(u, { stripe_user_id: "acct_live_fallback", merchant_id: 1, access_token: "a", refresh_token: "rt_live_fallback", stripe_publishable_key: "", livemode: 1, link_type: "live" });
  u.run("UPDATE oauth_tokens SET expires_at = datetime('now', '-1 hour') WHERE stripe_user_id = 'acct_live_fallback'");
  resetStub();
  const rf7 = await mod.refreshAppAccessToken(u, "acct_live_fallback");
  const rfCallFallback = stub.calls.find((c) => c.path === "/v1/oauth/token" && c.body.includes("refresh_token=rt_live_fallback"));
  check("l11: live refresh falls back to STRIPE_SECRET_KEY as Basic auth", rf7.ok && rf7.refreshed && rfCallFallback?.auth === `Basic ${Buffer.from("sk_live_fallback:").toString("base64")}`, JSON.stringify({ rf7, calls: stub.calls }));
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";
  u.close();

  // ── (m) unit: install page per-mode configuration + account gate ──
  // A mode's button appears only when BOTH its client id and its developer key
  // resolve; the "not configured" notice lists the missing env vars per mode.
  // Since the account layer the page is GATED: connect buttons render only for
  // a signed-in account ({email} passed here), otherwise the sign-in card.
  const pageBase = "https://stripe-cc-production.up.railway.app";
  const ACCT = { email: "test@example.com" };
  const modesWith = (): ("test" | "live")[] => (["test", "live"] as const).filter((lt) => mod.appClientIdFor(lt) && mod.appDevKeyFor(lt));
  const missingMap = (): { test: string[]; live: string[] } => ({ test: mod.missingEnvFor("test"), live: mod.missingEnvFor("live") });

  process.env.STRIPE_CLIENT_ID = "ca_page_fallback";
  process.env.STRIPE_APP_TEST_CLIENT_ID = "ca_test_page";
  process.env.STRIPE_APP_TEST_KEY = "sk_test_page";
  process.env.STRIPE_APP_LIVE_CLIENT_ID = "ca_live_page";
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_page";
  const pageAll = mod.installPageHtml(pageBase, modesWith(), missingMap(), ACCT);
  check("m1: test button shown when test client id + test key both set", pageAll.includes(`${pageBase}/oauth/install/start?link=test`), "");
  check("m2: live button shown when live client id + live key both set", pageAll.includes(`${pageBase}/oauth/install/start?link=live`), "");
  check("m2b: signed-in line rendered", pageAll.includes("Signed in as") && pageAll.includes("test@example.com") && pageAll.includes("sign out"), "");

  // Test client id missing (fallback removed too) → test button gone, live
  // button stays, per-mode notice names the missing client id var.
  delete process.env.STRIPE_APP_TEST_CLIENT_ID;
  delete process.env.STRIPE_CLIENT_ID;
  const pageNoTest = mod.installPageHtml(pageBase, modesWith(), missingMap(), ACCT);
  check("m3: test button hidden when test client id missing", !pageNoTest.includes(`${pageBase}/oauth/install/start?link=test`), "");
  check("m4: live button still shown", pageNoTest.includes(`${pageBase}/oauth/install/start?link=live`), "");
  check("m5: notice names STRIPE_APP_TEST_CLIENT_ID", pageNoTest.includes("STRIPE_APP_TEST_CLIENT_ID"), "");

  // Nothing resolves → full per-mode notice. (STRIPE_SECRET_KEY must be unset
  // too — the shell exports it, and it would otherwise satisfy live's key
  // slot and remove the key entry from the notice.)
  delete process.env.STRIPE_APP_LIVE_CLIENT_ID;
  delete process.env.STRIPE_APP_TEST_KEY;
  delete process.env.STRIPE_APP_LIVE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const pageNone = mod.installPageHtml(pageBase, modesWith(), missingMap(), ACCT);
  check("m6: nothing configured → notice present", pageNone.includes("Installation is not configured yet."), "");
  check("m7: notice lists test-mode missing vars", pageNone.includes("Test mode: set") && pageNone.includes("STRIPE_APP_TEST_CLIENT_ID") && pageNone.includes("STRIPE_APP_TEST_KEY"), "");
  check("m8: notice lists live-mode missing vars", pageNone.includes("Live mode: set") && pageNone.includes("STRIPE_APP_LIVE_CLIENT_ID") && pageNone.includes("STRIPE_APP_LIVE_KEY") && pageNone.includes("STRIPE_SECRET_KEY"), "");

  // Live key slot satisfied by STRIPE_SECRET_KEY alone → live button shows
  // (client id via the STRIPE_CLIENT_ID fallback); test stays hidden (its
  // developer key is still unset).
  process.env.STRIPE_CLIENT_ID = "ca_page_fallback";
  process.env.STRIPE_SECRET_KEY = "sk_live_fallback";
  const pageLiveFallback = mod.installPageHtml(pageBase, modesWith(), missingMap(), ACCT);
  check("m9: live button shows when STRIPE_SECRET_KEY satisfies live's key slot", pageLiveFallback.includes(`${pageBase}/oauth/install/start?link=live`), "");
  check("m10: test button still hidden (test key unset)", !pageLiveFallback.includes(`${pageBase}/oauth/install/start?link=test`), "");
  delete process.env.STRIPE_SECRET_KEY;

  // ── (m2) unit: the account gate itself ──
  const pageNoAcct = mod.installPageHtml(pageBase, modesWith(), missingMap());
  check("m11: no account → sign-in card (email input + magic-link button), NO connect buttons", pageNoAcct.includes("Email me a sign-in link") && pageNoAcct.includes('type="email"') && !pageNoAcct.includes("oauth/install/start?link="), "");
  const pageNoAcctNotice = mod.installPageHtml(pageBase, [], { test: ["STRIPE_APP_TEST_CLIENT_ID"], live: [] });
  check("m12: no account → the 'not configured' branch still renders the sign-in card (never the connect UI)", pageNoAcctNotice.includes("Email me a sign-in link") && !pageNoAcctNotice.includes("Installation is not configured yet."), "");
  const pageAcctDash = mod.installPageHtml(pageBase, modesWith(), missingMap(), ACCT, "https://stripe-cc-production.up.railway.app/dashboard");
  check("m13: signed-in with a connected merchant → dashboard shortcut shown", pageAcctDash.includes("You're connected") && pageAcctDash.includes("open your dashboard"), "");
  check("m14: signed-in without a merchant → no dashboard shortcut", !pageAll.includes("open your dashboard"), "");
  // Restore env for any later sections.
  process.env.STRIPE_CLIENT_ID = "ca_unit_client";
  process.env.STRIPE_APP_TEST_CLIENT_ID = "ca_test_unit";
  process.env.STRIPE_APP_LIVE_CLIENT_ID = "ca_live_unit";
  process.env.STRIPE_APP_TEST_KEY = "sk_test_unit";
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
