import type { Database } from "bun:sqlite";
import { getCustomerHistory, getDb, invoiceNumberFor, paymentLinkFor, type Invoice, type ReminderTask } from "../db";
import { getStageSubjectPrefix } from "./escalation";
import { getLateFeeText } from "./late-fee";
// One definition of "unfilled placeholder" for both lines of defence: the
// drafter's safety net (below) and the reviewer's hard gate. `reviewer.ts`
// imports only the TYPE from this module, so this is not a runtime cycle.
import { unfilledPlaceholderIssue } from "./reviewer";

export interface EmailDraft { subject: string; body: string; }

const SIGN_OFFS = ["Thanks!", "Best,", "Regards,", "Cheers,", "All the best,"];
function pickSignOff(stage: number): string { return SIGN_OFFS[(stage - 1) % SIGN_OFFS.length]; }

/** Anything shaped like an email address (never a name, never a sign-off). */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A human name we can use in customer copy, or null when the value is unusable.
 *
 * Unusable means: empty/whitespace, Stripe's literal placeholder "Customer", or
 * an EMAIL ADDRESS. Production merchant 11 has `sender_name` NULL and the
 * template used to sign its customers' reminders with the merchant's email
 * address; the same guard keeps "Hi jenny@example.com," out of the greeting
 * when an invoice carries no real customer name (2026-11-06).
 */
export function usableName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  if (name.toLowerCase() === "customer") return null;
  if (EMAIL_LIKE.test(name)) return null;
  return name;
}

/**
 * Currency symbols we can safely render in front of a 2-decimal amount. A
 * currency that is not listed gets NO guessed symbol — it renders as
 * "27.00 SEK" (code after the amount) instead.
 *
 * Zero-decimal currencies (JPY, KRW, …) are deliberately absent: amount_cents
 * is the smallest currency unit, so this 2-decimal formatting is wrong for
 * them either way — a pre-existing limitation, not something a symbol fixes.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: "$", eur: "€", gbp: "£", cad: "CA$", aud: "A$", nzd: "NZ$",
};

/**
 * Render an invoice amount for customer copy: USD → "$27.00"; a currency we
 * have no symbol for → "27.00 SEK". Before this the template wrote a bare
 * "27.00" — an amount with no currency at all, which is exactly what every
 * customer received while AI drafting was off (found 2026-11-06).
 */
export function formatAmount(amountCents: number, currency: string | null | undefined): string {
  const amount = (amountCents / 100).toFixed(2);
  const code = (currency ?? "").trim();
  const symbol = CURRENCY_SYMBOLS[code.toLowerCase()];
  if (symbol) return `${symbol}${amount}`;
  return code ? `${amount} ${code.toUpperCase()}` : amount;
}

/**
 * Sign-off for template copy. `name` is the merchant's configured display name
 * (merchants.sender_name) — never their email address. With no usable name the
 * email ends on a neutral "Best regards," and no name line at all.
 */
function signOff(stage: number, name: string | null): string {
  return name ? `${pickSignOff(stage)}\n${name}` : "Best regards,";
}

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

