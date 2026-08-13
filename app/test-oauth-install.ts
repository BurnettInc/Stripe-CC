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
 *   (a) /oauth/install renders the branded install page with per-mode
 *       "Connect with Stripe" buttons (test + live) and step instructions;
 *       ?auto=1 302s into the authorize flow
 *   (b) /oauth/install/start?link=test → 302 to
 *       https://marketplace.stripe.com/oauth/v2/authorize with
 *       client_id=STRIPE_CLIENT_ID, redirect_uri=the manifest URI, and a
 *       CSRF-safe state ("<48 hex>:<link-type>") stored in oauth_install_states
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
 *
 * Unit level (direct module imports in this process, own DB handle, env
 * mutated locally and restored):
 *   (g) create/consume install state (roundtrip, one-time, unknown → null)
 *   (h) appDevKeyFor picks test/live key, null when unset (graceful no-op)
 *   (i) buildAuthorizeUrl: client_id + redirect_uri + state, or a clear error
 *       when STRIPE_CLIENT_ID is unset
 *   (j) exchangeCodeForTokens: happy path through the stub; missing-key error
 *       without any network call
 *   (k) save/getAppOAuthTokens: encrypted at rest, decrypted on read, upsert
 *   (l) refreshAppAccessToken: expired pair → refresh (stub, grant_type=
 *       refresh_token, rolling refresh token stored), valid pair → no network
 *       call, missing refresh token / missing key / unknown user → clean errors
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

// ── In-process Stripe stub (OAuth token + account endpoints) ──
const stub: {
  calls: { path: string; method: string; auth: string; body: string }[];
  server: ReturnType<typeof Bun.serve>;
} = {
  calls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};

function resetStub(): void {
  stub.calls = [];
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
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}

function get(u: string): Promise<Response> {
  return fetch(u, { redirect: "manual" });
}

