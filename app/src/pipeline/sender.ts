import type { Database } from "bun:sqlite";
import type { Invoice, ReminderTask } from "../db";
import { logSend, isUnsubscribed, resolveMerchant } from "../db";
import type { EmailDraft } from "./drafter";
import { appendCanspamFooter } from "./canspam";
import { notifyMerchant } from "./notify";

export interface SendResult {
  success: boolean;
  message: string;
  logId: number;
  provider?: string;
}

export interface SendOptions {
  /**
   * Skip the CAN-SPAM unsubscribe footer. Used for merchant account alerts
   * (their own account notifications — no customer opt-out needed); the
   * caller is responsible for including any required contact line itself.
   */
  skipCanspam?: boolean;
}

/**
 * Notify the merchant when a Stage 2 or Stage 3 reminder actually sends
 * (homepage Full Auto promise: "You're notified when something happens —
 * sequence escalated"). Stage 1 sends are deliberately silent (too noisy).
 * No-op for null tasks (weekly summaries, merchant notifications themselves —
 * no recursion) and failed sends: callers only invoke this after a confirmed
 * success.
 */
async function notifyOnEscalatedSend(db: Database, task: ReminderTask | null): Promise<void> {
  if (!task || task.stage < 2) return;
  const invoice = db
    .query("SELECT merchant_id, customer_name, stripe_invoice_id FROM invoices WHERE id=?")
    .get(task.invoice_id) as { merchant_id: number; customer_name: string; stripe_invoice_id: string } | null;
  if (!invoice) return;

  const label = task.stage === 2 ? "firmer follow-up" : "final notice";
  await notifyMerchant(
    db,
    invoice.merchant_id,
    `Invoice ${invoice.stripe_invoice_id} escalated to Stage ${task.stage}`,
    `Invoice ${invoice.stripe_invoice_id} escalated to Stage ${task.stage} — ${label} sent to ${invoice.customer_name}.`
  );
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
  opts?: SendOptions,
): Promise<SendResult> {
  // CAN-SPAM: never email a customer who has opted out.
  const optOutSkip = checkUnsubscribedAndSkip(db, task);
  if (optOutSkip) return optOutSkip;

  // Payment guard runs on the real-send path too: never send a dunning
  // email for an invoice that has been paid since review. (Previously this
  // check only lived in the stub fallback `sendEmail()`.)
  const paidSkip = checkPaidAndSkip(db, task);
  if (paidSkip) return paidSkip;

  const from = fromEmail || process.env.FROM_EMAIL || "noreply@stripecollectionscopilot.com";
  const subject = draft.subject;
  // CAN-SPAM: append the compliance footer (opt-out link + physical address)
  // to the AI-drafted or template-fallback body before it goes out — unless
  // the caller opts out (merchant account alerts carry their own contact line).
  const body = opts?.skipCanspam
    ? draft.body
    : appendCanspamFooter(draft.body, ...footerContextFor(db, task, toEmail));

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
        await notifyOnEscalatedSend(db, task);
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
        await notifyOnEscalatedSend(db, task);
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
  const stubResult = sendEmail(db, task, draft, opts);
  if (stubResult.success) await notifyOnEscalatedSend(db, task);
  return stubResult;
}

/**
 * Send an email (log-only fallback when no provider is configured).
 * Logs what it WOULD send.
 */
export function sendEmail(
  db: Database,
  task: ReminderTask | null,
  draft: EmailDraft,
  opts?: SendOptions,
): SendResult {
  // CAN-SPAM: never email a customer who has opted out.
  const optOutSkip = checkUnsubscribedAndSkip(db, task);
  if (optOutSkip) return optOutSkip;

  // Fix 5: Check payment status before sending — skip if already paid
  const paidSkip = checkPaidAndSkip(db, task);
  if (paidSkip) return paidSkip;

  // CAN-SPAM: the stub preview reflects what the real send would include.
  const body = opts?.skipCanspam
    ? draft.body
    : appendCanspamFooter(draft.body, ...footerContextFor(db, task));

  const message = [
    `[STUB SEND] Would send email:`,
    `  To: (customer from invoice)`,
    `  Subject: ${draft.subject}`,
    `  Body preview: ${body.substring(0, 100)}...`,
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

/**
 * Shared payment guard for both send paths (real provider and stub).
 * If the invoice is already paid, logs the skip plus a simulated thank-you
 * note and returns a SendResult describing the skip. Returns null when the
 * send may proceed (no task, or invoice is not paid).
 */
function checkPaidAndSkip(db: Database, task: ReminderTask | null): SendResult | null {
  if (!task) return null;
  if (!checkPaymentStatus(db, task.invoice_id)) return null;

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

/**
 * CAN-SPAM: skip sends to customers who have opted out via the
 * /api/unsubscribe endpoint. Returns a SendResult describing the skip when
 * the customer is opted out, otherwise null (send may proceed).
 */
function checkUnsubscribedAndSkip(db: Database, task: ReminderTask | null): SendResult | null {
  if (!task) return null;
  const invoice = db
    .query("SELECT merchant_id, customer_email FROM invoices WHERE id = ?")
    .get(task.invoice_id) as { merchant_id: number; customer_email: string } | null;
  if (!invoice || !invoice.customer_email) return null;
  if (!isUnsubscribed(db, invoice.merchant_id, invoice.customer_email)) return null;

  const msg = `Customer ${invoice.customer_email} has opted out of reminders — skipping send`;
  logSend(db, task.id, "skipped", msg);
  return { success: false, message: msg, logId: 0 };
}

/**
 * Resolve the merchant + customer email needed for the CAN-SPAM footer.
 * For reminder sends both come from the task's invoice; when there is no task
 * (e.g. weekly summaries), falls back to the default merchant and the
 * recipient's email address. Returns a [merchantId, customerEmail] tuple for
 * spread-compatibility with appendCanspamFooter(body, ...footerContextFor(...)).
 */
function footerContextFor(
  db: Database,
  task: ReminderTask | null,
  toEmail?: string,
): [number, string] {
  let merchantId: number | null = null;
  let customerEmail = toEmail ?? "";
  if (task) {
    const invoice = db
      .query("SELECT merchant_id, customer_email FROM invoices WHERE id = ?")
      .get(task.invoice_id) as { merchant_id: number; customer_email: string } | null;
    if (invoice) {
      merchantId = invoice.merchant_id;
      if (invoice.customer_email) customerEmail = invoice.customer_email;
    }
  }
  if (merchantId === null) {
    merchantId = resolveMerchant(db)?.id ?? 0;
  }
  return [merchantId, customerEmail];
}
