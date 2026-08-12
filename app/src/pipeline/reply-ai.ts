/**
 * Reply-pause D1b — AI classification + reply drafting + conditional send
 * (owner spec 2026-08-12, items 4–7). Builds on D1a (PR #57): the inbound
 * webhook stores an inbound_replies row with reply_status 'captured' and
 * pauses the invoice; this module turns that row into a handled thread.
 *
 * Pipeline (run inline from the inbound webhook, and testable directly):
 *
 *   captured ──processReplyAI──▶ classified + drafted
 *                                  │
 *                                  ├─ question + confidence≥0.8 + Full Auto
 *                                  │      → auto-send reply → reply_status
 *                                  │        'auto_sent' + handled_at, owner
 *                                  │        gets a "Sent automatically." copy
 *                                  ├─ opt_out → reply_opt_out_at set
 *                                  │      (per-invoice ONLY), tasks cancelled,
 *                                  │      scoped confirmation sent to the
 *                                  │      customer, reply 'handled'
 *                                  └─ everything else (payment_claim,
 *                                       dispute, other, low confidence,
 *                                       non-full trust modes) → 'pending_approval'
 *                                       held for the merchant's one-click
 *                                       approve/edit/reject (POST /replies/...)
 *
 * ── HARD RULE (owner spec item 6, NOT configurable) ──
 * payment_claim and dispute NEVER auto-send — regardless of Trust Mode or
 * confidence. The guard lives in decideReplySendPolicy() AND is re-checked in
 * processReplyAI() immediately before any send (defense-in-depth). Any
 * future caller of the send path must keep this invariant.
 *
 * ── Test seam ──
 * Tests run WITHOUT a real OpenAI key (the run-suite strips it). Without the
 * key, classifyAndDraftReply() falls back to classification 'other',
 * confidence 0 and a template draft — the safe default that holds everything
 * for approval. The suite exercises every decision branch deterministically
 * via REPLY_AI_MOCK_CLASSIFICATION ("question:0.95"), read at call time — a
 * module-boundary mock that never touches the network. Documented as
 * test-only; production never sets it.
 */

import type { Database } from "bun:sqlite";
import { getInvoiceById, getMerchantById, logSend, isUnsubscribed, cancelTasksForInvoice } from "../db";
import type { Invoice } from "../db";
import { appendCanspamFooter } from "./canspam";
import { sendEmailForReal } from "./sender";
import { notifyMerchant, isPlaceholderMerchant } from "./notify";
import type { EmailDraft } from "./drafter";

export const HIGH_CONFIDENCE_THRESHOLD = 0.8;

export const REPLY_CLASSIFICATIONS = ["payment_claim", "dispute", "question", "opt_out", "other"] as const;
export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number];

export interface InboundReplyRow {
  id: number;
  merchant_id: number;
  invoice_id: number;
  sequence_key: string;
  received_at: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body: string;
  raw_message: string | null;
  idempotency_key: string;
  classification: string | null;
  confidence: number | null;
  draft_reply_subject: string | null;
  draft_reply_body: string | null;
  reply_status: string;
  handled_at: string | null;
  created_at: string;
}

export interface ClassifiedReply {
  classification: ReplyClassification;
  /** 0..1 — the model's stated confidence in the classification. */
  confidence: number;
  subject: string | null;
  body: string | null;
}

