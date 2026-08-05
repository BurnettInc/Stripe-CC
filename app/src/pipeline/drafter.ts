import type { Invoice, ReminderTask } from "../db";
import { getStageSubjectPrefix } from "./escalation";

export interface EmailDraft {
  subject: string;
  body: string;
}

const SIGN_OFFS = ["Thanks!", "Best,", "Regards,", "Cheers,", "All the best,"];

function pickSignOff(stage: number): string {
  return SIGN_OFFS[(stage - 1) % SIGN_OFFS.length];
}

/**
 * Generate an email draft for a reminder task.
 * Templates are stage-appropriate: friendly nudge → direct follow-up → firm final notice.
 * Includes the customer's actual name and optionally the merchant's business name.
 */
export function draftEmail(
  task: ReminderTask,
  invoice: Invoice,
  merchantName?: string,
): EmailDraft {
  const daysOverdue = Math.floor(
    (Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24),
  );

  const amountStr = `$${(invoice.amount_cents / 100).toFixed(2)}`;
  const prefix = getStageSubjectPrefix(task.stage);
  const paymentLink = `https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`;
  const name = invoice.customer_name && invoice.customer_name !== "Customer"
    ? invoice.customer_name
    : "there";
  const signOff = pickSignOff(task.stage);
  const sigLine = merchantName ? `${signOff}\n${merchantName}` : signOff;

  let body: string;

  switch (task.stage) {
    case 1:
      body = [
        `Hey ${name} — just a quick nudge that invoice #${invoice.stripe_invoice_id} for ${amountStr} was due on ${invoice.due_date}.`,
        "",
        `No worries if it's already on the way — here's the link if you need it:`,
        paymentLink,
        "",
        sigLine,
      ].join("\n");
      break;

    case 2:
      body = [
        `Hi ${name},`,
        "",
        `Following up on invoice #${invoice.stripe_invoice_id} (${amountStr}, due ${invoice.due_date}). It's now ${daysOverdue} days past due — is there anything blocking payment on your end? Happy to help if so.`,
        "",
        `Here's the payment link: ${paymentLink}`,
        "",
        sigLine,
      ].join("\n");
      break;

    case 3:
      body = [
        `Hi ${name},`,
        "",
        `Invoice #${invoice.stripe_invoice_id} for ${amountStr} has been outstanding since ${invoice.due_date} (${daysOverdue} days). This is our final notice before we flag it for further follow-up.`,
        "",
        `Please settle at your earliest convenience: ${paymentLink}`,
        "",
        sigLine,
      ].join("\n");
      break;

    default:
      body = [
        `Hi ${name},`,
        "",
        `This is a reminder about invoice #${invoice.stripe_invoice_id} for ${amountStr}, due on ${invoice.due_date}.`,
        "",
        `You can view and pay the invoice here: ${paymentLink}`,
        "",
        signOff,
      ].join("\n");
  }

  return {
    subject: `${prefix}: Invoice #${invoice.stripe_invoice_id}`,
    body,
  };
}
