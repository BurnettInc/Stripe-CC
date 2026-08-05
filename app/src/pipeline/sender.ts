import type { Database } from "bun:sqlite";
import type { Invoice, ReminderTask } from "../db";
import { logSend } from "../db";
import type { EmailDraft } from "./drafter";

export interface SendResult {
  success: boolean;
  message: string;
  logId: number;
  provider?: string;
}

/**
 * Actually send an email via a configured provider (SendGrid or Resend),
 * falling back to logging-only behavior when no provider key is set.
 */
export async function sendEmailForReal(
  db: Database,
  task: ReminderTask | null,
  draft: EmailDraft,
  toEmail: string,
  fromEmail?: string,
): Promise<SendResult> {
  const from = fromEmail || process.env.FROM_EMAIL || "noreply@stripecollectionscopilot.com";
  const subject = draft.subject;
  const body = draft.body;

  const sendgridKey = process.env.SENDGRID_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  // ── Try SendGrid ──
  if (sendgridKey) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: toEmail }] }],
          from: { email: from },
          subject,
          content: [{ type: "text/plain", value: body }],
        }),
      });

      if (res.ok) {
        const msg = `Email sent via SendGrid to ${toEmail}`;
        if (task) {
          logSend(db, task.id, "success", msg);
          const now = new Date().toISOString();
          db.run("UPDATE reminder_tasks SET status='sent', sent_at=? WHERE id=?", [now, task.id]);
        }
        return { success: true, message: msg, logId: 0, provider: "sendgrid" };
      } else {
        const errText = await res.text();
        const msg = `SendGrid send failed (${res.status}): ${errText}`;
        if (task) logSend(db, task.id, "failed", msg);
        return { success: false, message: msg, logId: 0, provider: "sendgrid" };
      }
    } catch (err: unknown) {
      const msg = `SendGrid send error: ${err instanceof Error ? err.message : String(err)}`;
      if (task) logSend(db, task.id, "failed", msg);
      return { success: false, message: msg, logId: 0, provider: "sendgrid" };
    }
  }

  // ── Try Resend ──
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: toEmail,
          subject,
          text: body,
        }),
      });

      if (res.ok) {
        const msg = `Email sent via Resend to ${toEmail}`;
        if (task) {
          logSend(db, task.id, "success", msg);
          const now = new Date().toISOString();
          db.run("UPDATE reminder_tasks SET status='sent', sent_at=? WHERE id=?", [now, task.id]);
        }
        return { success: true, message: msg, logId: 0, provider: "resend" };
      } else {
        const errText = await res.text();
        const msg = `Resend send failed (${res.status}): ${errText}`;
        if (task) logSend(db, task.id, "failed", msg);
        return { success: false, message: msg, logId: 0, provider: "resend" };
      }
    } catch (err: unknown) {
      const msg = `Resend send error: ${err instanceof Error ? err.message : String(err)}`;
      if (task) logSend(db, task.id, "failed", msg);
      return { success: false, message: msg, logId: 0, provider: "resend" };
    }
  }

  // ── Fallback: log-only mode ──
  return sendEmail(db, task, draft);
}

/**
 * Send an email (log-only fallback when no provider is configured).
 * Logs what it WOULD send.
 */
export function sendEmail(
  db: Database,
  task: ReminderTask | null,
  draft: EmailDraft
): SendResult {
  // Fix 5: Check payment status before sending — skip if already paid
  if (task) {
    if (checkPaymentStatus(db, task.invoice_id)) {
      const invoice = db
        .query("SELECT customer_name, stripe_invoice_id FROM invoices WHERE id = ?")
        .get(task.invoice_id) as { customer_name: string; stripe_invoice_id: string } | null;

      const custName = invoice?.customer_name || "Customer";
      const invId = invoice?.stripe_invoice_id || `#${task.invoice_id}`;

      // Log the skip
      const skipMsg = `Invoice ${task.invoice_id} is already paid — skipping send`;
      logSend(db, task.id, "skipped", skipMsg);

      // Also log a simulated "thank you" note for the pipeline log
      const thankYouMsg = [
        `[THANK YOU NOTE] Would send to ${custName}:`,
        `  Subject: Thanks for your payment — ${invId}`,
        `  Body: Hi ${custName}, just wanted to say thanks for taking care of invoice ${invId}. We appreciate your prompt payment!`,
      ].join("\n");
      logSend(db, task.id, "success", thankYouMsg, "reminder");

      return {
        success: false,
        message: skipMsg,
        logId: 0,
      };
    }
  }

  const message = [
    `[STUB SEND] Would send email:`,
    `  To: (customer from invoice)`,
    `  Subject: ${draft.subject}`,
    `  Body preview: ${draft.body.substring(0, 100)}...`,
  ].join("\n");

  if (task) {
    logSend(db, task.id, "success", message);

    const now = new Date().toISOString();
    db.run("UPDATE reminder_tasks SET status='sent', sent_at=? WHERE id=?", [now, task.id]);
  }

  return {
    success: true,
    message: `Email logged (stub): ${draft.subject}`,
    logId: 0, // will be looked up if needed
  };
}

/**
 * Check if an invoice has been paid (by querying the DB).
 * Returns true if the invoice status is 'paid'.
 */
export function checkPaymentStatus(db: Database, invoiceId: number): boolean {
  const invoice = db
    .query("SELECT status FROM invoices WHERE id = ?")
    .get(invoiceId) as Invoice | null;
  return invoice?.status === "paid";
}
