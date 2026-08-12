/**
 * Cross-host session handoff tests — GET /oauth/session (+ /oauth/success).
 *
 * The OAuth callback mints a HOST-ONLY session cookie scoped to the Railway
 * host (BASE_URL), but the web dashboard lives on www.getcollectionscopilot.com
 * — a different registrable domain — so the browser never sends the Railway
 * cookie there and the dashboard 401s on every API call. Fix: the callback
 * redirects through GET /oauth/session on the www host (first-party
 * navigation), which validates the token in the URL and sets the SAME host-only
 * cookie for www, then 302s to an allow-listed ?next=. The final hop
 * (/oauth/success) is served from the Railway host so the oauth-complete
 * postMessage keeps its origin. This suite proves:
 *   (a) valid token → 302 to the allow-listed next + Set-Cookie matching the
 *       production string exactly (HttpOnly; Secure; SameSite=None; Path=/;
 *       Max-Age=2592000)
 *   (b) unknown / expired / missing token → 302 to the www dashboard, NO cookie
 *   (c) non-allow-listed next (https://evil.example) → 302 to the www
 *       dashboard, never the evil URL (open-redirect guard)
 *   - the full allow-list matrix: Railway, www, dashboard.stripe.com and
 *     http://localhost:3002 accepted; lookalike hosts / schemes / embedded
 *     credentials rejected
 *   - /oauth/success renders the same success HTML as before in both return
 *     modes (postMessage oauth-complete + auto-redirect preserved)
 *   - the callback's pre-existing missing-account redirect is unchanged
 *   - /oauth/handoff (the dashboard's self-heal bounce): valid Railway-host
 *     session COOKIE → 302 to www /oauth/session?token=<seeded>&next=<www
 *     dashboard>; no cookie / expired / unknown cookie → 302 to the www
 *     dashboard (the one-shot dashboard guard stops any loop)
 *
 * Runs against a booted server sharing its SQLite DB:
 *
 *   bash /tmp/run-suite.sh oauth-session
 *
 * (boots an isolated server on :3100 with a fresh DB and stripped provider
 * keys; no Stripe API calls are made — the callback assertion uses the
 * no-account path that short-circuits before any Stripe call).
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-oauth-session.db";
const SESSION = "oauth-handoff-valid";
const EXPIRED = "oauth-handoff-expired";
const WWW_DASHBOARD = "https://www.getcollectionscopilot.com/dashboard";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function seed(): void {
  const d = new Database(DB_PATH);
  d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (1, 'acct_default', 'default@collections-copilot.local', 'draft')");
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now', '+30 days'))", [SESSION]);
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now', '-1 day'))", [EXPIRED]);
  d.close();
}

/** GET with manual redirect handling (Bun would otherwise follow the 302). */
function get(u: string): Promise<Response> {
  return fetch(u, { redirect: "manual" });
}