function fallback(task: ReminderTask, invoice: Invoice, senderName?: string | null, lateFeeText?: string | null): EmailDraft {
  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const amount = formatAmount(invoice.amount_cents, invoice.currency);
  // Stripe's customer-facing hosted invoice page — the ONLY link a customer
  // may be sent. NULL means there is no page to send them to (draft/voided
  // invoice, or a row not re-synced yet): then the body carries NO link at
  // all. It must never fall back to dashboard.stripe.com/invoices/<id>, which
  // is the MERCHANT's own dashboard behind a login wall — every reminder ever
  // sent before 2026-11-06 carried that link and no customer could pay it.
  const link = paymentLinkFor(invoice);
  const name = usableName(invoice.customer_name);
  const sign = signOff(task.stage, usableName(senderName));
  const fee = lateFeeSentence(lateFeeText);
  // The number a CUSTOMER recognises: Stripe's invoice.number ("INV-0042").
  // Stripe's internal id (in_1UMHv…) used to be printed here and in every
  // subject line — the customer has never seen that token, and printing it
  // leaks an internal Stripe identifier into their inbox. With no number
  // (Stripe assigns it at finalization) the copy OMITS it entirely; it never
  // falls back to the id.
  const number = invoiceNumberFor(invoice);
  // Mid-sentence and sentence-initial forms. With no number the copy says
  // "your invoice" — never a bare "invoice" with a gap where the number was,
  // and never the internal id.
  const invoiceRef = number ? `invoice ${number}` : "your invoice";
  const invoiceRefCap = number ? `Invoice ${number}` : "Your invoice";
  let body: string;
  if (task.stage === 1) {
    // Named customer: unchanged stage-1 copy. No usable name (empty, "Customer"
    // or an email address): open with a plain "Hi there," and a new paragraph —
    // never address a customer by their email address.
    const opener = name
      ? `Hey ${name} — just a quick nudge`
      : `Hi there,\n\nJust a quick nudge`;
    body = `${opener} that ${invoiceRef} for ${amount} was due on ${invoice.due_date}.${link ? `\n\nNo worries if it's already on the way — here's the link if you need it:\n${link}` : ""}\n\n${sign}`;
  } else if (task.stage === 2) {
    const greet = name ? `Hi ${name},` : "Hi there,";
    body = `${greet}\n\nFollowing up on ${invoiceRef} (${amount}, due ${invoice.due_date}). It's now ${days} days past due — is there anything blocking payment on your end? Happy to help if so.${fee}${link ? `\n\nHere's the payment link: ${link}` : ""}\n\n${sign}`;
  } else if (task.stage === 3) {
    const greet = name ? `Hi ${name},` : "Hi there,";
    body = `${greet}\n\n${invoiceRefCap} for ${amount} has been outstanding since ${invoice.due_date} (${days} days). This is our final notice before we flag it for further follow-up.${fee}${link ? `\n\nPlease settle at your earliest convenience: ${link}` : ""}\n\n${sign}`;
  } else {
    const greet = name ? `Hi ${name},` : "Hi there,";
    body = `${greet}\n\nThis is a reminder about ${invoiceRef} for ${amount}, due on ${invoice.due_date}.${link ? `\n\nYou can view and pay the invoice here: ${link}` : ""}\n\n${sign}`;
  }
  // Subject: the customer's own invoice number, or — when Stripe has not
  // assigned one yet — no number at all. Never Stripe's internal id.
  const subject = number
    ? `${getStageSubjectPrefix(task.stage)}: Invoice ${number}`
    : `${getStageSubjectPrefix(task.stage)}: your overdue invoice`;
  return { subject, body };
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
5. Payment link: include the "Hosted payment link" from CONTEXT once, with a
   clear single call to action — that URL is the customer's own Stripe payment
   page and is the ONLY link you may ever write. When the Hosted payment link
   line says there is none, write NO payment link, NO URL of any kind and no
   "pay here" instruction: the email still works as a reminder. NEVER invent a
   link and NEVER write a dashboard.stripe.com URL — that is the merchant's own
   dashboard behind a login wall and the customer cannot pay through it.
6. Final-notice stage may state a clear, factual consequence (e.g. late fee,
   pause in service) if configured — but never use guilt or hostility.
7. Output ONLY the email body and subject line, no preamble.
8. Never include an unsubscribe link in your output — the system adds a
   standard compliance footer automatically.
9. Late fee — conditional, informational only. ONLY when the "Late fee" line in
   CONTEXT shows a dollar amount: mention it exactly once, softly, in the form
   "A late fee of $25.00 may apply per your payment terms." (substitute the exact
   amount from the Late fee line), and only at stage 2 or stage 3 — NEVER at
   stage 1. When the Late fee line shows "none" or says no late fee is
   configured, write NO late-fee sentence at all: never write "a late fee of
   none", never write a placeholder or invented amount, and never mention late
   fees, penalties or interest anywhere in the email. Never invent or change a
   fee amount, and never claim the fee has been added or charged.
10. Invoice number: when the "Invoice number" line in CONTEXT shows a real
    number (e.g. INV-0042), state it VERBATIM exactly once in the body — never
    reformat it and never invent one. When that line says there is none, write
    NO invoice number, invoice id or reference of any kind: an id like
    in_1AbC23 is an internal Stripe token the customer has never seen, so it
    must never appear in the email.
11. ALWAYS state the invoice due date in the body as the exact ISO date string
    {due_date} (format YYYY-MM-DD, e.g. 2026-08-11). Copy it character-for-
    character — never rewrite it as a month name ("August 11, 2026" is wrong,
    "2026-08-11" is required).
11. SIGN-OFF — the body MUST end with exactly the lines below, verbatim, and
    nothing after them:

{sign_off}

    Copy that sign-off character-for-character. Never add a name, job title,
    company name, phone number or contact block that is not in it.
12. NEVER write a placeholder. Bracketed tokens — "[Your Name]",
    "[Your Business Name]", "[Company]", "[Position]", "[Phone]", "[Email]",
    "[insert amount]" and anything else in square brackets — are prompt
    scaffolding, not copy. You do not know the sender's personal or business
    name, so never guess or invent one and never leave a blank for one: the
    sign-off above is already complete as written. A body containing any
    bracketed placeholder is discarded.

OUTPUT FORMAT (JSON):
{
  "subject": "...",
  "body": "..."
}`;

// ── Drafter health: is AI drafting actually on? ──
//
// Before this, a failed LLM call was swallowed (`if (!response.ok) return
// fallbackDraft;` and a bare try/catch), so the product emailed the plain
// template for an unknown length of time while looking perfectly healthy. On
// 2026-11-06 the OpenAI account behind OPENAI_API_KEY had no credits: every
// call returned HTTP 429 `insufficient_quota` and NOTHING said so.
//
// The record below is deliberately IN-PROCESS (no DB column, no new table, no
// extra network call, no cron): it is updated on the drafting hot path that
// already runs, and read by the existing token-gated GET /admin/data payload
// (`drafting`). `tracking_since` is the process start time, so a reader can
// tell "no failures since this restart" apart from "no failures ever" —
// `status: "unknown"` means no draft attempt has been recorded yet.

export interface DrafterFallback {
  /** ISO-8601 UTC timestamp of the failed attempt. */
  at: string;
  /** Short machine-ish cause: the provider's error code/type, or e.g. "request_failed". */
  reason: string;
  /** HTTP status of the failed call (null when there was no response). */
  http_status: number | null;
  /** Human-readable one-liner: "status=429 type=insufficient_quota code=credit_balance_exhausted". */
  detail: string;
}

export interface DrafterHealth {
  /** "ok" = last attempt used the model; "degraded" = last attempt used the template; "unknown" = no attempt recorded yet. */
  status: "ok" | "degraded" | "unknown";
  key_configured: boolean;
  tracking_since: string;
  last_success_at: string | null;
  last_fallback: DrafterFallback | null;
  successes_total: number;
  fallbacks_total: number;
  consecutive_fallbacks: number;
}

const trackingSince = new Date().toISOString();
const healthState: {
  lastOutcome: "ok" | "fallback" | null;
  lastSuccessAt: string | null;
  lastFallback: DrafterFallback | null;
  successes: number;
  fallbacks: number;
  consecutive: number;
} = { lastOutcome: null, lastSuccessAt: null, lastFallback: null, successes: 0, fallbacks: 0, consecutive: 0 };

/** Trim a provider token (error type/code) to something log-safe. */
function shortToken(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().replace(/\s+/g, "_").slice(0, 64);
}

/** One-line, truncated error text — never a body dump, never the API key. */
function shortMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Record ONE template fallback and log why it happened. Never throws — a
 * logging failure must never break drafting.
 */
function noteFallback(reason: string, detail: string, httpStatus: number | null = null): void {
  const entry: DrafterFallback = { at: new Date().toISOString(), reason, http_status: httpStatus, detail };
  healthState.lastOutcome = "fallback";
  healthState.lastFallback = entry;
  healthState.fallbacks++;
  healthState.consecutive++;
  try {
    console.warn(`[drafter] LLM unavailable — using template fallback: ${detail}`);
  } catch { /* logging must never throw */ }
}

function noteSuccess(): void {
  healthState.lastOutcome = "ok";
  healthState.lastSuccessAt = new Date().toISOString();
  healthState.successes++;
  healthState.consecutive = 0;
}

/** Current AI-drafting health, for the admin surface. Pure read, no I/O. */
export function drafterHealth(): DrafterHealth {
  const keyConfigured = Boolean(process.env.OPENAI_API_KEY);
  let status: DrafterHealth["status"] = "unknown";
  if (!keyConfigured) status = "degraded";
  else if (healthState.lastOutcome === "fallback") status = "degraded";
  else if (healthState.lastOutcome === "ok") status = "ok";
  return {
    status,
    key_configured: keyConfigured,
    tracking_since: trackingSince,
    last_success_at: healthState.lastSuccessAt,
    last_fallback: healthState.lastFallback,
    successes_total: healthState.successes,
    fallbacks_total: healthState.fallbacks,
    consecutive_fallbacks: healthState.consecutive,
  };
}

/** Test-only: forget everything recorded so far. */
export function resetDrafterHealth(): void {
  healthState.lastOutcome = null;
  healthState.lastSuccessAt = null;
  healthState.lastFallback = null;
  healthState.successes = 0;
  healthState.fallbacks = 0;
  healthState.consecutive = 0;
}

/**
 * The merchant's display name for customer copy, or null.
 *
 * `merchants.sender_name` is authoritative (it is what the From header uses
 * too). The `hint` argument exists for callers/tests that already know a name;
 * an email address is NEVER accepted as either, which is what put a merchant's
 * email address in the sign-off of every fallback reminder.
 */
function resolveSenderName(db: Database, merchantId: number, hint?: string | null): string | null {
  let configured: string | null = null;
  try {
    const row = db.query("SELECT sender_name FROM merchants WHERE id=?").get(merchantId) as { sender_name: string | null } | null;
    configured = usableName(row?.sender_name);
  } catch {
    configured = null; // no merchant row / closed DB: fall through to the hint
  }
  return configured ?? usableName(hint);
}

/**
 * Turn a non-2xx provider response into a log-safe reason + detail. Reads at
 * most the error envelope (`error.type` / `error.code`) — never the whole
 * body, never the request headers (the API key lives there).
 */
async function describeHttpFailure(response: Response): Promise<{ reason: string; detail: string }> {
  let type = "";
  let code = "";
  try {
    const raw = await response.text();
    const parsed = JSON.parse(raw) as { error?: { type?: unknown; code?: unknown } };
    type = shortToken(parsed?.error?.type);
    code = shortToken(parsed?.error?.code);
  } catch {
    // Non-JSON body (HTML gateway page, empty body): the status is the signal.
  }
  const parts = [`status=${response.status}`];
  if (type) parts.push(`type=${type}`);
  if (code) parts.push(`code=${code}`);
  return { reason: code || type || `http_${response.status}`, detail: parts.join(" ") };
}

/**
 * Draft asynchronously with an OpenAI-compatible endpoint; templates remain the
 * safe fallback. A failed call NEVER throws and NEVER blocks a reminder: it
 * returns the template draft and records/logs why (see drafterHealth).
 */
export async function draftEmail(task: ReminderTask, invoice: Invoice, senderNameHint?: string | null, database?: Database): Promise<EmailDraft> {
  const db = database ?? getDb();
  // Late fee (informational, Pro): the exact fragment the template must show
  // and the reviewer will verify. Null at stage 1 / when not configured.
  const lateFeeText = getLateFeeText(db, invoice.merchant_id, invoice, task.stage);
  const senderName = resolveSenderName(db, invoice.merchant_id, senderNameHint);
  const fallbackDraft = fallback(task, invoice, senderName, lateFeeText);
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    noteFallback("no_api_key", "reason=no_api_key (OPENAI_API_KEY is not set)");
    return fallbackDraft;
  }
  const prior = db.query("SELECT draft_subject FROM reminder_tasks WHERE invoice_id=? AND id<>? AND draft_subject<>'' ORDER BY created_at").all(invoice.id, task.id) as Array<{ draft_subject: string }>;
  const history = getCustomerHistory(db, invoice.merchant_id, invoice.customer_name, invoice.customer_email, invoice.id, invoice.amount_cents);
  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const amount = (invoice.amount_cents / 100).toFixed(2);
  const paymentLink = paymentLinkFor(invoice);
  const values: Record<string, string> = {
    sender_business_name: senderName || "the business", customer_name: invoice.customer_name, amount, currency: invoice.currency.toUpperCase(),
    // A real invoice number when Stripe has assigned one; otherwise an
    // INSTRUCTION (never the internal id, and not a bare "none" the model
    // would copy) so the model writes no number at all.
    invoice_number: invoiceNumberFor(invoice) ??
      "none (this invoice has no customer-facing number — do NOT mention any invoice number, invoice id or reference anywhere in this email)",
    due_date: invoice.due_date, days_overdue: String(days), stage: String(task.stage), ...history,
    prior_reminder_count: String(prior.length), prior_tones: prior.map(p => p.draft_subject).join("; ") || "none",
    // An empty instruction (not a bare "none") so the model never invents a
    // link or reaches for the merchant's dashboard URL when the invoice has no
    // hosted payment page.
    payment_link: paymentLink ?? "none (this invoice has no customer payment link — do NOT include any URL or link in this email)",
    // When no fee applies, the line must be an INSTRUCTION, not the bare word
    // "none": the model used to copy the literal placeholder into the body
    // ("A late fee of none may apply per your payment terms") — production
    // reminder_task 71, 2026-10-24. The reviewer gate rejects that string now
    // (reviewer.ts), and this wording stops the model producing it.
    late_fee: lateFeeText ?? "none (no late fee is configured — do NOT mention a late fee, penalty, interest, or any fee amount anywhere in this email)",
    // THE sign-off the model must end on, verbatim (rule 11). Before this the
    // prompt never said what to sign with, so with merchants.sender_name NULL
    // the model emitted the literal template scaffolding instead: production
    // invoice 356, 2026-11-10 — "Best regards,\n\n[Your Name]\n[Your Business
    // Name]" — and the reviewer approved it. Same string the template uses, so
    // AI and fallback copy sign identically.
    sign_off: signOff(task.stage, senderName),
  };
  const system = SYSTEM_TEMPLATE.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
  let response: Response;
  try {
    response = await fetch(`${process.env.LLM_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.LLM_MODEL || "gpt-4o-mini", messages: [{ role: "system", content: system }], temperature: 0.7 }),
    });
  } catch (error) {
    // Network/DNS/TLS failure: no response at all.
    noteFallback("request_failed", `reason=request_failed error=${shortMessage(error)}`);
    return fallbackDraft;
  }
  if (!response.ok) {
    // THE defect this change exists for: this branch used to `return
    // fallbackDraft` silently. Production, 2026-11-06 — HTTP 429
    // insufficient_quota, every reminder the plain template, nothing logged.
    const { reason, detail } = await describeHttpFailure(response);
    noteFallback(reason, detail, response.status);
    return fallbackDraft;
  }
  let parsed: { subject?: unknown; body?: unknown };
  try {
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() || "";
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { subject?: unknown; body?: unknown };
  } catch (error) {
    noteFallback("unparseable_response", `reason=unparseable_response error=${shortMessage(error)}`);
    return fallbackDraft;
  }
  if (typeof parsed.subject !== "string" || typeof parsed.body !== "string" || !parsed.subject || !parsed.body) {
    noteFallback("incomplete_draft", "reason=incomplete_draft (model returned no usable subject/body)");
    return fallbackDraft;
  }
  // Safety net: the model must never hand a customer the merchant's own
  // dashboard URL (login wall, unpayable). Drop such a draft and use the
  // template, which only ever emits the invoice's hosted payment page. The
  // reviewer's hard gate is the second line of defence.
  if (/dashboard\.stripe\.com/i.test(`${parsed.subject}\n${parsed.body}`)) {
    noteFallback("merchant_dashboard_link", "reason=merchant_dashboard_link (model wrote the merchant's own dashboard URL)");
    return fallbackDraft;
  }
  // Safety net: an email with an unfilled bracketed placeholder is unfinished
  // copy that must never reach a customer — production invoice 356, 2026-11-10
  // ("Best regards,\n\n[Your Name]\n[Your Business Name]"). The template is
  // complete by construction, so it is the correct substitute. The reviewer's
  // hard gate (reviewer.ts) is the second line of defence.
  const placeholder = unfilledPlaceholderIssue(`${parsed.subject}\n${parsed.body}`);
  if (placeholder) {
    noteFallback("unfilled_placeholder", `reason=unfilled_placeholder (${placeholder.slice(0, 120)})`);
    return fallbackDraft;
  }
  noteSuccess();
  return { subject: parsed.subject, body: parsed.body };
}
