import type { ReactNode } from "react";

/* =====================================================================
 * Collections Copilot marketing-site design system
 * ---------------------------------------------------------------------
 * Single source of truth for the shared visual recipes used across the
 * landing, how-it-works, trust, and FAQ pages. The goal is that every
 * page reads as one considered design system rather than sections each
 * styled independently.
 *
 *   Accent   brand purple #5B4FE0 (buttons / accents / links)
 *   Ink      near-black #131417 primary text · muted #62626B secondary
 *   Band     lavender-grey #F5F4FB section bands
 *   Hairline #E7E5E0 borders (card shadow-sm max — no heavy shadows)
 *   Status   success green #1C6B4E on #EAF4EF (payment-success only)
 *            amber #B5601B on #FCF1E5 (overdue tags only)
 *   Type     General Sans 600 (font-display) for headings/numbers/prices,
 *            Inter 400/500 (font-sans) for body/nav/labels
 * ===================================================================== */

/* ---- Card framing: one recipe for every card-style element ----
 * Split into a base + border so call-elements that need a different
 * border (FAQ open state, highlighted pricing tier) can swap the border
 * without a Tailwind specificity conflict. */
export const CARD_BASE = "rounded-[14px] bg-white shadow-sm";
export const BORDER_DEFAULT = "border border-hairline";
export const CARD = `${CARD_BASE} ${BORDER_DEFAULT}`;

/* ---- Tinted callouts (distinct from cards — no shadow on tinted bg) ---- */
export const CALLOUT_INDIGO = "rounded-[14px] border border-hairline bg-band p-8";
export const CALLOUT_AMBER = "rounded-[14px] border border-hairline bg-warn-bg p-8";

/* ---- Buttons ---- */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-brand px-6 py-3 text-base font-medium text-white shadow-sm transition-colors hover:bg-brand-deep";
export const BTN_SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-hairline bg-white px-6 py-3 text-base font-medium text-ink transition-colors hover:bg-band";
export const BTN_PRIMARY_NAV =
  "inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-deep";
export const BTN_SECONDARY_NAV =
  "inline-flex items-center justify-center rounded-lg border border-hairline bg-transparent px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-band";

/* ---- Type scale (5 deliberate levels, same classes per role) ---- */
export const TYPE = {
  /* 1. Hero / display — landing H1 (50px desktop, font-display semibold) */
  hero: "font-display text-[34px] leading-[1.08] tracking-[-0.01em] font-semibold text-ink sm:text-[50px]",
  /* 2. Page title — interior-page H1 */
  pageTitle: "font-display text-3xl font-semibold tracking-[-0.01em] text-ink sm:text-4xl",
  /* 3. Section heading — H2 (28–30px) */
  h2: "font-display text-[28px] sm:text-[30px] font-semibold tracking-[-0.01em] text-ink",
  h2Center: "font-display text-[28px] sm:text-[30px] font-semibold tracking-[-0.01em] text-center text-ink",
  /* 4. Card / eyebrow heading — H3 (15–16px, weight 600) */
  h3: "text-[15px] sm:text-base font-semibold text-ink",
  /* Body */
  bodyLg: "text-[17px] text-muted leading-[1.6]",
  body: "text-sm text-muted leading-relaxed",
  /* 5. Caption */
  caption: "text-[13px] text-muted",
} as const;

/* ---- Section spacing rhythm ----
 * Three deliberate sizes by section role. */
export const PY_RELATED = "py-14"; /* tight — related content blocks */
export const PY_MAIN = "py-16"; /* standard — major sections */
export const PY_CTA = "py-20"; /* generous — closing CTA band */

/* ---- Status colors (same status => same treatment, everywhere) ----
 * green = auto-send / positive · gray = neutral "waits for approval" */
export const STATUS_AUTO = "text-success-text";
export const STATUS_WAIT = "text-muted";
export const STATUS_AUTO_ROW = "text-success-text font-medium";

/* ---- Accent check glyph: one consistent treatment for bullet lists ---- */
export function Check({ className = "" }: { className?: string }) {
  return (
    <span
      className={`mt-0.5 shrink-0 text-brand ${className}`}
      aria-hidden="true"
    >
      ✓
    </span>
  );
}

/* ---- Shared marketing helpers referenced by several pages (kept for
 *      convenience; container widths stay per-section to preserve layout) ---- */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-muted leading-relaxed">{children}</p>;
}
