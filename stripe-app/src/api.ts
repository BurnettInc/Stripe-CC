/// <reference types="vite/client" />

/**
 * Base URL of the CollectionsCopilot backend.
 *
 * Build-time override via the VITE_BACKEND_URL env var (e.g.
 * `VITE_BACKEND_URL=https://... bun run build`). Defaults to the production
 * Railway backend.
 *
 * The backend routes live at the ROOT — there is NO /api prefix. Views call
 * `${BASE_URL}/subscription`, `${BASE_URL}/settings`, `${BASE_URL}/tasks`,
 * `/stripe/connect`, etc. Keep this value origin-only (no path suffix).
 */
export const BASE_URL: string =
  (import.meta as any).env?.VITE_BACKEND_URL ?? 'https://stripe-cc-production.up.railway.app';

/**
 * Public marketing/landing site URL.
 *
 * Build-time override via the VITE_LANDING_URL env var (e.g.
 * `VITE_LANDING_URL=https://... bun run build`). Defaults to the permanent
 * public marketing site, which hosts the full product pitch, pricing, and
 * support info.
 */
export const LANDING_URL: string =
  (import.meta as any).env?.VITE_LANDING_URL ?? 'https://www.getcollectionscopilot.com';

/**
 * Full web dashboard URL.
 *
 * The public site (LANDING_URL) serves the merchant dashboard at /dashboard,
 * so the drawer's "Open full dashboard" escape hatch points there — the same
 * origin serves both the landing page and the app console.
 */
export const DASHBOARD_URL: string = `${LANDING_URL}/dashboard`;

/**
 * Marketplace install initiation URL (reviewer fix #4).
 *
 * The drawer's "Connect Stripe" buttons must start the OFFICIAL marketplace
 * OAuth install flow — NOT the legacy web-connect /stripe/connect?return=stripe
 * flow. `${BASE_URL}/oauth/install?auto=1&link=live` is the install page in
 * auto mode: it 302s into /oauth/install/start?link=live, which mints the
 * CSRF state and redirects to marketplace.stripe.com/oauth/v2/authorize?…
 * (the official Live-mode URL; no chnlink/testing-channel parameters ship in
 * production).
 *
 * Single exported constant so a follow-up can make it mode-aware (live|test
 * from the drawer environment) by editing THIS ONE SPOT — every view imports
 * INSTALL_URL instead of inlining a URL.
 */
export const INSTALL_URL: string = `${BASE_URL}/oauth/install?auto=1&link=live`;
