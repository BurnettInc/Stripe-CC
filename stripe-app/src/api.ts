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
