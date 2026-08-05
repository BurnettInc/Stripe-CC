import type { Database } from "bun:sqlite";

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
