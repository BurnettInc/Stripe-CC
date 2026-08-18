/**
 * Per-merchant email OAuth (sender-identity Phase 1) tests.
 *
 * HTTP level (server booted with GOOGLE_OAUTH_CLIENT_ID / _SECRET set and
 * GOOGLE_OAUTH_API_BASE → the in-process Google stub on GS_STUB_PORT, exactly
 * like STRIPE_API_BASE stubs Stripe):
 *   (a) /email/oauth/start UNAUTHENTICATED → 302 to the sign-in surface
 *       (/oauth/install) preserving returnTo in ?next= — never a 401 JSON,
 *       never on the authorize hop
 *   (b) signed-in start → 302 to the authorize URL carrying client_id,
 *       redirect_uri = EXACT constant (…/email/oauth/callback), scope =
 *       gmail.send, access_type=offline, prompt=consent, response_type=code,
 *       and a state row stored in email_oauth_states tied to the merchant +
 *       returnTo
 *   (c) provider=microsoft (Phase 2) → clean 503, no crash; unknown provider
 *       → 400
 *   (d) callback happy path: the stub exchanges the code (asserting the
 *       redirect_uri + client_id + client_secret posted), stores the
 *       email_connections row ENCRYPTED (enc:v1:… on both tokens) with
 *       account_email + scopes + token_expires_at, and 302s back to returnTo
 *       with ?emailConnected=1
 *   (e) state is one-time: replaying the same state → 302 with ?emailError=…
 *       (never a second exchange, never a 500)
 *   (f) callback with error param → 302 dashboard ?emailError=…; no state /
 *       no code → 302 ?emailError (fail-closed: never exchange without state)
 *   (g) re-connect upserts: a second start+callback leaves exactly ONE row
 *       (UNIQUE(merchant_id, provider)), refreshed tokens
 *   (h) DELETE /email/connection → revoke hits the stub, row deleted, 302
 *       dashboard ?emailDisconnected=1; merchant can connect again after
 *   (i) no interference: /stats still 200 for the seeded session (new table
 *       touches nothing existing)
 *
 * Unit level (direct module imports in this process, own DB handle, env
 * mutated locally and restored):
 *   (u1) createEmailOAuthState/consumeEmailOAuthState roundtrip; one-time
 *        (second consume → null); unknown → null
 *   (u2) saveEmailConnection stores ENCRYPTED tokens; getEmailConnection
 *        decrypts roundtrip to the exact original strings (TOKEN_ENCRYPTION_KEY
 *        set in this process); without the key the raw row is never
 *        recoverable as plaintext
 *   (u3) gmailProvider.buildAuthorizeUrl: exact redirect_uri constant, scope,
 *        response_type, access_type=offline, prompt=consent, state passthrough
 *   (u4) capability gate: gmailOAuthConfigured() false when creds unset;
 *        handleEmailOAuthStart answers 503 "email sending not configured"
 *        (no session, no crash); providerById('microsoft') → null
 *   (u5) sanitizeReturnTo: absolute URL / protocol-relative → /dashboard
 *   (u6) gmailProvider.exchangeCode failure path → {ok:false} with the stub's
 *        error, never a throw
 */
import { Database } from "bun:sqlite";

// The unit half encrypts/decrypts in THIS process (the run-suite server has its
// own TOKEN_ENCRYPTION_KEY via EXTRA_ENV; the test process must match it so the
// (u2) roundtrip exercises real AES-256-GCM rather than the plaintext fallback).
process.env.TOKEN_ENCRYPTION_KEY ||= "test-encryption-key-0123456789abcdef";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-email-oauth.db";
const GS_STUB_PORT = 3199;
const SESSION = "email-oauth-session";
const REDIRECT_URI = "https://stripe-cc-production.up.railway.app/email/oauth/callback";
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}
function db(): Database {
  return new Database(DB_PATH);
}
function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.close();
}

