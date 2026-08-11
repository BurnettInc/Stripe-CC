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