/** Action decided for a captured reply by the conditional-send rules. */
export interface ReplyDecision {
  action: "auto_send" | "hold" | "opt_out";
  reason: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function getReplyById(db: Database, id: number): InboundReplyRow | null {
  return db.query("SELECT * FROM inbound_replies WHERE id = ?").get(id) as InboundReplyRow | null;
}

/** The tracked reply address for an invoice (same derivation as sender.ts). */
function trackedReplyToForInvoice(invoiceId: number): string {
  const domain = process.env.REPLY_DOMAIN || "replies.getcollectionscopilot.com";
  return `reply+${invoiceId}@${domain}`;
}

/** Effective Trust Mode for an invoice: per-invoice override wins, else merchant default. */
function effectiveTrustMode(db: Database, invoice: Invoice): string {
  const merchant = getMerchantById(db, invoice.merchant_id);
  return invoice.trust_mode_override ?? merchant?.trust_mode ?? "draft";
}

/**
 * The conditional-send decision (owner spec item 6), kept pure so the test
 * suite can assert every branch without a server.
 *
 * Order of checks matters:
 *   1. payment_claim / dispute → hold ALWAYS (hard rule, see module doc).
 *   2. opt_out → opt-out handling (customer's explicit request wins even if
 *      the invoice later paid — honoring it is harmless and unambiguous).
 *   3. anything that isn't a confident question → hold.
 *   4. question + high confidence + Full Auto + not-stopped invoice → auto-send.
 */
export function decideReplySendPolicy(
  classification: ReplyClassification,
  confidence: number,
  trustMode: string,
  invoice: Pick<Invoice, "status" | "dispute_id" | "refund_id" | "reply_opt_out_at"> | null,
): ReplyDecision {
  // ── HARD RULE: payment_claim / dispute NEVER auto-send ──
  // Not configurable in any Trust Mode. A payment claim needs verification
  // against Stripe; a dispute is a legal-ish escalation. Only a human
  // merchant decides how to answer these.
  if (classification === "payment_claim" || classification === "dispute") {
    return { action: "hold", reason: `hard rule: ${classification} never auto-sends — held for owner approval` };
  }
  if (classification === "opt_out") {
    return { action: "opt_out", reason: "customer asked to stop reminders for this invoice" };
  }
  if (classification !== "question") {
    return { action: "hold", reason: `${classification || "other"} — held for owner approval` };
  }
  if (typeof confidence !== "number" || confidence < HIGH_CONFIDENCE_THRESHOLD) {
    return { action: "hold", reason: "low classification confidence — held for owner approval" };
  }
  if (trustMode !== "full") {
    return { action: "hold", reason: `trust mode '${trustMode}' — auto-send requires Full Auto` };
  }
  // Stopped-invoice guard: never auto-send a reply when the invoice has since
  // been paid / disputed / refunded, or the customer already opted out.
  if (invoice && (invoice.status === "paid" || invoice.dispute_id || invoice.refund_id || invoice.reply_opt_out_at)) {
    return { action: "hold", reason: "invoice stopped (paid/disputed/refunded/opt-out) — held for owner approval" };
  }
  return { action: "auto_send", reason: "question + high confidence + Full Auto" };
}

// ── Template fallback (no OPENAI_API_KEY, or the model misbehaves) ──

function templateReplyDraft(reply: InboundReplyRow, invoice: Invoice): { subject: string; body: string } {
  const amount = (invoice.amount_cents / 100).toFixed(2);
  const name = invoice.customer_name && invoice.customer_name !== "Customer" ? invoice.customer_name : "there";
  return {
    subject: `Re: your message about invoice #${invoice.stripe_invoice_id}`,
    body:
      `Hi ${name},\n\n` +
      `Thanks for your message about invoice #${invoice.stripe_invoice_id} (${amount}, due ${invoice.due_date}).\n\n` +
      `We're looking into it and will get back to you shortly.\n\nBest,`,
  };
}

/** Safe fallback: classification 'other', confidence 0 → always held. */
function fallbackClassified(reply: InboundReplyRow, invoice: Invoice): ClassifiedReply {
  const t = templateReplyDraft(reply, invoice);
  return { classification: "other", confidence: 0, subject: t.subject, body: t.body };
}

// ── The OpenAI call (mirrors drafter.ts's approach: gpt-4o-mini, JSON output) ──

const SYSTEM_TEMPLATE = `You are the collections assistant for {sender_business_name}, replying to a customer's email about an overdue invoice. Keep the same warm, human, relationship-aware tone as the reminder emails — never robotic, never threatening.

Classify the customer's reply into EXACTLY ONE category:
- payment_claim: the customer says they already paid (or a payment is in flight) and is pushing back on the reminder
- dispute: the customer disputes the invoice or charge (amount, services, fraud, unauthorized charge, etc.)
- question: the customer asks a question or requests information (breakdown, due date, payment link, balance, etc.)
- opt_out: the customer asks to stop receiving reminders about this invoice (or says stop emailing them)
- other: anything else, ambiguous, or unclear

Then draft a short, natural reply appropriate to that classification:
- payment_claim: thank them, apologize for the crossed wires, ask them to confirm the payment date or reference if available.
- dispute: acknowledge their concern without admitting fault, offer to sort it out, and say someone will follow up personally.
- question: answer concisely when the context below lets you; otherwise say you're checking and will follow up.
- opt_out: confirm that no further reminders will be sent about THIS invoice (scoped, never a generic "you're unsubscribed from everything").
- other: acknowledge the message and say the team will follow up.

CONTEXT:
- Customer name: {customer_name}
- Invoice amount: {amount} {currency}
- Invoice number: {invoice_number}
- Invoice due date: {due_date}
- Days overdue: {days_overdue}
- Escalation stage: {stage}
- Hosted payment link: {payment_link}
- Original customer reply:
---BEGIN REPLY---
{original_reply}
---END REPLY---

RULES:
1. Output ONLY valid JSON, no preamble: {"classification": "one_of_the_five", "confidence": 0.0-1.0, "subject": "...", "body": "..."}
2. confidence = how sure you are of the classification (0.0-1.0).
3. Subject should normally start with "Re:" and be short.
4. The body must NOT include an unsubscribe link or compliance footer — the system adds those.
5. Never invent facts about payments, refunds, or fees that the context does not support.
6. Keep the body under ~150 words.`;

interface ReplyAiValues extends Record<string, string> {
  sender_business_name: string;
  customer_name: string;
  amount: string;
  currency: string;
  invoice_number: string;
  due_date: string;
  days_overdue: string;
  stage: string;
  payment_link: string;
  original_reply: string;
}

/**
 * Classify a captured reply and draft a response for it.
 *
 * Returns the safe fallback ('other', 0, template draft) whenever the OpenAI
 * key is absent, the call fails, times out, or the model's JSON is unusable —
 * the webhook must never fail because the AI layer did.
 */
export async function classifyAndDraftReply(
  db: Database,
  reply: InboundReplyRow,
  invoice: Invoice,
): Promise<ClassifiedReply> {
  // ── Test seam (documented test-only; see module doc) ──
  // Format "classification:confidence", e.g. "question:0.95". Uses the
  // template draft so approve/edit flows have a real draft to work with.
  const mock = process.env.REPLY_AI_MOCK_CLASSIFICATION;
  if (mock && mock.includes(":")) {
    const [cls, confStr] = mock.split(":");
    const confidence = Number.parseFloat(confStr);
    const classification = (REPLY_CLASSIFICATIONS as readonly string[]).includes(cls)
      ? (cls as ReplyClassification)
      : "other";
    const t = templateReplyDraft(reply, invoice);
    return { classification, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0, subject: t.subject, body: t.body };
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackClassified(reply, invoice);

  const days = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const merchant = getMerchantById(db, invoice.merchant_id);
  const values: ReplyAiValues = {
    sender_business_name: merchant?.email || "the business",
    customer_name: invoice.customer_name,
    amount: (invoice.amount_cents / 100).toFixed(2),
    currency: invoice.currency.toUpperCase(),
    invoice_number: invoice.stripe_invoice_id,
    due_date: invoice.due_date,
    days_overdue: String(days),
    stage: "1",
    payment_link: `https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}`,
    original_reply: `${reply.from_name ? reply.from_name + " <" + reply.from_email + ">" : reply.from_email}\n` +
      (reply.subject ? `Subject: ${reply.subject}\n` : "") +
      `\n${reply.body || ""}`.trim(),
  };
  const system = SYSTEM_TEMPLATE.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${process.env.LLM_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "gpt-4o-mini",
        messages: [{ role: "system", content: system }],
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return fallbackClassified(reply, invoice);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const cls = String(parsed.classification ?? "").trim() as string;
    const classification = (REPLY_CLASSIFICATIONS as readonly string[]).includes(cls) ? (cls as ReplyClassification) : "other";
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0;
    const subject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim().slice(0, 500) : null;
    const body = typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim().slice(0, 10000) : null;
    if (!body) return fallbackClassified(reply, invoice); // unusable draft → safe hold
    return { classification, confidence, subject: subject ?? `Re: your message about invoice #${invoice.stripe_invoice_id}`, body };
  } catch {
    return fallbackClassified(reply, invoice);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Sends ──

interface SendOutcome {
  sent: boolean;
  reason: string;
}

/**
 * Send a reply draft to the CUSTOMER through the real pipeline path, with the
 * reply-specific guards the task-based guards in sender.ts cannot cover (the
 * reply send has no reminder task):
 *   - CAN-SPAM footer appended scoped to the reply's merchant + customer;
 *   - tracked Reply-To reply+{invoice}@{REPLY_DOMAIN} so the customer's next
 *     reply routes back into the inbound pipeline;
 *   - merchant sender branding (sender_name) like the reminder emails;
 *   - global unsubscribe table honored (never email an opted-out customer);
 *   - stopped-invoice guard (paid/disputed/refunded/opt-out) — the decision
 *     layer already holds these, but the send path re-checks so no future
 *     caller can bypass it;
 *   - send_logs row (type 'reply_send') so the flow is auditable.
 * Returns {sent:false} with a reason instead of throwing — the caller decides
 * whether to hold.
 */
async function sendReplyToCustomer(
  db: Database,
  invoice: Invoice,
  draft: EmailDraft,
  opts: { logType?: string; checkStopped?: boolean } = {},
): Promise<SendOutcome> {
  const customerEmail = invoice.customer_email || "";
  if (!customerEmail) return { sent: false, reason: "invoice has no customer email" };
  if (isUnsubscribed(db, invoice.merchant_id, customerEmail)) {
    return { sent: false, reason: "customer has opted out of all reminders (unsubscribes table)" };
  }
  if (opts.checkStopped !== false) {
    const invoiceNow = getInvoiceById(db, invoice.id);
    if (invoiceNow && (invoiceNow.status === "paid" || invoiceNow.dispute_id || invoiceNow.refund_id || invoiceNow.reply_opt_out_at)) {
      return { sent: false, reason: "invoice stopped (paid/disputed/refunded/opt-out)" };
    }
  }

  const merchant = getMerchantById(db, invoice.merchant_id) as
    | (import("../db").Merchant & { sender_name: string | null })
    | null;
  const body = appendCanspamFooter(draft.body, invoice.merchant_id, customerEmail);
  const result = await sendEmailForReal(db, null, { subject: draft.subject, body }, customerEmail, undefined, {
    skipCanspam: true, // footer already appended above, scoped to the real merchant
    replyTo: trackedReplyToForInvoice(invoice.id),
    senderName: merchant?.sender_name ?? null,
  });

  const status = result.success ? "success" : "failed";
  // Body preview in the log keeps the send auditable and lets tests assert on
  // the exact copy that went out (e.g. the scoped opt-out confirmation).
  const preview = draft.body.replace(/\s+/g, " ").trim().slice(0, 160);
  logSend(db, 0, status, `Reply sent to ${customerEmail} (${opts.logType ?? "reply"}): ${result.message} | body: ${preview}`, opts.logType ?? "reply_send");
  return result.success
    ? { sent: true, reason: result.message }
    : { sent: false, reason: `send failed: ${result.message}` };
}

/**
 * Owner copy for an AUTO-SENT reply (owner spec item 7): the original customer
 * reply plus the AI response, marked "Sent automatically." The original reply
 * was already forwarded at capture (D1a) — this copy adds the auto-sent
 * response so the owner sees both sides of the exchange. Best-effort: never
 * throws; placeholder merchants are skipped (same guard as forwardReply).
 */
async function sendOwnerAutoSendCopy(
  db: Database,
  invoice: Invoice,
  reply: InboundReplyRow,
  sentDraft: EmailDraft,
): Promise<void> {
  const merchant = getMerchantById(db, invoice.merchant_id) as (import("../db").Merchant & { reply_to: string | null }) | null;
  const configured = (merchant?.reply_to || "").trim();
  const target = configured || merchant?.email || "";
  if (!target) {
    console.log(`[reply-ai] no owner target for invoice ${invoice.stripe_invoice_id} — skipping auto-send copy`);
    return;
  }
  if (!configured && merchant && isPlaceholderMerchant(merchant)) {
    console.log(`[reply-ai] merchant ${invoice.merchant_id} has no real inbox — skipping auto-send copy`);
    return;
  }

  const fromLabel = reply.from_name ? `${reply.from_name} <${reply.from_email}>` : reply.from_email;
  const body =
    `${invoice.customer_name} replied to invoice #${invoice.stripe_invoice_id}, and the AI drafted and sent the response below automatically (Full Auto mode). ` +
    `Sent automatically — no action needed unless you want to follow up.\n\n` +
    `— — —\n` +
    `Original customer reply\n` +
    `From: ${fromLabel}\n` +
    (reply.subject ? `Subject: ${reply.subject}\n` : "") +
    `\n${(reply.body || "").trimEnd()}\n\n` +
    `— — —\n` +
    `Auto-sent response (marked "Sent automatically.")\n` +
    `Subject: ${sentDraft.subject}\n\n${sentDraft.body}`;

  try {
    const result = await sendEmailForReal(db, null, { subject: `Sent automatically — reply about invoice #${invoice.stripe_invoice_id}`, body }, target, undefined, {
      skipCanspam: true,
    });
    logSend(
      db,
      0,
      result.success ? "success" : "failed",
      `Owner copy (auto-sent reply) to ${target}: ${result.message}`,
      "reply_owner_copy",
    );
    console.log(`[reply-ai] owner auto-send copy sent to ${target} (${result.provider || "stub"})`);
  } catch (err: unknown) {
    logSend(db, 0, "failed", `Owner auto-send copy error: ${err instanceof Error ? err.message : String(err)}`, "reply_owner_copy");
    console.warn(`[reply-ai] owner auto-send copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Opt-out handling (owner spec item 6) ──

export const OPT_OUT_CONFIRMATION_SUBJECT = (invoiceId: string) => `Re: your request about invoice #${invoiceId}`;

/**
 * The scoped opt-out confirmation body. Deliberately per-invoice language:
 * "You won't receive further reminders about invoice #X." — NEVER a generic
 * "you're unsubscribed" (owner spec: explicitly scoped).
 */
export function optOutConfirmationBody(invoice: Invoice): string {
  const name = invoice.customer_name && invoice.customer_name !== "Customer" ? invoice.customer_name : "there";
  return (
    `Hi ${name},\n\n` +
    `You won't receive further reminders about invoice #${invoice.stripe_invoice_id}.\n\n` +
    `Thanks for letting us know — if anything changes, we're here to help.\n\nBest,`
  );
}

/**
 * opt_out classification (owner spec item 6):
 *   - set invoices.reply_opt_out_at (per-invoice ONLY — never the account-wide
 *     unsubscribes table, never the merchants row);
 *   - cancel any reminder tasks for the invoice (the pause already cancelled
 *     them at capture; this is defense-in-depth);
 *   - send the scoped confirmation to the customer;
 *   - mark the reply 'handled' + handled_at;
 *   - notify the owner.
 */
async function handleOptOut(
  db: Database,
  reply: InboundReplyRow,
  invoice: Invoice,
): Promise<void> {
  const now = new Date().toISOString();
  // Preserve the first opt-out timestamp (idempotent when a second opt_out
  // reply arrives for the same invoice).
  db.run("UPDATE invoices SET reply_opt_out_at=COALESCE(reply_opt_out_at, ?) WHERE id=?", [now, invoice.id]);
  cancelTasksForInvoice(db, invoice.id);

  const confirmation: EmailDraft = {
    subject: OPT_OUT_CONFIRMATION_SUBJECT(invoice.stripe_invoice_id),
    body: optOutConfirmationBody(invoice),
  };
  // checkStopped:false — the opt-out flag was JUST set on this invoice; the
  // scoped confirmation is the whole point of this branch (the customer's own
  // request), not a reminder that the stopped-invoice guard should suppress.
  const sent = await sendReplyToCustomer(db, invoice, confirmation, { logType: "reply_optout", checkStopped: false });

  db.run("UPDATE inbound_replies SET reply_status='handled', handled_at=? WHERE id=?", [now, reply.id]);
  logSend(db, 0, sent.sent ? "success" : "failed", `Opt-out handled for invoice ${invoice.stripe_invoice_id}: ${sent.reason}`, "reply_optout");

  try {
    await notifyMerchant(
      db,
      invoice.merchant_id,
      `Customer opted out of reminders — invoice #${invoice.stripe_invoice_id}`,
      `${invoice.customer_name} asked to stop receiving reminders about invoice #${invoice.stripe_invoice_id}. ` +
      `This stops reminders for this invoice only (per-invoice opt-out); the sequence stays stopped until you resume it.`,
    );
  } catch (err: unknown) {
    console.warn(`[reply-ai] opt-out merchant notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── The processing hook ──

export interface ReplyProcessingOutcome {
  status: string;
  classification: string;
  confidence: number;
  action: "auto_send" | "hold" | "opt_out" | "noop";
  reason: string;
}

/**
 * Process one captured reply: classify → draft → apply conditional-send rules
 * → persist → auto-send / opt-out / hold. Called inline by the inbound webhook
 * right after the reply is stored (volume is human-scale; inline keeps the
 * outcome deterministic). Idempotent: rows not in 'captured' state are a no-op,
 * so webhook retries and duplicate deliveries can never double-process.
 */
export async function processReplyAI(db: Database, replyId: number): Promise<ReplyProcessingOutcome | null> {
  const reply = getReplyById(db, replyId);
  if (!reply || reply.reply_status !== "captured") return null;
  const invoice = getInvoiceById(db, reply.invoice_id);
  if (!invoice) {
    // Invoice vanished (shouldn't happen — FK) — safe hold, no crash.
    db.run("UPDATE inbound_replies SET classification='other', confidence=0, reply_status='pending_approval' WHERE id=?", [replyId]);
    return { status: "pending_approval", classification: "other", confidence: 0, action: "hold", reason: "invoice missing" };
  }

  let classified: ClassifiedReply;
  try {
    classified = await classifyAndDraftReply(db, reply, invoice);
  } catch (err: unknown) {
    console.warn(`[reply-ai] classification failed for reply ${replyId}: ${err instanceof Error ? err.message : String(err)} — safe hold`);
    classified = fallbackClassified(reply, invoice);
  }

  db.run(
    "UPDATE inbound_replies SET classification=?, confidence=?, draft_reply_subject=?, draft_reply_body=? WHERE id=?",
    [classified.classification, classified.confidence, classified.subject, classified.body, replyId],
  );

  const trustMode = effectiveTrustMode(db, invoice);
  const decision = decideReplySendPolicy(classified.classification, classified.confidence, trustMode, invoice);
  const now = new Date().toISOString();

  if (decision.action === "opt_out") {
    await handleOptOut(db, reply, invoice);
    return { status: "handled", classification: classified.classification, confidence: classified.confidence, action: "opt_out", reason: decision.reason };
  }

  if (decision.action === "auto_send") {
    // ── HARD RULE re-check (defense-in-depth): the decision layer already
    // guarantees payment_claim/dispute never reach here, but the send path
    // never trusts a single check. Holding is the only allowed response.
    if (classified.classification === "payment_claim" || classified.classification === "dispute") {
      db.run("UPDATE inbound_replies SET reply_status='pending_approval' WHERE id=?", [replyId]);
      return { status: "pending_approval", classification: classified.classification, confidence: classified.confidence, action: "hold", reason: "hard rule: never auto-send payment_claim/dispute" };
    }
    const draft: EmailDraft = {
      subject: classified.subject ?? `Re: your message about invoice #${invoice.stripe_invoice_id}`,
      body: classified.body ?? "",
    };
    const sent = await sendReplyToCustomer(db, invoice, draft, { logType: "reply_send" });
    if (sent.sent) {
      await sendOwnerAutoSendCopy(db, invoice, reply, draft);
      db.run("UPDATE inbound_replies SET reply_status='auto_sent', handled_at=? WHERE id=?", [now, replyId]);
      console.log(`[reply-ai] reply ${replyId} auto-sent (${classified.classification}, confidence ${classified.confidence})`);
      return { status: "auto_sent", classification: classified.classification, confidence: classified.confidence, action: "auto_send", reason: sent.reason };
    }
    // Guarded/failed send → hold for the merchant instead of dropping it.
    console.warn(`[reply-ai] reply ${replyId} auto-send blocked (${sent.reason}) — held for approval`);
    db.run("UPDATE inbound_replies SET reply_status='pending_approval' WHERE id=?", [replyId]);
    return { status: "pending_approval", classification: classified.classification, confidence: classified.confidence, action: "hold", reason: sent.reason };
  }

  db.run("UPDATE inbound_replies SET reply_status='pending_approval' WHERE id=?", [replyId]);
  return { status: "pending_approval", classification: classified.classification, confidence: classified.confidence, action: "hold", reason: decision.reason };
}

export { JSON_HEADERS };
