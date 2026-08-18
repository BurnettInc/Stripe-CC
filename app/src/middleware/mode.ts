/**
 * Live/Test mode signal (reviewer fix #5, 2026-08-18).
 *
 * The Stripe App drawer knows which Dashboard mode it runs in
 * (environment.mode — 'live' | 'test' from @stripe/ui-extension-sdk) and sends
 * it on EVERY backend fetch via the `X-Stripe-Mode: live|test` header (see
 * stripe-app/src/api.ts apiFetch). This helper parses that header for the
 * drawer-facing endpoints.
 *
 * Default is LIVE when the header is absent or unknown: the web dashboard and
 * every non-drawer caller send no header, and their behavior must be
 * unchanged (all pre-existing data is live). Only an explicit "test" selects
 * test mode.
 */

/** 1 = live, 0 = test — the value stored in invoices.livemode. */
export function requestLivemode(req: Request): number {
  return requestMode(req) === "test" ? 0 : 1;
}

/** 'live' | 'test' — default 'live' when the header is absent or unknown. */
export function requestMode(req: Request): "live" | "test" {
  const mode = req.headers.get("X-Stripe-Mode");
  return mode === "test" ? "test" : "live";
}
