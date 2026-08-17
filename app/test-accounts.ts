/**
 * Platform account layer tests (magic-link sign-in for the Stripe marketplace
 * install flow — owner decision 2026-08-13, Stripe reviewer round-2).
 *
 * Booted via: bash /tmp/run-suite.sh accounts
 * (fresh DB, Stripe stubbed in-process on port 3199, log-only email mode —
 * magic-link sends land in send_logs as type 'account_magic_link').
 *
 * HTTP level:
 *   (a) request-magic-link: find-or-create account (first-time = signup),
 *       ALWAYS 200 {ok:true} (no existence leak), token row 64-hex + 15-min
 *       expiry, send_logs 'account_magic_link' row, normalization (trim +
 *       lowercase), invalid/missing email → 400
 *   (b) rate limiting: 5/hr per EMAIL (isolated via distinct IPs) and 5/hr
 *       per IP (isolated via distinct emails) → 6th request 429
 *   (c) verify: consumes the one-time token, sets last_login_at, mints a
 *       30-day account session + HttpOnly SameSite=Lax Secure cc_account
 *       cookie, 302 to safe ?next= (default /oauth/install); replay of the
 *       same token → friendly error page (no session); unknown / expired
 *       tokens → error page; open-redirect guards (//evil.com, https://evil.com
 *       → /oauth/install; www dashboard allowed)
 *   (c2) /api/account/me returns {email} with the cookie, 401 without; logout
 *       clears the cookie + drops the session row
 *   (e) install page gating: no cookie → sign-in card (email input + "Email me
 *       a sign-in link"), NO connect buttons; valid cookie → connect buttons +
 *       "Signed in as" + "sign out"
 *   (f) /oauth/install/start without a cookie → 302 to /oauth/install; with a
 *       cookie → 302 to marketplace authorize AND the state row carries
 *       account_id
 *   (g) callback links the merchant: full install (state → callback) stamps
 *       merchants.account_id = the account; the install page then shows
 *       "You're connected — open your dashboard"
 *   (h) legacy/back-compat: consumeInstallState on a pre-account row returns
 *       account_id null; findOrCreateMerchant without an account leaves it
 *       null; an existing linked merchant is never unlinked
 *
 * Unit level (direct module imports, own DB handle):
 *   (u) accountCookieFor shape, accountFromCookie (valid/unknown token),
 *       safeNextPath guard
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-accounts.db";
const STRIPE_STUB_PORT = 3199;

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function db(): Database {
  return new Database(DB_PATH);
}

// ── In-process Stripe stub (token exchange + account + invoices) ──
const stub: {
  calls: { path: string; method: string; auth: string; body: string }[];
  server: ReturnType<typeof Bun.serve>;
} = {
  calls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};

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
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (url.pathname === "/v1/account" && req.method === "GET") {
        return Response.json({ id: "acct_market_test", email: "merchant@example.com", display_name: "Merchant Co" });
      }
      if (url.pathname === "/v1/invoices" && req.method === "GET") {
        return Response.json({ data: [], has_more: false });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}

function get(u: string, cookie?: string): Promise<Response> {
  return fetch(u, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}

let ipCounter = 1;
function nextIp(): string {
  return `10.0.0.${ipCounter++}`;
}

/** POST /api/account/request-magic-link and return the freshest unused token
 * for that email (from the DB — deterministic in log-only mode). */
