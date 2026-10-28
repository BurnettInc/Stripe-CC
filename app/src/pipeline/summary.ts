import type { Database } from "bun:sqlite";

/** UTC calendar date ('YYYY-MM-DD') for a timestamp given in epoch ms. */
export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse a timestamp this app stores into epoch ms. Two formats exist side by
 * side and must both work when we compare them:
 *   - SQLite `datetime('now')` — 'YYYY-MM-DD HH:MM:SS', UTC, no zone marker
 *     (merchants.created_at, summary_sends.sent_at)
 *   - ISO-8601 — 'YYYY-MM-DDTHH:MM:SS.sssZ'
 *     (stripe_connections.created_at, written by the OAuth handshake)
 * A space-separated value carries no zone, so it is pinned to UTC explicitly —
 * `new Date("YYYY-MM-DD HH:MM:SS")` alone would be parsed in LOCAL time and the
 * comparison would drift with the host timezone. NULL / empty / unparseable
 * input returns null: callers must treat that as "unknown", never as "now".
 */
export function parseStoredDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !hasZone
    ? s.replace(" ", "T") + "Z"
    : s;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The merchant's Stripe connect time in epoch ms:
 * MAX(stripe_connections.created_at) for that merchant, falling back to
 * merchants.created_at when no connection row exists at all.
 *
 * The fallback matters because a merchants row can be created before the OAuth
 * handshake completes; the connect row is the real "they are live" moment. NULL
 * (nothing parses) means "unknown" — callers must never treat it as "now".
 *
 * Single implementation, shared by the scheduled weekly-summary pass (cadence
 * anchor + window guard) and the on-demand POST /summary/send route, so the two
 * paths can never disagree about when a merchant really connected.
 */
export function merchantConnectMs(
  db: Database,
  merchant: { id: number; created_at?: string | null }
): number | null {
  const row = db
    .query("SELECT MAX(created_at) AS connected_at FROM stripe_connections WHERE merchant_id = ?")
    .get(merchant.id) as { connected_at: string | null } | null;
  return parseStoredDate(row?.connected_at) ?? parseStoredDate(merchant.created_at);
}

/**
 * Owner-approved guard (2026-10-28): a weekly summary must never be sent to a
 * merchant whose reporting window STARTS BEFORE they connected Stripe — a
 * merchant 16 minutes into the product must not receive a "your last 7 days"
 * report covering a week they were not there for.
 *
 * `periodStart` is the summary's UTC date ('YYYY-MM-DD', generated as now-7d);
 * `connectAtMs` is the merchant's Stripe connect time in epoch ms (null when
 * unknown, in which case the guard cannot fire). ISO dates compare correctly
 * as strings. Exported so the eligibility rule is unit-testable on its own.
 *
 * Enforced in BOTH send paths: the scheduled pass (scheduler.ts) and the manual
 * POST /summary/send route (index.ts). A guard hit is a skip, not an attempt:
 * no email, no send_logs row, no summary_sends row.
 */
export function summaryWindowPredatesConnect(periodStart: string, connectAtMs: number | null): boolean {
  if (connectAtMs === null) return false;
  return periodStart < utcDateString(connectAtMs);
}

export interface WeeklySummary {
  merchantId: number;
  periodStart: string;
  periodEnd: string;
  invoicesRecovered: number;
  amountCollectedDollars: number;
  remindersSent: number;
  activeSequences: number;
  recoveryRatePercent: number;
}

/**
 * Generate a weekly summary for a given merchant covering the last 7 days.
 */
export function generateWeeklySummary(db: Database, merchantId: number): WeeklySummary {
  const now = new Date();
  const periodEnd = now.toISOString().split("T")[0];
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = sevenDaysAgo.toISOString().split("T")[0];

  // Invoices recovered: were overdue and are now 'paid', updated in the last 7 days.
  // We approximate this as invoices with status='paid' whose due_date falls in the period
  // OR that had a reminder task created in the period and the invoice is now paid.
  // The most reliable approach: invoices that are paid AND had an associated reminder_task
  // that was created or sent within the last 7 days.
  const recoveredRow = db.query(`
    SELECT COUNT(DISTINCT i.id) as count, COALESCE(SUM(i.amount_cents), 0) as total_cents
    FROM invoices i
    INNER JOIN reminder_tasks rt ON rt.invoice_id = i.id
    WHERE i.merchant_id = ?
      AND i.status = 'paid'
      AND i.due_date >= ?
      AND i.due_date <= ?
      AND rt.created_at >= ?
  `).get(merchantId, periodStart, periodEnd, periodStart + " 00:00:00") as { count: number; total_cents: number } | null;

  const invoicesRecovered = recoveredRow?.count ?? 0;
  const amountCollectedDollars = (recoveredRow?.total_cents ?? 0) / 100;

  // Reminders sent: count of send_logs with status='success' in the last 7 days
  // that belong to this merchant's tasks.
  const remindersSentRow = db.query(`
    SELECT COUNT(*) as count
    FROM send_logs sl
    INNER JOIN reminder_tasks rt ON rt.id = sl.reminder_task_id
    INNER JOIN invoices i ON i.id = rt.invoice_id
    WHERE i.merchant_id = ?
      AND sl.status = 'success'
      AND sl.type = 'reminder'
      AND sl.created_at >= ?
  `).get(merchantId, periodStart + " 00:00:00") as { count: number } | null;

  const remindersSent = remindersSentRow?.count ?? 0;

  // Active sequences: reminder_tasks with status IN ('pending','drafted','reviewed')
  // (not yet sent or cancelled), for this merchant.
  const activeSeqRow = db.query(`
    SELECT COUNT(*) as count
    FROM reminder_tasks rt
    INNER JOIN invoices i ON i.id = rt.invoice_id
    WHERE i.merchant_id = ?
      AND rt.status IN ('pending', 'drafted', 'reviewed')
  `).get(merchantId) as { count: number } | null;

  const activeSequences = activeSeqRow?.count ?? 0;

  // Recovery rate: of overdue invoices from the period (due date in range), what % got paid?
  const totalOverdueRow = db.query(`
    SELECT COUNT(*) as count
    FROM invoices i
    WHERE i.merchant_id = ?
      AND i.due_date >= ?
      AND i.due_date <= ?
  `).get(merchantId, periodStart, periodEnd) as { count: number } | null;

  const totalOverdue = totalOverdueRow?.count ?? 0;
  const recoveryRatePercent = totalOverdue > 0
    ? Math.round((invoicesRecovered / totalOverdue) * 100)
    : 0;

  return {
    merchantId,
    periodStart,
    periodEnd,
    invoicesRecovered,
    amountCollectedDollars,
    remindersSent,
    activeSequences,
    recoveryRatePercent,
  };
}
