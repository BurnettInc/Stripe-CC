/**
 * CORS allowlist tests for the Stripe App panel.
 *
 * The Stripe App panel (UI Extensions SDK) fetches our API from inside
 * Stripe's dashboard and its marketplace/app-modal contexts, so the backend
 * must echo the Origin header for exactly these hosts:
 *   - https://dashboard.stripe.com          (Stripe Dashboard drawer/detail)
 *   - https://appmarket.stripe.com          (Stripe marketplace / modal)
 *   - https://www.getcollectionscopilot.com (same-origin dashboard host)
 *   - https://stripe-cc-production.up.railway.app (same-origin dashboard host)
 * For any other origin (or no Origin header at all) the server must return NO
 * Access-Control-Allow-Origin header -- never a mismatched origin, which makes
 * browsers block the response with "has been blocked by CORS policy".
 *
 * This suite proves:
 *   - GET + OPTIONS on /subscription echo the four allowed origins
 *   - an unknown origin (https://evil.example.com) gets NO ACAO header
 *   - a request with no Origin header gets NO ACAO header
 *   - the old stale platform origin (https://collectionscopilot.ctonew.app)
 *     is NOT allowed any more
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-cors.db). Run via:
 *
 *   bash /tmp/run-suite.sh cors
 *
 * (boots an isolated server with a fresh DB and stripped provider keys).
 */
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const ALLOWED = [
  "https://dashboard.stripe.com",
  "https://appmarket.stripe.com",
  "https://www.getcollectionscopilot.com",
  "https://stripe-cc-production.up.railway.app",
];
const DENIED = [
  "https://evil.example.com",
  "https://collectionscopilot.ctonew.app",
];
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

async function main(): Promise<void> {
  // GET /subscription — session-protected (401 without a session) but CORS
  // headers are attached to every API response, so 401 is fine for the test.
  for (const origin of ALLOWED) {
    const res = await fetch(`${BASE}/subscription`, { headers: { Origin: origin } });
    const acao = res.headers.get("access-control-allow-origin");
    check(`GET /subscription echoes ${origin}`, acao === origin, `acao=${acao}`);
    check(`GET /subscription credentials true for ${origin}`, res.headers.get("access-control-allow-credentials") === "true", `creds=${res.headers.get("access-control-allow-credentials")}`);
  }
  for (const origin of DENIED) {
    const res = await fetch(`${BASE}/subscription`, { headers: { Origin: origin } });
    const acao = res.headers.get("access-control-allow-origin");
    check(`GET /subscription denies ${origin} (no ACAO)`, acao === null, `acao=${acao}`);
    check(`GET /subscription denies credentials for ${origin}`, res.headers.get("access-control-allow-credentials") === null, `creds=${res.headers.get("access-control-allow-credentials")}`);
  }
  // No Origin header at all (same-origin / non-CORS request).
  const noOrigin = await fetch(`${BASE}/subscription`);
  const acaoNone = noOrigin.headers.get("access-control-allow-origin");
  check("GET /subscription with no Origin gets no ACAO", acaoNone === null, `acao=${acaoNone}`);

  // OPTIONS preflight — the browser sends this before the real request.
  for (const origin of ALLOWED) {
    const res = await fetch(`${BASE}/subscription`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    check(`OPTIONS /subscription preflight 204 for ${origin}`, res.status === 204, `status=${res.status}`);
    const acao = res.headers.get("access-control-allow-origin");
    check(`OPTIONS /subscription echoes ${origin}`, acao === origin, `acao=${acao}`);
    const methods = res.headers.get("access-control-allow-methods");
    check(`OPTIONS /subscription methods for ${origin}`, methods === "GET, POST, PUT, OPTIONS", `methods=${methods}`);
  }
  for (const origin of DENIED) {
    const res = await fetch(`${BASE}/subscription`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    const acao = res.headers.get("access-control-allow-origin");
    check(`OPTIONS /subscription preflight denies ${origin}`, acao === null, `acao=${acao} status=${res.status}`);
  }
  const noOriginOpt = await fetch(`${BASE}/subscription`, {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Method": "GET" },
  });
  check("OPTIONS with no Origin gets no ACAO", noOriginOpt.headers.get("access-control-allow-origin") === null, `acao=${noOriginOpt.headers.get("access-control-allow-origin")}`);

  // Same checks on another fetch target (/stripe/connection is public 200).
  for (const origin of ALLOWED) {
    const res = await fetch(`${BASE}/stripe/connection`, { headers: { Origin: origin } });
    const acao = res.headers.get("access-control-allow-origin");
    check(`GET /stripe/connection echoes ${origin}`, acao === origin, `acao=${acao} status=${res.status}`);
  }
  const evilConn = await fetch(`${BASE}/stripe/connection`, { headers: { Origin: "https://evil.example.com" } });
  check("GET /stripe/connection denies unknown origin", evilConn.headers.get("access-control-allow-origin") === null, `acao=${evilConn.headers.get("access-control-allow-origin")}`);

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERROR", e); process.exit(1); });
