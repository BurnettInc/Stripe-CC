/**
 * Web-connect account-link failure recovery tests (2026-08-14 owner incident).
 *
 * The owner's live "Connect Stripe" click failed with the raw Stripe error
 * "You cannot create account link for an account that doesn't have a valid
 * connection to your platform." and there was NO recovery — the stored
 * stripe_account_id (created under a different key/mode) stayed stuck and the
 * dashboard kept showing the dead connection. This suite locks in the fix:
 *
 * Contract under test (routes/oauth.ts handleConnectFailure + the /stats
 * derivation):
 *   (a) accountLinks.create fails with the stored-account-invalid class
 *       (message-only invalid_request_error, or code account_invalid /
 *       account_has_no_valid_connection / resource_missing /
 *       more_permissions_required*) → the merchant's stripe_connections row
 *       is DELETED, merchants.disconnected=1, and the redirect is a CLEAN
 *       reconnect state (/dashboard?error=reconnect_required) — NEVER the
 *       raw Stripe error in the URL (no error=account_link_failed, no
 *       detail= param).
 *   (b) OTHER Stripe errors (rate_limit, api_connection_error, generic
 *       invalid_request_error for a different reason) → NOT cleared, and the
 *       historical error surface (/dashboard?error=account_link_failed&
 *       detail=…) is preserved exactly.
 *   (c) the dashboard connect-state derivation (/stats stripeConnected /
 *       stripeDisconnected) is driven by the stored connection + merchant
 *       flag, so clearing the row flips the UI to the connect-CTA state.
 *   (d) saveStripeConnection resets merchants.disconnected=0 (a successful
 *       reconnect — web-connect or marketplace install — clears the flag set
 *       by clearStripeConnection / application.deauthorized).
 *   (e) GET /dashboard?error=reconnect_required serves 200 with the friendly
 *       reconnect banner (element id=reconnect-banner + "Reconnect Stripe"),
 *       and a plain /dashboard serves the banner hidden.
 *
 * The account-link route itself goes through the real Stripe SDK (no
 * STRIPE_API_BASE support in routes/oauth.ts), so the failure-handler logic
 * is exercised at unit level (direct import, synthetic Stripe error objects,
 * own DB handle — same file the booted server uses) and the dashboard
 * derivation at HTTP level. Server MUST be booted with a fresh DB
 * (see /tmp/run-suite.sh connect-recovery):
 *
 *   DB_PATH=/tmp/cc-connect-recovery.db PORT=3100 \
 *     TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-connect-recovery.db \
 *     bun run test-connect-recovery.ts
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-connect-recovery.db";
const SESSION = "connect-recovery-session";

type Rec = { name: string; pass: boolean; detail?: string };
const results: Rec[] = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${pass ? "" : ` — ${detail ?? "failed"}`}`);
}

// The EXACT production error shape captured 2026-08-14 (accountLinks.create
// with the marketplace-install LIVE account under the platform LIVE key):
// type=invalid_request_error, NO code field, message-only.
const PROD_STALE_ERROR = {
  type: "invalid_request_error",
  message: "You cannot create account link for an account that doesn't have a valid connection to your platform.",
};

async function run() {
  const d = new Database(DB_PATH);

  // ── seed session (merchant 1 = auto-created acct_default) ──
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  const seedConn = (id: string, merchantId = 1) => {
    d.run("DELETE FROM stripe_connections WHERE id = ?", [id]);
    d.run("INSERT INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key, created_at, updated_at) VALUES (?, ?, '', NULL, '', datetime('now'), datetime('now'))", [id, merchantId]);
  };
  const connCount = (merchantId: number) =>
    (d.query("SELECT COUNT(*) c FROM stripe_connections WHERE merchant_id = ?").get(merchantId) as { c: number }).c;
  const connExists = (id: string) => !!d.query("SELECT id FROM stripe_connections WHERE id = ?").get(id);
  const disconnected = (merchantId: number) =>
    (d.query("SELECT disconnected FROM merchants WHERE id = ?").get(merchantId) as { disconnected: number }).disconnected;
  // Fresh slate per scenario: drop every connection for merchant 1 so the
  // per-scenario counts/assertions are deterministic.
  const resetConns = () => d.run("DELETE FROM stripe_connections WHERE merchant_id = 1", []);

  // ── load the modules under test ──
  const oauth = await import("./src/routes/oauth");
  const auth = await import("./src/middleware/auth");

  // ══ (a) invalid-connection class → cleared + clean reconnect redirect ══
  {
    // a1: message-only production error (no code) → clear + clean redirect
    seedConn("acct_stale_message");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const res = oauth.handleConnectFailure(d, 1, "acct_stale_message", PROD_STALE_ERROR, "https://cc.example");
    const loc = res.headers.get("Location") || "";
    record("a1 message-only stale error → 302 reconnect_required, no raw error",
      res.status === 302 && loc === "https://cc.example/dashboard?error=reconnect_required" &&
        !loc.includes("account_link_failed") && !loc.includes("detail=") &&
        connCount(1) === 0 && disconnected(1) === 1,
      `loc=${loc} conns=${connCount(1)} disc=${disconnected(1)}`);

    // a2: code account_has_no_valid_connection → clear + clean redirect
    seedConn("acct_stale_code");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const res2 = oauth.handleConnectFailure(d, 1, "acct_stale_code", { type: "invalid_request_error", code: "account_has_no_valid_connection", message: "x" }, "https://cc.example");
    const loc2 = res2.headers.get("Location") || "";
    record("a2 code account_has_no_valid_connection → clear + clean redirect",
      res2.status === 302 && loc2.includes("error=reconnect_required") && !loc2.includes("detail=") && connCount(1) === 0 && disconnected(1) === 1,
      `loc=${loc2} conns=${connCount(1)}`);

    // a3: code resource_missing (deleted account) → clear + clean redirect
    seedConn("acct_stale_deleted");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const res3 = oauth.handleConnectFailure(d, 1, "acct_stale_deleted", { type: "invalid_request_error", code: "resource_missing", message: "No such account" }, "https://cc.example");
    const loc3 = res3.headers.get("Location") || "";
    record("a3 code resource_missing (deleted account) → clear + clean redirect",
      res3.status === 302 && loc3.includes("error=reconnect_required") && connCount(1) === 0 && disconnected(1) === 1,
      `loc=${loc3} conns=${connCount(1)}`);

    // a4: mode-mismatch message (test key on live account) → clear + clean redirect
    seedConn("acct_stale_mode");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const res4 = oauth.handleConnectFailure(d, 1, "acct_stale_mode", { type: "invalid_request_error", message: "You tried to create a test mode account link for an account that was created in live mode." }, "https://cc.example");
    const loc4 = res4.headers.get("Location") || "";
    record("a4 mode-mismatch message → clear + clean redirect",
      res4.status === 302 && loc4.includes("error=reconnect_required") && connCount(1) === 0 && disconnected(1) === 1,
      `loc=${loc4} conns=${connCount(1)}`);

    // a5: account_invalid code → clear
    seedConn("acct_stale_invalid");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const res5 = oauth.handleConnectFailure(d, 1, "acct_stale_invalid", { type: "invalid_request_error", code: "account_invalid", message: "The account is invalid" }, "https://cc.example");
    record("a5 code account_invalid → clear + clean redirect",
      res5.status === 302 && (res5.headers.get("Location") || "").includes("error=reconnect_required") && connCount(1) === 0,
      `conns=${connCount(1)}`);
  }

  // ══ (b) other errors → NOT cleared, historical error surface preserved ══
  {
    resetConns();
    seedConn("acct_rate");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const res = oauth.handleConnectFailure(d, 1, "acct_rate", { type: "rate_limit_error", message: "Too many requests" }, "https://cc.example");
    const loc = res.headers.get("Location") || "";
    record("b1 rate_limit_error → NOT cleared, error surfaced as today",
      res.status === 302 && loc.includes("error=account_link_failed") && loc.includes("detail=") && connExists("acct_rate") && disconnected(1) === 0,
      `loc=${loc} conns=${connCount(1)} disc=${disconnected(1)}`);

    resetConns();
    seedConn("acct_net");
    const res2 = oauth.handleConnectFailure(d, 1, "acct_net", { type: "api_connection_error", message: "Connection reset" }, "https://cc.example");
    record("b2 api_connection_error → NOT cleared, error surfaced",
      res2.status === 302 && (res2.headers.get("Location") || "").includes("error=account_link_failed") && connExists("acct_net"),
      `conns=${connCount(1)}`);

    resetConns();
    seedConn("acct_otherval");
    const res3 = oauth.handleConnectFailure(d, 1, "acct_otherval", { type: "invalid_request_error", message: "Invalid API key provided" }, "https://cc.example");
    record("b3 generic invalid_request_error (different reason) → NOT cleared, error surfaced",
      res3.status === 302 && (res3.headers.get("Location") || "").includes("error=account_link_failed") && connExists("acct_otherval"),
      `conns=${connCount(1)}`);

    // b4: no accountId (fresh account creation failed) → nothing to clear
    resetConns();
    const res4 = oauth.handleConnectFailure(d, 1, null, PROD_STALE_ERROR, "https://cc.example");
    record("b4 no stored accountId → raw error surface (nothing to clear)",
      res4.status === 302 && (res4.headers.get("Location") || "").includes("error=account_link_failed"),
      `loc=${res4.headers.get("Location")}`);
  }

  // ══ classifier unit checks ══
  {
    const cls = oauth.isStoredConnectionUnusableError;
    record("c1 classifier: message-only prod error → true", cls(PROD_STALE_ERROR) === true);
    record("c2 classifier: code variants → true",
      cls({ type: "invalid_request_error", code: "account_invalid", message: "x" }) &&
      cls({ type: "invalid_request_error", code: "account_has_no_valid_connection", message: "x" }) &&
      cls({ type: "invalid_request_error", code: "resource_missing", message: "x" }) &&
      cls({ type: "invalid_request_error", code: "more_permissions_required", message: "x" }) &&
      cls({ type: "invalid_request_error", code: "more_permissions_required_for_application", message: "x" }));
    record("c3 classifier: mode-mismatch messages → true",
      cls({ type: "invalid_request_error", message: "You tried to create a test mode account link for an account that was created in live mode." }) &&
      cls({ type: "invalid_request_error", message: "You tried to create a live mode account link for an account that was created in test mode." }));
    record("c4 classifier: rate_limit / api_connection / auth → false",
      !cls({ type: "rate_limit_error", message: "Too many" }) &&
      !cls({ type: "api_connection_error", message: "reset" }) &&
      !cls({ type: "invalid_request_error", message: "Invalid API key provided" }) &&
      !cls({ type: "invalid_request_error", message: "No such customer: cus_x" }) && // resource_missing without code is NOT matched by message
      !cls(null) && !cls("string") && !cls(undefined));
  }

  // ══ (c) /stats derivation flips after clearing (HTTP) ══
  {
    // connected baseline: seed a connection for merchant 1 (session merchant)
    seedConn("acct_stats_conn");
    d.run("UPDATE merchants SET disconnected=0 WHERE id=1");
    const r1 = await fetch(`${BASE}/stats`, { headers: { Cookie: `session=${SESSION}` } });
    const s1 = await r1.json();
    record("d1 /stats shows connected when a connection row exists",
      r1.status === 200 && s1.stripeConnected === true && s1.stripeDisconnected === false,
      `status=${r1.status} connected=${s1.stripeConnected} disc=${s1.stripeDisconnected}`);

    // simulate the fix: clear the stale connection (what handleConnectFailure does)
    auth.clearStripeConnection(d, 1);
    const r2 = await fetch(`${BASE}/stats`, { headers: { Cookie: `session=${SESSION}` } });
    const s2 = await r2.json();
    record("d2 /stats flips to not-connected + disconnected after clear",
      r2.status === 200 && s2.stripeConnected === false && s2.stripeDisconnected === true,
      `status=${r2.status} connected=${s2.stripeConnected} disc=${s2.stripeDisconnected}`);

    // reconnect: saveStripeConnection clears the disconnect flag
    auth.saveStripeConnection(d, { stripe_account_id: "acct_reconnected", merchant_id: 1, access_token: "", refresh_token: null, stripe_publishable_key: "" });
    const r3 = await fetch(`${BASE}/stats`, { headers: { Cookie: `session=${SESSION}` } });
    const s3 = await r3.json();
    record("d3 /stats shows connected again after saveStripeConnection (reconnect)",
      r3.status === 200 && s3.stripeConnected === true && s3.stripeDisconnected === false,
      `status=${r3.status} connected=${s3.stripeConnected} disc=${s3.stripeDisconnected}`);
    d.run("DELETE FROM stripe_connections WHERE id = 'acct_reconnected'", []);
  }

  // ══ (e) dashboard reconnect banner ══
  {
    const r = await fetch(`${BASE}/dashboard?error=reconnect_required`);
    const html = await r.text();
    record("e1 /dashboard?error=reconnect_required → 200 with friendly banner",
      r.status === 200 && html.includes('id="reconnect-banner"') && html.includes("Reconnect Stripe"),
      `status=${r.status} hasBanner=${html.includes('id="reconnect-banner"')}`);

    const r2 = await fetch(`${BASE}/dashboard`);
    const html2 = await r2.text();
    record("e2 plain /dashboard serves banner hidden (CSS class billing-error-banner = display:none)",
      r2.status === 200 && html2.includes('id="reconnect-banner"') && html2.includes('class="billing-error-banner"'),
      `status=${r2.status}`);
  }

  d.close();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n═══════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════");
  process.exit(failed === 0 ? 0 : 1);
}
run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
