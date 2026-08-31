import type { Database } from "bun:sqlite";
import type { Invoice, ReminderTask } from "../db";
import { logSend, isUnsubscribed, resolveMerchant } from "../db";
import { recordFunnelEventForTask } from "../funnel";
import type { EmailDraft } from "./drafter";
import { appendCanspamFooter } from "./canspam";
import { notifyMerchant } from "./notify";

/**
 * Timeout for outbound email-provider calls. A stalled provider fetch must
 * fail fast instead of hanging the request forever (this is how a hung
 * magic-link request would manifest once it reaches the server).
 * Verified under Bun 1.3: AbortSignal.timeout() aborts fetch with a
 * TimeoutError ("The operation timed out.") after the given ms.
 */
const EMAIL_FETCH_TIMEOUT_MS = 15000;

/** Describe a provider fetch failure, with a clear message for timeouts. */
function providerErrorMessage(provider: string, err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `${provider} send timed out after ${EMAIL_FETCH_TIMEOUT_MS}ms`;
  }
  return `${provider} send error: ${err instanceof Error ? err.message : String(err)}`;
}

export interface SendResult {
  success: boolean;
  message: string;
  logId: number;
  provider?: string;
}

/**
 * Custom sender branding (Standard plan feature). The from-ADDRESS always
 * stays the global verified FROM_EMAIL — merchants only customize the display
 * name (stored on their merchant row, migration 009: sender_name).
 *
 * The Reply-To header is NO LONGER merchant-customizable (PR #56 removed the
 * dashboard field). Every CUSTOMER reminder send uses the system-tracked
 * address `reply+{invoice_id}@{REPLY_DOMAIN}` so customer replies route back
 * to the inbound pipeline (reply-pause feature, D1a). The merchant's
 * `reply_to` setting is repurposed as the FORWARD target — where captured
 * customer replies get forwarded (see routes/inbound.ts) — and never appears
 * in a Reply-To header.
 */
export interface SenderBranding {
  senderName?: string | null;
}