async function mintToken(email: string, ip?: string): Promise<{ status: number; body: unknown; token: string | null }> {
  const res = await fetch(`${BASE}/api/account/request-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip ?? nextIp() },
    body: JSON.stringify({ email }),
  });
  const body = await res.json().catch(() => null);
  let token: string | null = null;
  const d = db();
  const row = d
    .query(
      `SELECT ml.token FROM account_magic_links ml JOIN accounts a ON a.id = ml.account_id
       WHERE a.email = ? ORDER BY ml.id DESC LIMIT 1`
    )
    .get(email.toLowerCase()) as { token: string } | null;
  token = row?.token ?? null;
  d.close();
  return { status: res.status, body, token };
}

async function main(): Promise<void> {
  process.env.STRIPE_API_BASE = `http://localhost:${STRIPE_STUB_PORT}/v1`;
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-0123456789abcdef";
  const mod = await import("./src/routes/accounts");
  const oauthMod = await import("./src/routes/oauth-app-install");

  startStub();

  // ── (a) request-magic-link basics ──
  const a1 = await mintToken("Alice@Example.com", "10.0.0.10");
  check("a1: valid email → 200 {ok:true}", a1.status === 200 && (a1.body as { ok?: boolean })?.ok === true, JSON.stringify(a1.body));
  const d0 = db();
  const acct = d0.query("SELECT * FROM accounts WHERE email = 'alice@example.com'").get() as { id: number; email: string; last_login_at: string | null } | null;
  check("a2: account created with normalized (trim + lowercase) email", !!acct && acct.email === "alice@example.com", JSON.stringify(acct));
  check("a3: last_login_at NULL on signup", !!acct && acct.last_login_at === null, JSON.stringify(acct));
  check("a4: magic-link token is 64 hex chars", !!a1.token && /^[0-9a-f]{64}$/.test(a1.token), String(a1.token));
  const ml = d0.query("SELECT expires_at FROM account_magic_links WHERE token = ?").get(a1.token ?? "") as { expires_at: string } | null;
  check("a5: magic link expires ~15 min out (not expired, not >16 min)", !!ml && ml.expires_at > "2026-01-01" && ml.expires_at < "2030-01-01", JSON.stringify(ml));
  const sendRow = d0.query("SELECT provider_message FROM send_logs WHERE type = 'account_magic_link' ORDER BY id DESC LIMIT 1").get() as { provider_message: string } | null;
  check("a6: magic-link email logged (type account_magic_link, mentions recipient)", !!sendRow && sendRow.provider_message.includes("alice@example.com") && sendRow.provider_message.includes("Magic-link email sent"), sendRow?.provider_message ?? "");
  const a2 = await mintToken("Alice@Example.com", "10.0.0.10");
  check("a7: same email again → still 200 (no existence leak)", a2.status === 200, JSON.stringify(a2.body));
  const acctCount = d0.query("SELECT COUNT(*) AS n FROM accounts WHERE email = 'alice@example.com'").get() as { n: number };
  check("a8: no duplicate account row", acctCount.n === 1, JSON.stringify(acctCount));
  const bad = await fetch(`${BASE}/api/account/request-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.11" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  check("a9: invalid email → 400", bad.status === 400, `status=${bad.status}`);
  const missing = await fetch(`${BASE}/api/account/request-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.12" },
    body: JSON.stringify({}),
  });
  check("a10: missing email → 400", missing.status === 400, `status=${missing.status}`);
  const formRes = await fetch(`${BASE}/api/account/request-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "10.0.0.13" },
    body: "email=FormUser@Example.com",
  });
  check("a11: form-encoded email works", formRes.status === 200, `status=${formRes.status}`);
  d0.close();

  // ── (b) rate limiting ──
  // Per-email: 5 requests to the same email from DIFFERENT IPs → the 6th (new
  // IP) hits the email bucket → 429.
  let rlStatus = 0;
  for (let i = 0; i < 5; i++) rlStatus = (await mintToken("rl-email@example.com")).status;
  check("b1: 5 requests to one email → all 200", rlStatus === 200, `status=${rlStatus}`);
  const rl6 = await mintToken("rl-email@example.com");
  check("b2: 6th request to that email → 429 (per-email limit)", rl6.status === 429, `status=${rl6.status}`);
  // Per-IP: 5 requests to DIFFERENT emails from the SAME IP → the 6th (new
  // email) hits the IP bucket → 429.
  const SAME_IP = "10.9.9.9";
  for (let i = 0; i < 5; i++) {
    await fetch(`${BASE}/api/account/request-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": SAME_IP },
      body: JSON.stringify({ email: `rl-ip-${i}@example.com` }),
    });
  }
  const ip6 = await fetch(`${BASE}/api/account/request-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": SAME_IP },
    body: JSON.stringify({ email: "rl-ip-6@example.com" }),
  });
  check("b3: 6th request from that IP → 429 (per-IP limit)", ip6.status === 429, `status=${ip6.status}`);

  // ── (c) verify: happy path ──
  const d1 = db();
  const verTok = (await mintToken("verify@example.com", "10.0.0.20")).token ?? "";
  const v1 = await get(`${BASE}/api/account/verify?token=${verTok}`);
  check("c1: verify 302s (default next = /oauth/install)", v1.status === 302 && v1.headers.get("location") === "/oauth/install", `status=${v1.status} loc=${v1.headers.get("location")}`);
  const cookie = (v1.headers.get("set-cookie") || "").split(";")[0];
  check("c2: cc_account cookie set", cookie.startsWith("cc_account="), v1.headers.get("set-cookie") || "");
  const sc = v1.headers.get("set-cookie") || "";
  check("c3: cookie attrs — HttpOnly + SameSite=Lax + Secure + Path=/ + 30-day Max-Age", sc.includes("HttpOnly") && sc.includes("SameSite=Lax") && sc.includes("Secure") && sc.includes("Path=/") && sc.includes("Max-Age=2592000"), sc);
  const sessRow = d1.query("SELECT account_id FROM account_sessions WHERE token = ?").get(cookie.split("=")[1]) as { account_id: number } | null;
  check("c4: account session minted (30-day expiry)", !!sessRow && sessRow.account_id === (d1.query("SELECT id FROM accounts WHERE email='verify@example.com'").get() as { id: number }).id, JSON.stringify(sessRow));
  const lastLogin = d1.query("SELECT last_login_at FROM accounts WHERE email = 'verify@example.com'").get() as { last_login_at: string | null };
  check("c5: last_login_at recorded", !!lastLogin.last_login_at, JSON.stringify(lastLogin));
  const used = d1.query("SELECT used_at FROM account_magic_links WHERE token = ?").get(verTok) as { used_at: string | null };
  check("c6: token consumed (used_at set — one-time)", !!used.used_at, JSON.stringify(used));

  // Replay the same token → friendly error page, no new session.
  const v2 = await get(`${BASE}/api/account/verify?token=${verTok}`);
  const v2Html = await v2.text();
  check("c7: replayed token → friendly error page", v2.status === 200 && v2Html.includes("invalid or expired"), `status=${v2.status}`);
  const sessCount = d1.query("SELECT COUNT(*) AS n FROM account_sessions WHERE account_id = ?").get(sessRow.account_id) as { n: number };
  check("c8: no second session minted on replay", sessCount.n === 1, JSON.stringify(sessCount));

  // Unknown + expired tokens.
  const unknown = await get(`${BASE}/api/account/verify?token=${"0".repeat(64)}`);
  check("c9: unknown token → error page", unknown.status === 200 && (await unknown.text()).includes("invalid or expired"), `status=${unknown.status}`);
  const acctId = sessRow.account_id;
  d1.run("INSERT INTO account_magic_links (account_id, token, expires_at) VALUES (?, 'expiredtoken0123456789', datetime('now','-1 minute'))", [acctId]);
  const expired = await get(`${BASE}/api/account/verify?token=expiredtoken0123456789`);
  check("c10: expired token → error page", expired.status === 200 && (await expired.text()).includes("invalid or expired"), `status=${expired.status}`);

  // ── (c2) me + logout ──
  const me = await fetch(`${BASE}/api/account/me`, { headers: { Cookie: cookie } });
  check("c11: /me returns the signed-in email", me.status === 200 && (await me.json()).email === "verify@example.com", `status=${me.status}`);
  const meNo = await fetch(`${BASE}/api/account/me`);
  check("c12: /me without cookie → 401", meNo.status === 401, `status=${meNo.status}`);
  const lo = await fetch(`${BASE}/api/account/logout`, { method: "POST", headers: { Cookie: cookie } });
  const loSc = lo.headers.get("set-cookie") || "";
  check("c13: logout clears the cookie (Max-Age=0)", lo.status === 200 && loSc.startsWith("cc_account=;") && loSc.includes("Max-Age=0"), loSc);
  const meAfter = await fetch(`${BASE}/api/account/me`, { headers: { Cookie: cookie } });
  check("c14: /me after logout → 401 (session row dropped)", meAfter.status === 401, `status=${meAfter.status}`);
  const dropped = d1.query("SELECT 1 AS ok FROM account_sessions WHERE token = ?").get(cookie.split("=")[1]);
  check("c15: account session row deleted on logout", dropped === null, JSON.stringify(dropped));

  // ── (c3) next= destination guards ──
  const relTok = (await mintToken("next-rel@example.com", "10.0.0.21")).token ?? "";
  const rel = await get(`${BASE}/api/account/verify?token=${relTok}&next=/dashboard`);
  check("c16: next=/dashboard → 302 to /dashboard", rel.status === 302 && rel.headers.get("location") === "/dashboard", rel.headers.get("location") || "");
  const wwwTok = (await mintToken("next-www@example.com", "10.0.0.22")).token ?? "";
  const www = await get(`${BASE}/api/account/verify?token=${wwwTok}&next=${encodeURIComponent("https://www.getcollectionscopilot.com/dashboard")}`);
  check("c17: next=www dashboard URL → 302 there", www.status === 302 && www.headers.get("location") === "https://www.getcollectionscopilot.com/dashboard", www.headers.get("location") || "");
  const evilTok = (await mintToken("next-evil@example.com", "10.0.0.23")).token ?? "";
  const evil = await get(`${BASE}/api/account/verify?token=${evilTok}&next=${encodeURIComponent("https://evil.example.com")}`);
  check("c18: next=absolute foreign URL → 302 to /oauth/install (open-redirect guard)", evil.status === 302 && evil.headers.get("location") === "/oauth/install", evil.headers.get("location") || "");
  const protoTok = (await mintToken("next-proto@example.com", "10.0.0.24")).token ?? "";
  const proto = await get(`${BASE}/api/account/verify?token=${protoTok}&next=${encodeURIComponent("//evil.example.com")}`);
  check("c19: next=protocol-relative URL → 302 to /oauth/install", proto.status === 302 && proto.headers.get("location") === "/oauth/install", proto.headers.get("location") || "");
  d1.close();

  // ── (e) install page gating ──
  const pageOut = await (await fetch(`${BASE}/oauth/install`)).text();
  check("e1: signed-out page is 200 HTML with the sign-in card", pageOut.includes("Install CollectionsCopilot") && pageOut.includes("Email me a sign-in link") && pageOut.includes('type="email"') && pageOut.includes("magic-link-form"), "");
  check("e2: signed-out page has NO connect buttons", !pageOut.includes("oauth/install/start?link="), "");
  check("e3: signed-out page has the support line", pageOut.includes("support@getcollectionscopilot.com"), "");

  // Account for the installer (signed-in state + install flow below).
  const inst = await mintToken("installer@example.com", "10.0.0.30");
  const instVerify = await get(`${BASE}/api/account/verify?token=${inst.token ?? ""}&next=/oauth/install`);
  const instCookie = (instVerify.headers.get("set-cookie") || "").split(";")[0];
  check("e4: installer verified → cookie", instVerify.status === 302 && instCookie.startsWith("cc_account="), instVerify.headers.get("location") || "");

  const pageIn = await (await fetch(`${BASE}/oauth/install`, { headers: { Cookie: instCookie } })).text();
  check("e5: signed-in page shows the test-mode connect button", pageIn.includes("oauth/install/start?link=test"), "");
  check("e6: signed-in page shows the live-mode connect button", pageIn.includes("oauth/install/start?link=live"), "");
  check("e7: signed-in page shows 'Signed in as' + the email + sign out", pageIn.includes("Signed in as") && pageIn.includes("installer@example.com") && pageIn.includes("sign out"), "");
  check("e8: signed-in page still shows step instructions", pageIn.includes("Click <strong>Connect with Stripe</strong>"), "");

  // ── (f) install/start gating ──
  const noCookie = await get(`${BASE}/oauth/install/start?link=test`);
  check("f1: install/start without cookie → 302 to /oauth/install", noCookie.status === 302 && noCookie.headers.get("location") === `${process.env.BASE_URL || "http://localhost:3002"}/oauth/install`, `status=${noCookie.status} loc=${noCookie.headers.get("location")}`);
  const withCookie = await get(`${BASE}/oauth/install/start?link=test`, instCookie);
  check("f2: install/start with cookie → 302 to marketplace authorize (chnlink path + state)", withCookie.status === 302 && (withCookie.headers.get("location") || "").startsWith("https://marketplace.stripe.com/oauth/v2/chnlink_test/authorize?") && /state=[0-9a-f]{48}%3Atest/.test(withCookie.headers.get("location") || ""), `status=${withCookie.status} loc=${withCookie.headers.get("location")}`);
  const stateVal = new URL(withCookie.headers.get("location") || "").searchParams.get("state") || "";
  const d2 = db();
  const instAcct = d2.query("SELECT id FROM accounts WHERE email = 'installer@example.com'").get() as { id: number };
  const stateRow = d2.query("SELECT account_id FROM oauth_install_states WHERE state = ?").get(stateVal) as { account_id: number | null } | null;
  check("f3: state row carries the account_id", stateRow?.account_id === instAcct.id, JSON.stringify(stateRow));

  // ── (g) callback links the merchant to the account ──
  const cb = await get(`${BASE}/oauth/callback?code=code_test&state=${encodeURIComponent(stateVal)}`);
  check("g1: callback 302s through the handoff", cb.status === 302 && (cb.headers.get("location") || "").includes("/oauth/session"), `status=${cb.status}`);
  const merch = d2.query("SELECT id, account_id FROM merchants WHERE stripe_account_id = 'acct_market_test'").get() as { id: number; account_id: number | null } | null;
  check("g2: merchant linked to the account (account_id stamped)", !!merch && merch.account_id === instAcct.id, JSON.stringify(merch));
  // The install page now offers the dashboard shortcut.
  const pageConnected = await (await fetch(`${BASE}/oauth/install`, { headers: { Cookie: instCookie } })).text();
  check("g3: signed-in page shows 'You're connected — open your dashboard'", pageConnected.includes("You're connected") && pageConnected.includes("open your dashboard"), "");
  // A SECOND account's install page must NOT show the dashboard link (not
  // their merchant).
  const other = await mintToken("other@example.com", "10.0.0.31");
  const otherVerify = await get(`${BASE}/api/account/verify?token=${other.token ?? ""}`);
  const otherCookie = (otherVerify.headers.get("set-cookie") || "").split(";")[0];
  const pageOther = await (await fetch(`${BASE}/oauth/install`, { headers: { Cookie: otherCookie } })).text();
  check("g4: a different account sees no dashboard link", !pageOther.includes("open your dashboard"), "");

  // ── (h) legacy/back-compat: pre-account rows stay null-safe ──
  const consumedLegacy = oauthMod.consumeInstallState(d2, "legacy:test");
  check("h1: consumeInstallState on unknown state → null", consumedLegacy === null, JSON.stringify(consumedLegacy));
  const legacyMerchantId = oauthMod.findOrCreateMerchant(d2, "acct_legacy_user", "legacy@example.com", null);
  const legacyMerch = d2.query("SELECT account_id FROM merchants WHERE id = ?").get(legacyMerchantId) as { account_id: number | null };
  check("h2: findOrCreateMerchant without account → account_id stays NULL", legacyMerch.account_id === null, JSON.stringify(legacyMerch));
  // Re-link an EXISTING merchant: findOrCreateMerchant with an account updates it.
  oauthMod.findOrCreateMerchant(d2, "acct_legacy_user", "legacy@example.com", instAcct.id);
  const relinked = d2.query("SELECT account_id FROM merchants WHERE id = ?").get(legacyMerchantId) as { account_id: number | null };
  check("h3: findOrCreateMerchant on existing merchant stamps account_id", relinked.account_id === instAcct.id, JSON.stringify(relinked));
  d2.close();

  // ── (u) unit: cookie / session helpers ──
  const u = new Database(DB_PATH);
  const cookieStr = mod.accountCookieFor("tok123");
  check("u1: accountCookieFor shape", cookieStr.startsWith("cc_account=tok123;") && cookieStr.includes("HttpOnly") && cookieStr.includes("SameSite=Lax") && cookieStr.includes("Secure") && cookieStr.includes("Path=/") && cookieStr.includes("Max-Age=2592000"), cookieStr);
  const uAcct = u.query("INSERT INTO accounts (email) VALUES ('unit@example.com') RETURNING id").get() as { id: number };
  u.run("INSERT INTO account_sessions (account_id, token, expires_at) VALUES (?, 'unitsess', datetime('now','+30 days'))", [uAcct.id]);
  const reqWith = new Request("http://localhost/x", { headers: { Cookie: "cc_account=unitsess; other=1" } });
  const fromCookie = mod.accountFromCookie(u, reqWith);
  check("u2: accountFromCookie resolves a valid session", fromCookie?.id === uAcct.id && fromCookie.email === "unit@example.com", JSON.stringify(fromCookie));
  const reqNo = new Request("http://localhost/x", { headers: { Cookie: "cc_account=nope" } });
  check("u3: accountFromCookie with unknown token → null", mod.accountFromCookie(u, reqNo) === null, "");
  const reqNone = new Request("http://localhost/x");
  check("u4: accountFromCookie with no cookie → null", mod.accountFromCookie(u, reqNone) === null, "");
  check("u5: safeNextPath default", mod.safeNextPath("") === "/oauth/install", "");
  check("u6: safeNextPath allows /oauth/install", mod.safeNextPath("/oauth/install") === "/oauth/install", "");
  check("u7: safeNextPath blocks absolute foreign", mod.safeNextPath("https://evil.com/x") === "/oauth/install", "");
  check("u8: safeNextPath blocks protocol-relative", mod.safeNextPath("//evil.com/x") === "/oauth/install", "");
  check("u9: safeNextPath blocks backslash", mod.safeNextPath("/\\evil") === "/oauth/install", "");
  check("u10: safeNextPath allows the www dashboard URL", mod.safeNextPath("https://www.getcollectionscopilot.com/dashboard") === "https://www.getcollectionscopilot.com/dashboard", "");
  u.close();

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
