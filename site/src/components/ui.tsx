import type { ReactNode } from "react";

/* =====================================================================
 * CollectionsCopilot marketing-site design system
 * ---------------------------------------------------------------------
 * Single source of truth for the shared visual recipes used across the
 * landing, how-it-works, trust, and FAQ pages. The goal is that every
 * page reads as one considered design system rather than sections each
 * styled independently.
 *
 *   Accent   indigo (matches the Stripe-app brand + primary buttons)
 *   Status   green = auto-send / positive
 *            amber = customer-reply alert
 * ===================================================================== */

/* ---- Card framing: one recipe for every card-style element ----
 * Split into a base + border so call-elements that need a different
 * border (FAQ open state, highlighted pricing tier) can swap the border
 * without a Tailwind specificity conflict. */
export const CARD_BASE = "rounded-2xl bg-white shadow-sm";
export const BORDER_DEFAULT = "border border-gray-200";
export const CARD = `${CARD_BASE} ${BORDER_DEFAULT}`;

/* ---- Tinted callouts (distinct from cards — no shadow on tinted bg) ---- */
export const CALLOUT_INDIGO = "rounded-2xl border border-indigo-200 bg-indigo-50 p-8";
export const CALLOUT_AMBER = "rounded-2xl border border-amber-200 bg-amber-50 p-8";

/* ---- Buttons ---- */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700";
export const BTN_SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-6 py-3 text-base font-medium text-gray-700 transition-colors hover:bg-gray-50";
export const BTN_PRIMARY_NAV =
  "inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700";

/* ---- Type scale (5 deliberate levels, same classes per role) ---- */
export const TYPE = {
  /* 1. Hero / display — landing H1 */
  hero: "text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl",
  /* 2. Page title — interior-page H1 */
  pageTitle: "text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl",
  /* 3. Section heading — H2 */
  h2: "text-2xl font-bold tracking-tight text-gray-900",
  h2Center: "text-2xl font-bold tracking-tight text-center text-gray-900",
  /* 4. Card / eyebrow heading — H3 */
  h3: "text-lg font-bold text-gray-900",
  /* Body */
  bodyLg: "text-lg text-gray-600 leading-relaxed",
  body: "text-sm text-gray-600 leading-relaxed",
  /* 5. Caption */
  caption: "text-xs text-gray-500",
} as const;

/* ---- Section spacing rhythm ----
 * Three deliberate sizes by section role. */
export const PY_RELATED = "py-14"; /* tight — related content blocks */
export const PY_MAIN = "py-16"; /* standard — major sections */
export const PY_CTA = "py-20"; /* generous — closing CTA band */

/* ---- Status colors (same status => same treatment, everywhere) ----
 * green = auto-send / positive · gray = neutral "waits for approval" */
export const STATUS_AUTO = "text-green-600";
export const STATUS_WAIT = "text-gray-500";
export const STATUS_AUTO_ROW = "text-green-700 font-medium";

/* ---- Accent check glyph: one consistent treatment for bullet lists ---- */
export function Check({ className = "" }: { className?: string }) {
  return (
    <span
      className={`mt-0.5 shrink-0 text-indigo-600 ${className}`}
      aria-hidden="true"
    >
      ✓
    </span>
  );
}

/* ---- Shared marketing helpers referenced by several pages (kept for
 *      convenience; container widths stay per-section to preserve layout) ---- */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-gray-600 leading-relaxed">{children}</p>;
}
