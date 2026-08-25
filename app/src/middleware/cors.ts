/**
 * Shared CORS header computation for API responses that the Stripe App drawer
 * fetches. Extracted from index.ts so individual route handlers (e.g.
 * /overdue/summary) can attach the same headers themselves, independent of the
 * outer Bun.serve wrapper (which also applies them to every response).
 *
 * The drawer runs inside Stripe's dashboard and its marketplace/app-modal
 * contexts, so both stripe.com origins must be allowed. The www + Railway
 * origins are the same-origin hosts that serve the dashboard (harmless to
 * include). The old platform host (collectionscopilot.ctonew.app) was removed —
 * it serves only a stale CloudFront landing page with no API or dashboard, and
 * nothing calls our backend from it anymore.
 */
const allowedOrigins = new Set([
  "https://dashboard.stripe.com",
  "https://appmarket.stripe.com",
  "https://www.getcollectionscopilot.com",
  "https://stripe-cc-production.up.railway.app",
]);

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  // Only reflect a request's Origin when it is one we serve. For no-Origin
  // (same-origin / non-CORS) requests and unknown origins, return NO CORS
  // headers at all -- never a mismatched origin, which makes browsers block
  // the response ("has been blocked by CORS policy") and is a security leak.
  //
  // WHY "null" is allowed: the literal string "null" is the Origin of a
  // SANDBOXED IFRAME (the HTML spec serializes a sandboxed origin as "null").
  // Stripe's sandbox/preview drawer runs inside a sandboxed iframe and sends
  // Origin: null on every fetch to our backend. The sandbox page also sends
  // Referrer-Policy: no-referrer, so there is NO Referer header to gate on --
  // the only way to let the sandbox drawer through is to answer Origin: null.
  //
  // Accepted tradeoff: ANY sandboxed iframe can read credentialed responses
  // (Access-Control-Allow-Credentials is sent back). There is no sensitive
  // data yet (zero real merchants) and every endpoint is session/token gated.
  // Revisit this with token-based auth (Stripe App signed requests) before
  // real customers onboard. Only sandboxed iframes ever send Origin: null,
  // and this allowance is the standard pattern for Stripe Apps preview tests.
  if (!origin) return {};
  if (origin === "null" || allowedOrigins.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Stripe-Mode",
      "Vary": "Origin",
    };
  }
  return {};
}
