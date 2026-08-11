import type { Database } from "bun:sqlite";
import { getCustomerHistory, getDb, type Invoice, type ReminderTask } from "../db";
import { getStageSubjectPrefix } from "./escalation";
import { getLateFeeText } from "./late-fee";

export interface EmailDraft { subject: string; body: string; }

const SIGN_OFFS = ["Thanks!", "Best,", "Regards,", "Cheers,", "All the best,"];
function pickSignOff(stage: number): string { return SIGN_OFFS[(stage - 1) % SIGN_OFFS.length]; }

/**
 * Soft, informational late-fee sentence appended to Stage 2 / Stage 3
 * template-fallback bodies when the merchant configured a fee. Never stage 1,
 * never invented by the model — the exact fee fragment comes from late-fee.ts
 * so the reviewer can verify it. Conditional by design: the pipeline never
 * adds or charges a fee (read-only Stripe), so the copy only says one MAY
 * apply per the merchant's payment terms — never an accomplished charge.
 */
function lateFeeSentence(feeText: string | null | undefined): string {
  return feeText ? `\n\nA late fee of ${feeText} may apply per your payment terms.` : "";
}

function fallback(task: ReminderTask, invoice: Invoice, merchantName?: string, lateFeeText?: string | null): EmailDraft {
  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const amount = `${(invoice.amount_cents / 100).toFixed(2)}`;
  const link = `https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`;
  const name = invoice.customer_name && invoice.customer_name !== "Customer" ? invoice.customer_name : "there";
  const sign = merchantName ? `${pickSignOff(task.stage)}\n${merchantName}` : pickSignOff(task.stage);
  const fee = lateFeeSentence(lateFeeText);
  let body: string;
  if (task.stage === 1) body = `Hey ${name} — just a quick nudge that invoice #${invoice.stripe_invoice_id} for ${amount} was due on ${invoice.due_date}.\n\nNo worries if it's already on the way — here's the link if you need it:\n${link}\n\n${sign}`;
  else if (task.stage === 2) body = `Hi ${name},\n\nFollowing up on invoice #${invoice.stripe_invoice_id} (${amount}, due ${invoice.due_date}). It's now ${days} days past due — is there anything blocking payment on your end? Happy to help if so.${fee}\n\nHere's the payment link: ${link}\n\n${sign}`;
  else if (task.stage === 3) body = `Hi ${name},\n\nInvoice #${invoice.stripe_invoice_id} for ${amount} has been outstanding since ${invoice.due_date} (${days} days). This is our final notice before we flag it for further follow-up.${fee}\n\nPlease settle at your earliest convenience: ${link}\n\n${sign}`;
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
- Invoice due date: {due_date} (include this EXACT date string, ISO format YYYY-MM-DD — e.g. 2026-08-11 — verbatim in the body; do NOT reformat it into words like "August 11, 2026")
- Days overdue: {days_overdue}
- Escalation stage: {stage}
- Customer relationship length: {relationship_length}
- Customer payment history: {payment_history_summary}
- Typical invoice size for this customer: {typical_amount}
- This invoice vs typical: {amount_delta}
- Prior reminders sent for this invoice: {prior_reminder_count}
- Prior reminder tone used: {prior_tones}
- Late fee: {late_fee}
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
9. If the late fee line is not 'none', mention it exactly once, softly, in the
   form: "A late fee of {late_fee} may apply per your payment terms." Only at
   stage 2 or stage 3 — NEVER at stage 1. Never invent or change a fee amount;
   use the exact value from the late fee line. Never claim the fee has been
   added or charged — it is conditional and informational only.
10. ALWAYS state the invoice due date in the body as the exact ISO date string
    {due_date} (format YYYY-MM-DD, e.g. 2026-08-11). Copy it character-for-
    character — never rewrite it as a month name ("August 11, 2026" is wrong,
    "2026-08-11" is required).

OUTPUT FORMAT (JSON):
{
  "subject": "...",
  "body": "..."
}`;

/** Draft asynchronously with an OpenAI-compatible endpoint; templates remain the safe fallback. */
export async function draftEmail(task: ReminderTask, invoice: Invoice, merchantName?: string, database?: Database): Promise<EmailDraft> {
  const db = database ?? getDb();
  // Late fee (informational, Pro): the exact fragment the template must show
  // and the reviewer will verify. Null at stage 1 / when not configured.
  const lateFeeText = getLateFeeText(db, invoice.merchant_id, invoice, task.stage);
  const fallbackDraft = fallback(task, invoice, merchantName, lateFeeText);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackDraft;
  const prior = db.query("SELECT draft_subject FROM reminder_tasks WHERE invoice_id=? AND id<>? AND draft_subject<>'' ORDER BY created_at").all(invoice.id, task.id) as Array<{ draft_subject: string }>;
  const history = getCustomerHistory(db, invoice.merchant_id, invoice.customer_name, invoice.customer_email, invoice.id, invoice.amount_cents);
  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const amount = (invoice.amount_cents / 100).toFixed(2);
  const paymentLink = `https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`;
  const values: Record<string, string> = {
    sender_business_name: merchantName || "the business", customer_name: invoice.customer_name, amount, currency: invoice.currency.toUpperCase(),
    invoice_number: invoice.stripe_invoice_id, due_date: invoice.due_date, days_overdue: String(days), stage: String(task.stage), ...history,
    prior_reminder_count: String(prior.length), prior_tones: prior.map(p => p.draft_subject).join("; ") || "none", payment_link: paymentLink,
    late_fee: lateFeeText ?? "none",
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
