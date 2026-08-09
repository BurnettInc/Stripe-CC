import type { Database } from "bun:sqlite";
import { getCustomerHistory, getDb, type Invoice, type ReminderTask } from "../db";
import { getStageSubjectPrefix } from "./escalation";

export interface EmailDraft { subject: string; body: string; }

const SIGN_OFFS = ["Thanks!", "Best,", "Regards,", "Cheers,", "All the best,"];
function pickSignOff(stage: number): string { return SIGN_OFFS[(stage - 1) % SIGN_OFFS.length]; }

function fallback(task: ReminderTask, invoice: Invoice, merchantName?: string): EmailDraft {
  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const amount = `$${(invoice.amount_cents / 100).toFixed(2)}`;
  const link = `https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`;
  const name = invoice.customer_name && invoice.customer_name !== "Customer" ? invoice.customer_name : "there";
  const sign = merchantName ? `${pickSignOff(task.stage)}\n${merchantName}` : pickSignOff(task.stage);
  let body: string;
  if (task.stage === 1) body = `Hey ${name} — just a quick nudge that invoice #${invoice.stripe_invoice_id} for ${amount} was due on ${invoice.due_date}.\n\nNo worries if it's already on the way — here's the link if you need it:\n${link}\n\n${sign}`;
  else if (task.stage === 2) body = `Hi ${name},\n\nFollowing up on invoice #${invoice.stripe_invoice_id} (${amount}, due ${invoice.due_date}). It's now ${days} days past due — is there anything blocking payment on your end? Happy to help if so.\n\nHere's the payment link: ${link}\n\n${sign}`;
  else if (task.stage === 3) body = `Hi ${name},\n\nInvoice #${invoice.stripe_invoice_id} for ${amount} has been outstanding since ${invoice.due_date} (${days} days). This is our final notice before we flag it for further follow-up.\n\nPlease settle at your earliest convenience: ${link}\n\n${sign}`;
  else body = `Hi ${name},\n\nThis is a reminder about invoice #${invoice.stripe_invoice_id} for ${amount}, due on ${invoice.due_date}.\n\nYou can view and pay the invoice here: ${link}\n\n${sign}`;
  return { subject: `${getStageSubjectPrefix(task.stage)}: Invoice #${invoice.stripe_invoice_id}`, body };
}

const SYSTEM_TEMPLATE = `You are writing an invoice reminder email on behalf of {sender_business_name}.
Your job: get the invoice paid while preserving the relationship. Never sound
robotic, threatening, or desperate. Match the tone to the escalation stage.

CONTEXT:
- Customer name: {customer_name}
- Invoice amount: {amount} {currency}
- Invoice number: {invoice_number}
- Days overdue: {days_overdue}
- Escalation stage: {stage}
- Customer relationship length: {relationship_length}
- Customer payment history: {payment_history_summary}
- Typical invoice size for this customer: {typical_amount}
- This invoice vs typical: {amount_delta}
- Prior reminders sent for this invoice: {prior_reminder_count}
- Prior reminder tone used: {prior_tones}
- Hosted payment link: {payment_link}

RULES:
1. If payment_history shows this customer almost always pays promptly, treat
   this as likely an oversight — no firmness, just a friendly nudge, even at
   later stages.
2. If payment_history shows chronic lateness, escalate tone faster than the
   default stage would suggest, but stay professional — no personal blame.
3. If this invoice is significantly larger than their typical amount,
   acknowledge that gently ("I know this one's a bigger invoice than usual...")
   — larger invoices often stall for cash-flow reasons, not neglect.
4. Never repeat phrasing from prior_tones — each email in the sequence must
   read as a distinct, natural follow-up, not a copy-paste with an angrier
   subject line.
5. Always include the payment link with a clear, single call to action.
6. Final-notice stage may state a clear, factual consequence (e.g. late fee,
   pause in service) if configured — but never use guilt or hostility.
7. Output ONLY the email body and subject line, no preamble.
8. Never include an unsubscribe link in your output — the system adds a
   standard compliance footer automatically.

OUTPUT FORMAT (JSON):
{
  "subject": "...",
  "body": "..."
}`;

/** Draft asynchronously with an OpenAI-compatible endpoint; templates remain the safe fallback. */
export async function draftEmail(task: ReminderTask, invoice: Invoice, merchantName?: string, database?: Database): Promise<EmailDraft> {
  const fallbackDraft = fallback(task, invoice, merchantName);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackDraft;
  const db = database ?? getDb();
  const prior = db.query("SELECT draft_subject FROM reminder_tasks WHERE invoice_id=? AND id<>? AND draft_subject<>'' ORDER BY created_at").all(invoice.id, task.id) as Array<{ draft_subject: string }>;
  const history = getCustomerHistory(db, invoice.merchant_id, invoice.customer_name, invoice.customer_email, invoice.id, invoice.amount_cents);
  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const amount = (invoice.amount_cents / 100).toFixed(2);
  const paymentLink = `https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`;
  const values: Record<string, string> = {
    sender_business_name: merchantName || "the business", customer_name: invoice.customer_name, amount, currency: invoice.currency.toUpperCase(),
    invoice_number: invoice.stripe_invoice_id, days_overdue: String(days), stage: String(task.stage), ...history,
    prior_reminder_count: String(prior.length), prior_tones: prior.map(p => p.draft_subject).join("; ") || "none", payment_link: paymentLink,
  };
  const system = SYSTEM_TEMPLATE.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
  try {
    const response = await fetch(`${process.env.LLM_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.LLM_MODEL || "gpt-4o-mini", messages: [{ role: "system", content: system }], temperature: 0.7 }),
    });
    if (!response.ok) return fallbackDraft;
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (typeof parsed.subject !== "string" || typeof parsed.body !== "string" || !parsed.subject || !parsed.body) return fallbackDraft;
    return { subject: parsed.subject, body: parsed.body };
  } catch { return fallbackDraft; }
}