// ── In-process Google stub (authorize page + token + revoke endpoints) ──
const stub = {
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
  tokenBodies: [] as string[],
  revokeBodies: [] as string[],
  exchangeHits: 0,
};
stub.server = Bun.serve({
  port: GS_STUB_PORT,
  fetch(req) {
    const url = new URL(req.url);
    // The authorize page is never fetched in-process (the test parses the
    // Location header from /email/oauth/start) — answer 200 so a stray
    // navigation is harmless.
    if (url.pathname === "/o/oauth2/v2/auth" && req.method === "GET") {
      return new Response("google authorize", { status: 200 });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      stub.exchangeHits++;
      const body = (async () => {
        const text = await req.text();
        stub.tokenBodies.push(text);
        const params = new URLSearchParams(text);
        if (params.get("code") === "bad-code") {
          return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: "ya29.gmail-access-token",
            refresh_token: "1//gmail-refresh-token",
            expires_in: 3600,
            scope: SCOPE,
            token_type: "Bearer",
            email: "merchant1@gmail.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })();
      return body;
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      return (async () => {
        stub.revokeBodies.push(await req.text());
        return new Response("{}", { status: 200 });
      })();
    }
    return new Response("not found", { status: 404 });
  },
});

const authHeaders = { Cookie: `session=${SESSION}` };

async function startOAuth(provider = "gmail", returnTo = "/dashboard"): Promise<Response> {
  return fetch(`${BASE}/email/oauth/start?provider=${provider}&returnTo=${encodeURIComponent(returnTo)}`, {
    headers: authHeaders,
    redirect: "manual",
  });
}
/** Extract the state param from an authorize Location URL. */
function stateFrom(location: string): string {
  const m = /[?&]state=([^&]+)/.exec(location);
  return m ? decodeURIComponent(m[1]) : "";
}

// ── HTTP suite ──
async function httpSuite(): Promise<void> {
  seedSession();

  // (a) unauthenticated start → sign-in surface preserving returnTo
  {
    const res = await fetch(`${BASE}/email/oauth/start?provider=gmail&returnTo=%2Fsettings`, { redirect: "manual" });
    check("(a) unauth start → 302", res.status === 302, `status=${res.status}`);
    const loc = res.headers.get("location") || "";
    check("(a2) unauth start → /oauth/install?next=<returnTo>", loc.includes("/oauth/install?next=%2Fsettings"), loc);
  }

  // (b) signed-in start → authorize URL with the exact constants
  {
    const res = await startOAuth("gmail", "/dashboard?tab=email");
    check("(b) signed-in start → 302", res.status === 302, `status=${res.status}`);
    const loc = res.headers.get("location") || "";
    const u = new URL(loc);
    check("(b2) authorize host = stub", u.origin === `http://localhost:${GS_STUB_PORT}`, u.origin);
    check("(b3) client_id from env", u.searchParams.get("client_id") === "test-google-client-id.apps.googleusercontent.com", u.searchParams.get("client_id") ?? "");
    check("(b4) redirect_uri EXACT constant", u.searchParams.get("redirect_uri") === REDIRECT_URI, u.searchParams.get("redirect_uri") ?? "");
    check("(b5) scope = gmail.send", u.searchParams.get("scope") === SCOPE, u.searchParams.get("scope") ?? "");
    check("(b6) access_type=offline", u.searchParams.get("access_type") === "offline", u.searchParams.get("access_type") ?? "");
    check("(b7) prompt=consent", u.searchParams.get("prompt") === "consent", u.searchParams.get("prompt") ?? "");
    check("(b8) response_type=code", u.searchParams.get("response_type") === "code", u.searchParams.get("response_type") ?? "");
    const state = stateFrom(loc);
    check("(b9) state present", state.length > 20, state);
    const d = db();
    const row = d.query("SELECT merchant_id, provider, return_to FROM email_oauth_states WHERE state = ?").get(state) as
      | { merchant_id: number; provider: string; return_to: string }
      | null;
    check("(b10) state row tied to merchant + returnTo", !!row && row.merchant_id === 1 && row.provider === "gmail" && row.return_to === "/dashboard?tab=email", JSON.stringify(row));
    d.close();
  }

  // (c) microsoft → 503 (Phase 2); unknown → 400
  {
    const ms = await startOAuth("microsoft");
    check("(c) provider=microsoft → 503", ms.status === 503, `status=${ms.status}`);
    const unknown = await startOAuth("yahoo");
    check("(c2) unknown provider → 400", unknown.status === 400, `status=${unknown.status}`);
  }

  // (d) callback happy path
  let usedState = "";
  let cbLoc = "";
  {
    const res = await startOAuth("gmail", "/dashboard?tab=email");
    usedState = stateFrom(res.headers.get("location") || "");
    const cb = await fetch(`${BASE}/email/oauth/callback?code=good-code&state=${encodeURIComponent(usedState)}`, { redirect: "manual" });
    check("(d) callback → 302", cb.status === 302, `status=${cb.status}`);
    cbLoc = cb.headers.get("location") || "";
    const cu = new URL(cbLoc);
    check("(d2) redirects to returnTo on the callback origin", cu.origin === BASE && cu.pathname === "/dashboard" && cu.searchParams.get("emailConnected") === "1", cbLoc);
    check("(d3) stub exchange posted once", stub.exchangeHits === 1, `hits=${stub.exchangeHits}`);
    const lastBody = stub.tokenBodies[stub.tokenBodies.length - 1] || "";
    const p = new URLSearchParams(lastBody);
    check("(d4) exchange grant_type=authorization_code", p.get("grant_type") === "authorization_code", lastBody);
    check("(d5) exchange redirect_uri = constant", p.get("redirect_uri") === REDIRECT_URI, p.get("redirect_uri") ?? "");
    check("(d6) exchange client_id/secret from env", p.get("client_id") === "test-google-client-id.apps.googleusercontent.com" && p.get("client_secret") === "test-google-client-secret", lastBody);

    const d = db();
    const row = d.query("SELECT * FROM email_connections WHERE merchant_id = 1 AND provider = 'gmail'").get() as
      | Record<string, unknown>
      | null;
    check("(d7) connection row stored", !!row, JSON.stringify(row));
    if (row) {
      check("(d8) account_email stored", row.account_email === "merchant1@gmail.com", String(row.account_email));
      check("(d9) access_token ENCRYPTED", String(row.access_token).startsWith("enc:v1:"), String(row.access_token).slice(0, 24));
      check("(d10) refresh_token ENCRYPTED", String(row.refresh_token).startsWith("enc:v1:"), String(row.refresh_token).slice(0, 24));
      check("(d11) scopes stored", row.scopes === SCOPE, String(row.scopes));
      check("(d12) token_expires_at set (future)", typeof row.token_expires_at === "string" && new Date(row.token_expires_at as string).getTime() > Date.now() + 3000 * 1000, String(row.token_expires_at));
    }
    d.close();
  }

  // (e) state replay → emailError, no second exchange for that state
  {
    const hitsBefore = stub.exchangeHits;
    const cb = await fetch(`${BASE}/email/oauth/callback?code=good-code&state=${encodeURIComponent(usedState)}`, { redirect: "manual" });
    check("(e) replay → 302", cb.status === 302, `status=${cb.status}`);
    const loc = cb.headers.get("location") || "";
    check("(e2) replay → ?emailError=…", loc.includes("emailError="), loc);
    check("(e3) replay → no additional exchange (hits unchanged)", stub.exchangeHits === hitsBefore, `hits=${stub.exchangeHits}`);
    check("(e4) state row consumed", !db().query("SELECT 1 FROM email_oauth_states WHERE state = ?").get(usedState));
    db().close();
  }

  // (f) error param / missing params → dashboard emailError, no crash
  {
    const err = await fetch(`${BASE}/email/oauth/callback?error=access_denied`, { redirect: "manual" });
    check("(f) error param → 302", err.status === 302, `status=${err.status}`);
    check("(f2) error param → ?emailError=…", (err.headers.get("location") || "").includes("emailError="), err.headers.get("location") || "");
    const noState = await fetch(`${BASE}/email/oauth/callback?code=good-code`, { redirect: "manual" });
    check("(f3) code without state → 302 emailError (fail-closed)", noState.status === 302 && (noState.headers.get("location") || "").includes("emailError="), `${noState.status} ${noState.headers.get("location") || ""}`);
  }

  // (g) re-connect upserts — still exactly ONE row
  {
    const res = await startOAuth("gmail", "/dashboard");
    const st = stateFrom(res.headers.get("location") || "");
    await fetch(`${BASE}/email/oauth/callback?code=good-code&state=${encodeURIComponent(st)}`, { redirect: "manual" });
    const d = db();
    const rows = d.query("SELECT COUNT(*) AS n FROM email_connections WHERE merchant_id = 1 AND provider = 'gmail'").get() as { n: number };
    check("(g) reconnect upserts — one row", rows.n === 1, `n=${rows.n}`);
    d.close();
  }

  // (h) disconnect: revoke + row deleted
  {
    await fetch(`${BASE}/email/connection`, { method: "DELETE", headers: authHeaders, redirect: "manual" });
    const d = db();
    const row = d.query("SELECT 1 FROM email_connections WHERE merchant_id = 1").get();
    check("(h) row deleted", !row);
    d.close();
    check("(h2) revoke called on stub", stub.revokeBodies.length >= 1 && stub.revokeBodies[0].includes("1%2F%2Fgmail-refresh-token"), stub.revokeBodies.join(" | "));
    // can connect again after disconnect
    const res = await startOAuth("gmail", "/dashboard");
    check("(h3) can reconnect after disconnect", res.status === 302, `status=${res.status}`);
  }

  // (i) no interference with existing surfaces
  {
    const stats = await fetch(`${BASE}/stats`, { headers: authHeaders, redirect: "manual" });
    check("(i) /stats still 200 (new tables touch nothing existing)", stats.status === 200, `status=${stats.status}`);
    const tasks = await fetch(`${BASE}/tasks`, { headers: authHeaders, redirect: "manual" });
    check("(i2) /tasks still 200", tasks.status === 200, `status=${tasks.status}`);
  }
}

// ── Unit suite (direct module imports, env mutated + restored) ──
async function unitSuite(): Promise<void> {
  const mod = await import("./src/routes/email-oauth");
  const providers = await import("./src/email/providers");
  // Own schema'd SQLite (schema.sql + migrations, incl. 026) via getDb on a
  // private path — the unit DB is separate from the server's HTTP DB.
  process.env.DB_PATH = "/tmp/cc-email-oauth-unit.db";
  const { getDb } = await import("./src/db");
  const u = getDb();
  // getDb applies schema + migrations but NOT ensureDefaultMerchant (that's a
  // per-request step in index.ts) — insert the merchant the FK references.
  u.run("INSERT OR IGNORE INTO merchants (stripe_account_id, email, trust_mode) VALUES ('acct_unit', 'unit@example.com', 'draft')");

  // (u1) state roundtrip / one-time / unknown
  {
    const s1 = mod.createEmailOAuthState(u, 1, "gmail", "/dashboard");
    const c1 = mod.consumeEmailOAuthState(u, s1);
    check("(u1) state roundtrip", !!c1 && c1.merchant_id === 1 && c1.provider === "gmail" && c1.return_to === "/dashboard", JSON.stringify(c1));
    check("(u1b) state one-time — second consume null", mod.consumeEmailOAuthState(u, s1) === null);
    check("(u1c) unknown state → null", mod.consumeEmailOAuthState(u, "deadbeef") === null);
  }

  // (u2) encrypted storage roundtrip (own key in-process — the server's key is
  // the same: run-suite sets TOKEN_ENCRYPTION_KEY for this suite)
  {
    mod.saveEmailConnection(u, {
      merchant_id: 1,
      provider: "gmail",
      account_email: "owner@gmail.com",
      access_token: "plain-access-token-xyz",
      refresh_token: "plain-refresh-token-xyz",
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scopes: SCOPE,
    });
    const raw = u.query("SELECT access_token, refresh_token FROM email_connections WHERE provider='gmail'").get() as { access_token: string; refresh_token: string };
    check("(u2) stored tokens encrypted at rest", raw.access_token.startsWith("enc:v1:") && raw.refresh_token.startsWith("enc:v1:"), raw.access_token.slice(0, 20));
    check("(u2b) ciphertext is not the plaintext", !raw.access_token.includes("plain-access-token-xyz"));
    const dec = mod.getEmailConnection(u, 1, "gmail");
    check("(u2c) decrypt roundtrip exact", dec?.access_token === "plain-access-token-xyz" && dec?.refresh_token === "plain-refresh-token-xyz" && dec?.account_email === "owner@gmail.com", JSON.stringify(dec));
  }

  // (u3) authorize URL construction by the provider
  {
    const url = providers.gmailProvider.buildAuthorizeUrl({ clientId: "ca_test", state: "STATE123" });
    const q = new URL(url);
    check("(u3) redirect_uri EXACT constant", q.searchParams.get("redirect_uri") === REDIRECT_URI, q.searchParams.get("redirect_uri") ?? "");
    check("(u3b) scope exact", q.searchParams.get("scope") === SCOPE);
    check("(u3c) access_type=offline + prompt=consent + response_type=code", q.searchParams.get("access_type") === "offline" && q.searchParams.get("prompt") === "consent" && q.searchParams.get("response_type") === "code");
    check("(u3d) state passthrough", q.searchParams.get("state") === "STATE123");
    check("(u3e) production authorize host (api base unset here)", url.startsWith("https://accounts.google.com/"), url);
  }

  // (u4) capability gate when env unset
  {
    const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const apiBase = process.env.GOOGLE_OAUTH_API_BASE;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    try {
      check("(u4) gmailOAuthConfigured() false when unset", providers.gmailOAuthConfigured() === false);
      const res = await mod.handleEmailOAuthStart(u, new Request("http://localhost:3100/email/oauth/start?provider=gmail"));
      check("(u4b) /email/oauth/start → 503 'email sending not configured'", res.status === 503, `status=${res.status}`);
      const body = await res.text();
      check("(u4c) 503 body names the config gap", body.includes("not configured"), body.slice(0, 80));
      check("(u4d) providerById('microsoft') → null (Phase 2)", providers.providerById("microsoft") === null);
    } finally {
      if (id !== undefined) process.env.GOOGLE_OAUTH_CLIENT_ID = id;
      if (secret !== undefined) process.env.GOOGLE_OAUTH_CLIENT_SECRET = secret;
      if (apiBase !== undefined) process.env.GOOGLE_OAUTH_API_BASE = apiBase;
    }
  }

  // (u5) returnTo sanitization (no open redirect)
  {
    check("(u5) absolute URL → /dashboard", mod.sanitizeReturnTo("https://evil.example.com") === "/dashboard");
    check("(u5b) protocol-relative → /dashboard", mod.sanitizeReturnTo("//evil.example.com") === "/dashboard");
    check("(u5c) null → /dashboard", mod.sanitizeReturnTo(null) === "/dashboard");
    check("(u5d) dashboard path kept", mod.sanitizeReturnTo("/settings") === "/settings");
    check("(u5e) deep dashboard path kept", mod.sanitizeReturnTo("/dashboard?tab=email") === "/dashboard?tab=email");
  }

  // (u6) exchange failure → {ok:false}, never a throw
  {
    const bad = await providers.gmailProvider.exchangeCode("bad-code", "cid", "csec");
    check("(u6) failed exchange → ok:false with error", !bad.ok && "error" in bad && String((bad as { error: string }).error).length > 0, JSON.stringify(bad).slice(0, 120));
  }

  u.close();
}

// ── main ──
async function main(): Promise<void> {
  // HTTP suite always runs — run-suite.sh boots the server on TEST_BASE with
  // GOOGLE_OAUTH_CLIENT_ID/SECRET + GOOGLE_OAUTH_API_BASE via EXTRA_ENV (the
  // creds live on the SERVER; this test process only talks to it). The unset-
  // creds 503 gate is covered at unit level in (u4), where env is mutated
  // in-process.
  await httpSuite();
  await unitSuite();
  stub.server.stop(true);
  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nALL EMAIL-OAUTH TESTS PASSED");
}

await main();