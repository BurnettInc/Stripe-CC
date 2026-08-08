import type { Database } from "bun:sqlite";

export interface AggregateStats {
  totalMerchants: number;
  totalInvoicesTracked: number;
  totalInvoicesRecovered: number;
  totalAmountCollectedDollars: number;
  totalRemindersSent: number;
  activeSequences: number;
  overallRecoveryRatePercent: number;
}

/**
 * Cross-merchant aggregate recovery stats for the internal dashboard.
 * Sums metrics across ALL merchants — no merchant filter.
 *
 * Recovery is attributed to the product only when a paid invoice had at
 * least one reminder task (i.e., we helped recover it), mirroring the
 * per-merchant logic in pipeline/summary.ts.
 */
export function handleAggregate(db: Database): AggregateStats {
  // Total merchants ever onboarded
  const merchantsRow = db.query("SELECT COUNT(*) as count FROM merchants").get() as { count: number };

  // Total invoices ever seen (any status)
  const trackedRow = db.query("SELECT COUNT(*) as count FROM invoices").get() as { count: number };

  // Paid invoices that had at least one reminder — we helped recover them
  const recoveredRow = db.query(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as total_cents
    FROM invoices
    WHERE status = 'paid'
      AND id IN (SELECT DISTINCT invoice_id FROM reminder_tasks)
  `).get() as { count: number; total_cents: number };

  // Reminder emails actually sent
  const remindersSentRow = db.query(
    "SELECT COUNT(*) as count FROM send_logs WHERE type = 'reminder' AND status = 'success'"
  ).get() as { count: number };

  // Active sequences (tasks not yet sent, paused, or cancelled)
  const activeSeqRow = db.query(
    "SELECT COUNT(*) as count FROM reminder_tasks WHERE status IN ('pending', 'drafted', 'reviewed')"
  ).get() as { count: number };

  const totalMerchants = merchantsRow.count;
  const totalInvoicesTracked = trackedRow.count;
  const totalInvoicesRecovered = recoveredRow.count;
  const totalAmountCollectedDollars = recoveredRow.total_cents / 100;
  const totalRemindersSent = remindersSentRow.count;
  const activeSequences = activeSeqRow.count;

  const overallRecoveryRatePercent = totalInvoicesTracked > 0
    ? Math.round((totalInvoicesRecovered / totalInvoicesTracked) * 100)
    : 0;

  return {
    totalMerchants,
    totalInvoicesTracked,
    totalInvoicesRecovered,
    totalAmountCollectedDollars,
    totalRemindersSent,
    activeSequences,
    overallRecoveryRatePercent,
  };
}