async function main(): Promise<void> {
  // Unit helpers must see the stub base + encryption key from module load.
  process.env.STRIPE_API_BASE = `http://localhost:${STRIPE_STUB_PORT}/v1`;
  process.env.TOKEN_ENCRYPTION_KEY = ENC_KEY;
  const mod = await import("./src/routes/oauth-app-install");

  startStub();
  resetStub();

  // ── (a) install page ──
  const page = await fetch(`${BASE}/oauth/install`);
  const pageHtml = await page.text();
  check("a1: install page 200 html", page.status === 200 && page.headers.get("content-type")?.includes("text/html"), `status=${page.status}`);
  check("a2: branded title", pageHtml.includes("Install CollectionsCopilot"), "");
  check("a3: test-mode connect button (railway base from env)", pageHtml.includes("https://stripe-cc-production.up.railway.app/oauth/install/start?link=test"), "");
  check("a4: live-mode connect button", pageHtml.includes("https://stripe-cc-production.up.railway.app/oauth/install/start?link=live"), "");
  check("a5: step instructions present", pageHtml.includes("Click <strong>Connect with Stripe</strong>"), "");
  const auto = await get(`${BASE}/oauth/install?auto=1`);
  check("a6: ?auto=1 302s into authorize flow", auto.status === 302 && auto.headers.get("location") === "https://stripe-cc-production.up.railway.app/oauth/install/start?link=test", `loc=${auto.headers.get("location")}`);

  // ── (b) install start → marketplace authorize ──
  const start = await get(`${BASE}/oauth/install/start?link=test`);
  check("b1: start 302s", start.status === 302, `status=${start.status}`);
  const loc = start.headers.get("location") || "";
  check("b2: marketplace authorize host", loc.startsWith("https://marketplace.stripe.com/oauth/v2/authorize?"), loc);
  const authUrl = new URL(loc);
  check("b3: client_id = STRIPE_CLIENT_ID", authUrl.searchParams.get("client_id") === "ca_test_client", authUrl.searchParams.get("client_id") || "");
  check("b4: redirect_uri = manifest allowed_redirect_uris entry", authUrl.searchParams.get("redirect_uri") === MANIFEST_REDIRECT_URI, authUrl.searchParams.get("redirect_uri") || "");
  const stateTest = authUrl.searchParams.get("state") || "";
  check("b5: state is CSRF-safe (48 hex + :test)", /^[0-9a-f]{48}:test$/.test(stateTest), stateTest);
  const d1 = db();
  const stateRow = d1.query("SELECT link_type FROM oauth_install_states WHERE state = ?").get(stateTest) as { link_type: string } | null;
  check("b6: state row stored with link type", stateRow?.link_type === "test", JSON.stringify(stateRow));
  d1.close();

  const startLive = await get(`${BASE}/oauth/install/start?link=live`);
  const stateLive = new URL(startLive.headers.get("location") || "").searchParams.get("state") || "";
  check("b7: live link encodes :live in state", /^[0-9a-f]{48}:live$/.test(stateLive), stateLive);
  const startBogus = await get(`${BASE}/oauth/install/start?link=bogus`);
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
  const merchRow = d2.query("SELECT email, trust_mode FROM merchants WHERE stripe_account_id = 'acct_market_test'").get() as { email: string; trust_mode: string } | null;
  check("c15: merchant created with account email", merchRow?.email === "merchant@example.com", JSON.stringify(merchRow));
  const sessRow = d2.query("SELECT merchant_id FROM sessions WHERE token = ?").get(sessionToken) as { merchant_id: number } | null;
  check("c16: session minted for the merchant", !!sessRow && sessRow.merchant_id === connRow?.merchant_id, JSON.stringify(sessRow));
  const stateAfter = d2.query("SELECT 1 AS ok FROM oauth_install_states WHERE state = ?").get(stateTest);
  check("c17: state consumed (one-time)", stateAfter === null, JSON.stringify(stateAfter));
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
  check("e2: code without state → clean error page", missing.status === 200 && (await missing.text()).includes("missing the authorization code"), `status=${missing.status}`);
  const bare = await get(`${BASE}/oauth/callback`);
  check("e2b: bare callback (no params) keeps pre-existing Express redirect", bare.status === 302 && (bare.headers.get("location") || "").includes("/dashboard?error=missing_account"), `status=${bare.status} loc=${bare.headers.get("location")}`);
  const denied = await get(`${BASE}/oauth/callback?error=access_denied&error_description=User+declined`);
  const deniedHtml = await denied.text();
  check("e3: denial → friendly page", denied.status === 200 && deniedHtml.includes("Authorization was not completed"), `status=${denied.status}`);

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
  check("g2: consume returns link type", mod.consumeInstallState(u, s1) === "test", "");
  check("g3: consume is one-time", mod.consumeInstallState(u, s1) === null, "");
  check("g4: unknown state → null", mod.consumeInstallState(u, "nope:test") === null, "");
  check("g5: empty state → null", mod.consumeInstallState(u, "") === null, "");

  // ── (h) unit: developer key selection (graceful when unset) ──
  process.env.STRIPE_APP_TEST_KEY = "sk_test_unit";
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";
  check("h1: test key selected", mod.appDevKeyFor("test") === "sk_test_unit", "");
  check("h2: live key selected", mod.appDevKeyFor("live") === "sk_live_unit", "");
  delete process.env.STRIPE_APP_LIVE_KEY;
  check("h3: missing live key → null (no crash)", mod.appDevKeyFor("live") === null, "");
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";

  // ── (i) unit: authorize URL builder ──
  process.env.STRIPE_CLIENT_ID = "ca_unit_client";
  const built = mod.buildAuthorizeUrl("abc:test");
  check("i1: builds authorize URL", "url" in built && (built as { url: string }).url.includes("client_id=ca_unit_client") && (built as { url: string }).url.includes("redirect_uri=") && (built as { url: string }).url.includes("state=abc%3Atest"), JSON.stringify(built));
  delete process.env.STRIPE_CLIENT_ID;
  const builtMissing = mod.buildAuthorizeUrl("abc:test");
  check("i2: missing client id → clear error", "error" in builtMissing && (builtMissing as { error: string }).error.includes("STRIPE_CLIENT_ID"), JSON.stringify(builtMissing));
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
  const exLive = await mod.exchangeCodeForTokens("code_unit", "live");
  check("j4: missing live key → error without network call", !exLive.ok && exLive.error.includes("STRIPE_APP_LIVE_KEY"), JSON.stringify(exLive));
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
  const rf6 = await mod.refreshAppAccessToken(u, "acct_live_no_key");
  check("l10: missing live key → clean error", !rf6.ok && rf6.error.includes("STRIPE_APP_LIVE_KEY"), JSON.stringify(rf6));
  process.env.STRIPE_APP_LIVE_KEY = "sk_live_unit";
  u.close();

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
