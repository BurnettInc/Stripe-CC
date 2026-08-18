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
 * Live/Test Dashboard mode (reviewer fix #5).
 *
 * Stripe passes the active Dashboard mode ('live' | 'test') to every view
 * component via the extension `environment` prop (see
 * `ExtensionContextValue['environment']` in @stripe/ui-extension-sdk/context —
 * the SDK v9.x ships the environment as a PROP, not a module-scope hook, so
 * each view reads `props.environment.mode` and registers it here with
 * `setActiveMode()` inside the component body). Every backend fetch then
 * carries `X-Stripe-Mode` so the backend serves ONLY that mode's data.
 */
export type Mode = 'live' | 'test';

let activeMode: Mode = 'live';

/**
 * Register the active Dashboard mode from a view's `environment` prop.
 * Views call this at the top of their component body (NOT at module scope —
 * the environment is only available inside a rendered view).
 */
export function setActiveMode(mode?: Mode): void {
  activeMode = mode === 'test' ? 'test' : 'live';
}

/** The currently registered mode (defaults to 'live' — safe for non-drawer callers). */
export function getActiveMode(): Mode {
  return activeMode;
}

/** Human-readable title suffix, e.g. " — Test mode" so the reviewer can SEE which mode's data is shown. */
export function modeTitleSuffix(mode: Mode): string {
  return mode === 'test' ? ' — Test mode' : ' — Live mode';
}

/**
 * Central backend fetch for every drawer view (reviewer fix #5).
 *
 * Sets `X-Stripe-Mode: live|test` on EVERY request (from the active mode
 * registered by the view's environment prop) and keeps `credentials:
 * 'include'` so the merchant's backend session cookie rides along. Callers may
 * pass their own headers (e.g. Content-Type); the mode header is always set.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('X-Stripe-Mode', activeMode);
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: init?.credentials ?? 'include',
  });
}

/**
 * Marketplace install initiation URL for a specific mode (reviewer fix #4 +
 * #5). The drawer's "Connect Stripe" buttons must start the OFFICIAL
 * marketplace OAuth install flow — NOT the legacy web-connect
 * /stripe/connect?return=stripe flow. `${BASE_URL}/oauth/install?auto=1&link=
 * live|test` is the install page in auto mode: it 302s into
 * /oauth/install/start?link=live|test, which mints the CSRF state and
 * redirects to marketplace.stripe.com/oauth/v2/authorize?… with the
 * mode-matched client id (the official Live-mode URL in production; no
 * chnlink/testing-channel parameters ship in production).
 */
export function installUrlFor(mode: Mode): string {
  return `${BASE_URL}/oauth/install?auto=1&link=${mode}`;
}
/**
 * Live-default install URL, kept for anything that can't reach a view's
 * environment prop (e.g. module-scope code). Views should prefer
 * `installUrlFor(mode)`.
 */
export const INSTALL_URL: string = installUrlFor('live');