async function main(): Promise<void> {
  seed();

  // ── (a) valid token: cookie + 302 to allow-listed next ──
  const nextWww = encodeURIComponent("https://www.getcollectionscopilot.com/dashboard?connected=true");
  const a = await get(`${BASE}/oauth/session?token=${SESSION}&next=${nextWww}`);
  check("a1: valid token 302s", a.status === 302, `status=${a.status}`);
  check("a2: Location is the allow-listed next", a.headers.get("location") === decodeURIComponent(nextWww), `loc=${a.headers.get("location")}`);
  const scA = a.headers.get("set-cookie") || "";
  check("a3: sets the session cookie", scA.startsWith(`session=${SESSION};`), scA);
  check("a4: cookie mirrors the production string", scA.includes("HttpOnly") && scA.includes("Secure") && scA.includes("SameSite=None") && scA.includes("Path=/") && scA.includes("Max-Age=2592000"), scA);

  // Railway-host next (the callback's actual final destination — success page)
  const nextRailway = encodeURIComponent("https://stripe-cc-production.up.railway.app/oauth/success?return=stripe");
  const aR = await get(`${BASE}/oauth/session?token=${SESSION}&next=${nextRailway}`);
  check("a5: Railway-host next allowed", aR.status === 302 && aR.headers.get("location") === decodeURIComponent(nextRailway), `loc=${aR.headers.get("location")}`);
  check("a6: cookie set for Railway next too", (aR.headers.get("set-cookie") || "").startsWith(`session=${SESSION};`), aR.headers.get("set-cookie") || "");

  // ── (b) unknown / expired / missing token: NO cookie, dashboard fallback ──
  const b1 = await get(`${BASE}/oauth/session?token=no-such-token&next=${nextWww}`);
  check("b1: unknown token 302s to www dashboard", b1.status === 302 && b1.headers.get("location") === WWW_DASHBOARD, `loc=${b1.headers.get("location")}`);
  check("b2: unknown token sets NO cookie", b1.headers.get("set-cookie") === null, b1.headers.get("set-cookie") || "");

  const b2 = await get(`${BASE}/oauth/session?token=${EXPIRED}&next=${nextWww}`);
  check("b3: expired token 302s to www dashboard", b2.status === 302 && b2.headers.get("location") === WWW_DASHBOARD, `loc=${b2.headers.get("location")}`);
  check("b4: expired token sets NO cookie", b2.headers.get("set-cookie") === null, b2.headers.get("set-cookie") || "");

  const b3 = await get(`${BASE}/oauth/session`);
  check("b5: missing token 302s to www dashboard", b3.status === 302 && b3.headers.get("location") === WWW_DASHBOARD, `loc=${b3.headers.get("location")}`);
  check("b6: missing token sets NO cookie", b3.headers.get("set-cookie") === null, b3.headers.get("set-cookie") || "");

  // ── (c) open-redirect guard: evil next never wins ──
  const evil = encodeURIComponent("https://evil.example");
  const c = await get(`${BASE}/oauth/session?token=${SESSION}&next=${evil}`);
  check("c1: evil next → www dashboard, NOT evil", c.status === 302 && c.headers.get("location") === WWW_DASHBOARD, `loc=${c.headers.get("location")}`);
  check("c2: valid token still gets the cookie on fallback", (c.headers.get("set-cookie") || "").startsWith(`session=${SESSION};`), c.headers.get("set-cookie") || "");

  // ── allow-list matrix ──
  const allowedNexts = [
    "https://stripe-cc-production.up.railway.app/dashboard?connected=true",
    "https://stripe-cc-production.up.railway.app/oauth/success",
    "https://www.getcollectionscopilot.com/dashboard",
    "https://www.getcollectionscopilot.com/",
    "https://dashboard.stripe.com",
    "https://dashboard.stripe.com/settings/apps",
    "http://localhost:3002/dashboard",
  ];
  for (const n of allowedNexts) {
    const r = await get(`${BASE}/oauth/session?token=${SESSION}&next=${encodeURIComponent(n)}`);
    check(`allow-list: ${n}`, r.status === 302 && r.headers.get("location") === n, `loc=${r.headers.get("location")}`);
  }
  const deniedNexts = [
    "https://evil.example",
    "https://evil.example/stripe-cc-production.up.railway.app",
    "https://stripe-cc-production.up.railway.app.evil.example",
    "https://www.getcollectionscopilot.com.evil.example/dashboard",
    "https://dashboard.stripe.com.evil.example",
    "https://stripe-cc-production.up.railway.app:8443/",
    "http://localhost:3002.evil.example/",
    "https://www.getcollectionscopilot.com@evil.example/",
    "https://user:pass@www.getcollectionscopilot.com/dashboard",
    "javascript:alert(1)",
    "//evil.example",
    "/dashboard",
    "",
  ];
  for (const n of deniedNexts) {
    const r = await get(`${BASE}/oauth/session?token=${SESSION}&next=${encodeURIComponent(n)}`);
    check(`deny: "${n}" → www dashboard`, r.status === 302 && r.headers.get("location") === WWW_DASHBOARD, `loc=${r.headers.get("location")}`);
  }

  // ── (d) /oauth/success renders the same success HTML in both modes ──
  const ok = await fetch(`${BASE}/oauth/success`);
  const html = await ok.text();
  check("d1: /oauth/success 200 text/html", ok.status === 200 && (ok.headers.get("content-type") || "").includes("text/html"), `status=${ok.status}`);
  check("d2: connected heading present", html.includes("Stripe account connected!"), "");
  check("d3: oauth-complete postMessage preserved", html.includes("postMessage('oauth-complete'"), "");
  check("d4: non-return page auto-redirects to the dashboard", html.includes("/dashboard?connected=true"), "");

  const okR = await fetch(`${BASE}/oauth/success?return=stripe`);
  const htmlR = await okR.text();
  check("d5: return=stripe keeps the Return-to-Stripe link", htmlR.includes("Return to Stripe dashboard"), "");
  check("d6: return=stripe auto-redirects to dashboard.stripe.com", htmlR.includes("https://dashboard.stripe.com"), "");
  check("d7: return=stripe keeps the postMessage", htmlR.includes("postMessage('oauth-complete'"), "");

  // ── (e) callback's pre-existing missing-account redirect (no Stripe call) ──
  const cb = await get(`${BASE}/stripe/oauth/callback`);
  check("e1: callback without account → missing_account redirect", cb.status === 302 && (cb.headers.get("location") || "").endsWith("/dashboard?error=missing_account"), `loc=${cb.headers.get("location")}`);

  // ── (f) /oauth/handoff — the dashboard's self-heal bounce ──
  // The dashboard's JS redirects to <backend>/oauth/handoff on its first 401;
  // the browser sends the Railway-host session cookie on that navigation. The
  // endpoint must NOT itself set a cookie (the www-host /oauth/session hop
  // does that) and must pass the RAW token through the Location so the hop
  // can validate it.
  const handoff = `${BASE}/oauth/handoff`;
  const f1 = await fetch(handoff, { redirect: "manual", headers: { Cookie: `session=${SESSION}` } });
  const expectedHandoff = `https://www.getcollectionscopilot.com/oauth/session?token=${SESSION}&next=${encodeURIComponent(WWW_DASHBOARD)}`;
  check("f1: valid session cookie → 302 to www /oauth/session with token+next", f1.status === 302 && f1.headers.get("location") === expectedHandoff, `loc=${f1.headers.get("location")}`);
  check("f2: handoff itself sets NO cookie", f1.headers.get("set-cookie") === null, f1.headers.get("set-cookie") || "");

  const f2 = await fetch(handoff, { redirect: "manual" });
  check("f3: no cookie → 302 to www dashboard", f2.status === 302 && f2.headers.get("location") === WWW_DASHBOARD, `loc=${f2.headers.get("location")}`);

  const f3 = await fetch(handoff, { redirect: "manual", headers: { Cookie: `session=${EXPIRED}` } });
  check("f4: expired session cookie → 302 to www dashboard", f3.status === 302 && f3.headers.get("location") === WWW_DASHBOARD, `loc=${f3.headers.get("location")}`);

  const f4 = await fetch(handoff, { redirect: "manual", headers: { Cookie: "session=no-such-token" } });
  check("f5: unknown session cookie → 302 to www dashboard", f4.status === 302 && f4.headers.get("location") === WWW_DASHBOARD, `loc=${f4.headers.get("location")}`);

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
