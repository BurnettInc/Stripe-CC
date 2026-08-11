/**
 * Late-fee automation (Pro, informational ONLY).
 *
 * The merchant's late-fee settings (migration 009: late_fee_type / late_fee_value)
 * are surfaced in Stage 2 / Stage 3 reminder emails as a soft informational
 * sentence — NEVER as an actual charge. The pipeline has read-only permissions;
 * no API call is made to add a fee to the Stripe invoice, and the copy never
 * claims a fee was charged. The homepage carries the legal disclaimer.
 *
 * Formatting:
 *   flat    → "$25.00"                         (value is dollars)
 *   percent → "$18.75 (1.5% of the invoice)"    (computed from invoice amount)
 *   none    → null (no fee mentioned)
 * Stage 1 drafts never mention a fee.
 */

import type { Database } from "bun:sqlite";
import type { Invoice } from "../db";

export interface LateFeeConfig {
  type: "none" | "flat" | "percent";
  value: number;
}

/** Read the merchant's late-fee configuration (always present post-migration 009). */
export function getLateFeeConfig(db: Database, merchantId: number): LateFeeConfig {
  const row = db
    .query("SELECT late_fee_type, late_fee_value FROM merchants WHERE id=?")
    .get(merchantId) as { late_fee_type: string; late_fee_value: number } | null;
  if (!row) return { type: "none", value: 0 };
  const type: LateFeeConfig["type"] =
    row.late_fee_type === "flat" || row.late_fee_type === "percent"
      ? row.late_fee_type
      : "none";
  return { type, value: row.late_fee_value ?? 0 };
}

/** Percent display: strip trailing zeros ("1.5", "2", "0.75"), cap at 2 decimals. */
function formatPercent(v: number): string {
  return String(Number(v.toFixed(2)));
}

/**
 * The exact fee sentence fragment the drafter must include and the reviewer
 * must verify, or null when no fee applies (none configured, value 0, or
 * stage 1). Callers use ONE function so the math can never drift between
 * drafting and review.
 */
export function formatLateFeeText(config: LateFeeConfig, invoice: Invoice, stage: number): string | null {
  if (stage < 2) return null;
  if (config.type === "none" || config.value <= 0) return null;
  if (config.type === "flat") return `$${config.value.toFixed(2)}`;
  // percent: fee cents = amount_cents * (value/100), rounded to the cent.
  const feeCents = Math.round(invoice.amount_cents * config.value / 100);
  const feeDollars = (feeCents / 100).toFixed(2);
  return `$${feeDollars} (${formatPercent(config.value)}% of the invoice)`;
}

/** Convenience: config + text for a merchant's invoice/stage in one call. */
export function getLateFeeText(db: Database, merchantId: number, invoice: Invoice, stage: number): string | null {
  return formatLateFeeText(getLateFeeConfig(db, merchantId), invoice, stage);
}