/** Strip characters that would break an RFC 5322 display-name. */
export function sanitizeDisplayName(name: string): string {
  return name.replace(/["\\\r\n]/g, "").trim().slice(0, 80);
}

/** Build the From header: `"Name" <email>` when a display name is set, else the bare email. */
export function buildFromAddress(email: string, senderName?: string | null): string {
  const clean = senderName ? sanitizeDisplayName(senderName) : "";
  return clean ? `"${clean}" <${email}>` : email;
}

/**
 * The tracked Reply-To for a CUSTOMER reminder send: `reply+{invoice_id}@
 * {REPLY_DOMAIN}` where invoice_id is the invoice's internal DB id (the value
 * the Cloudflare worker parses from the plus tag and sends back as
 * sequence_id). Null tasks (merchant notifications, weekly summaries) get no
 * Reply-To — replies to account alerts are not tracked.
 *
 * REPLY_DOMAIN is env-driven so the feature works before the DNS/MX wiring
 * exists (Cloudflare Email Routing is configured for the default below);
 * never depends on a config call.
 */
export function trackedReplyToForTask(task: { invoice_id: number } | null): string | undefined {
  if (!task) return undefined;
  const domain = process.env.REPLY_DOMAIN || "replies.getcollectionscopilot.com";
  return `reply+${task.invoice_id}@${domain}`;
}

/**
 * Resolve a merchant's branding for a CUSTOMER reminder send. Returns {} for
 * null tasks (merchant notifications, weekly summaries) — those keep the
 * neutral global from, never merchant branding. Only the sender display name
 * is returned: the Reply-To header is always the system-tracked address (see
 * trackedReplyToForTask); merchant.reply_to is the reply FORWARD target, not
 * a header.
 */
export function senderBrandingForTask(db: Database, task: ReminderTask | null): SenderBranding {
  if (!task) return {};
  const row = db
    .query(
      `SELECT m.sender_name
       FROM merchants m JOIN invoices i ON i.merchant_id = m.id
       WHERE i.id = ?`
    )
    .get(task.invoice_id) as { sender_name: string | null } | null;
  return { senderName: row?.sender_name ?? null };
}

export interface SendOptions {
  /**
   * Skip the CAN-SPAM unsubscribe footer. Used for merchant account alerts
   * (their own account notifications — no customer opt-out needed); the
   * caller is responsible for including any required contact line itself.
   */
  skipCanspam?: boolean;
  /**
   * Override the Reply-To header. Normally derived from the task (the tracked
   * reply+{invoice_id}@{REPLY_DOMAIN} address); reply-pause D1b passes it
   * explicitly for reply sends, which carry no reminder task.
   */
  replyTo?: string;
  /**
   * Override the sender display name. Normally derived from the task's
   * invoice merchant (senderBrandingForTask); reply sends (task = null) pass
   * the merchant's sender_name explicitly so replies look like they come from
   * the same sender as the reminders.
   */
  senderName?: string | null;
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

  // Custom sender branding: only customer reminders (task != null) carry the
  // merchant's display name. The Reply-To header is ALWAYS the system-tracked
  // reply+{invoice_id}@{REPLY_DOMAIN} address for customer reminders (so
  // customer replies route back to the inbound pipeline); merchant account
  // notifications pass task=null and keep the neutral global from with no
  // Reply-To. D1b reply sends (task = null) override both via SendOptions.
  const branding = opts?.senderName !== undefined
    ? { senderName: opts.senderName }
    : senderBrandingForTask(db, task);
  const baseFrom = fromEmail || process.env.FROM_EMAIL || "noreply@stripecollectionscopilot.com";
  const from = buildFromAddress(baseFrom, branding.senderName);
  const replyTo = opts?.replyTo ?? trackedReplyToForTask(task);

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
        signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
        body: JSON.stringify({
          personalizations: [{ to: [{ email: toEmail }] }],
          from: { email: baseFrom, ...(branding.senderName ? { name: branding.senderName } : {}) },
          ...(replyTo ? { reply_to: { email: replyTo } } : {}),
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
          recordFunnelEventForTask(db, task.id, "first_sent");
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
      const msg = providerErrorMessage("SendGrid", err);
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
        signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
        body: JSON.stringify({
          from,
          to: toEmail,
          ...(replyTo ? { reply_to: replyTo } : {}),
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
          recordFunnelEventForTask(db, task.id, "first_sent");
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
      const msg = providerErrorMessage("Resend", err);
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

  // The stub mirrors the real-send branding so log-only environments still
  // show exactly what a provider send would carry: the merchant display name
  // on From, and the system-tracked Reply-To for customer reminders. D1b
  // reply sends (task = null) override both via SendOptions.
  const branding = opts?.senderName !== undefined
    ? { senderName: opts.senderName }
    : senderBrandingForTask(db, task);
  const baseFrom = process.env.FROM_EMAIL || "noreply@stripecollectionscopilot.com";
  const from = buildFromAddress(baseFrom, branding.senderName);
  const replyTo = opts?.replyTo ?? trackedReplyToForTask(task);

  const message = [
    `[STUB SEND] Would send email:`,
    `  To: (customer from invoice)`,
    `  From: ${from}${replyTo ? `\n  Reply-To: ${replyTo}` : ""}`,
    `  Subject: ${draft.subject}`,
    `  Body preview: ${body.substring(0, 100)}...`,
  ].join("\n");

  if (task) {
    logSend(db, task.id, "success", message);

    const now = new Date().toISOString();
    db.run("UPDATE reminder_tasks SET status='sent', sent_at=? WHERE id=?", [now, task.id]);
    recordFunnelEventForTask(db, task.id, "first_sent");
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
 * Shared terminal-status guard for both send paths (real provider and stub).
 * If the invoice is paid, voided, or uncollectible (reviewer fix #2 — all
 * three are first-class terminal stop states; an invoice voided or marked
 * uncollectible in Stripe must never be emailed), logs the skip and returns a
 * SendResult describing it. The paid case keeps the simulated thank-you note;
 * void/uncollectible log the stop reason only (no thank-you — the customer
 * did not pay). Returns null when the send may proceed (no task, or the
 * invoice status is not terminal).
 */
function checkPaidAndSkip(db: Database, task: ReminderTask | null): SendResult | null {
  if (!task) return null;
  const invoice = db
    .query("SELECT status, customer_name, stripe_invoice_id FROM invoices WHERE id = ?")
    .get(task.invoice_id) as { status: string; customer_name: string; stripe_invoice_id: string } | null;
  if (!invoice) return null;
  const status = invoice.status;
  if (status !== "paid" && status !== "void" && status !== "uncollectible") return null;

  const custName = invoice.customer_name || "Customer";
  const invId = invoice.stripe_invoice_id || `#${task.invoice_id}`;

  // Log the skip with a status-specific reason (distinct per terminal state).
  const skipMsg =
    status === "paid"
      ? `Invoice ${task.invoice_id} is already paid — skipping send`
      : status === "void"
        ? `Invoice ${task.invoice_id} was voided — skipping send`
        : `Invoice ${task.invoice_id} was marked uncollectible — skipping send`;
  logSend(db, task.id, "skipped", skipMsg);

  // Only the paid case also logs a simulated "thank you" note for the
  // pipeline log (voided/uncollectible debts were not paid).
  if (status === "paid") {
    const thankYouMsg = [
      `[THANK YOU NOTE] Would send to ${custName}:`,
      `  Subject: Thanks for your payment — ${invId}`,
      `  Body: Hi ${custName}, just wanted to say thanks for taking care of invoice ${invId}. We appreciate your prompt payment!`,
    ].join("\n");
    logSend(db, task.id, "success", thankYouMsg, "reminder");
  }

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
