import type { WeeklySummary } from "./summary";

export interface SummaryEmail {
  subject: string;
  body: string;
}

/**
 * Format a weekly summary into a plain-text email.
 */
export function formatSummaryEmail(summary: WeeklySummary, merchantName: string): SummaryEmail {
  const dateRange = `${summary.periodStart} to ${summary.periodEnd}`;

  const subject = `Your weekly collections summary — ${dateRange}`;

  const body = [
    `Hi ${merchantName},`,
    "",
    `Here's your weekly collections summary for ${dateRange}:`,
    "",
    `  Invoices recovered:  ${summary.invoicesRecovered}`,
    `  Amount collected:    $${summary.amountCollectedDollars.toFixed(2)}`,
    `  Reminders sent:      ${summary.remindersSent}`,
    `  Active sequences:    ${summary.activeSequences}`,
    `  Recovery rate:       ${summary.recoveryRatePercent}%`,
    "",
    summary.recoveryRatePercent >= 50
      ? "Great work! Your recovery rate is looking strong this week."
      : "Tip: Sending reminders earlier can help improve your recovery rate.",
    "",
    "Managed by Stripe Collections Copilot",
  ].join("\n");

  return { subject, body };
}
