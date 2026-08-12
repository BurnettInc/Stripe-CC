/**
 * Inbound reply webhook — reply-pause feature D1a (owner spec 2026-08-12).
 *
 * The Cloudflare Email Routing Worker (D3, not built here) catches customer
 * replies to the tracked Reply-To `reply+{sequence_id}@replies.
 * getcollectionscopilot.com` and POSTs them here using the contract below.
 * This handler:
 *   1. Verifies `Authorization: Bearer {INBOUND_WEBHOOK_TOKEN}` (403 when the
 *      token is unset or wrong — the endpoint is effectively disabled, same
 *      pattern as SUPPORT_API_TOKEN).
 *   2. Looks up the invoice by sequence_id (the invoice's internal DB id).
 *      Unknown sequence → 200 no-op (the worker may retry; a 4xx would make
 *      the worker treat it as an error).
 *   3. Stores an inbound_replies row, idempotent on idempotency_key.
 *   4. Pauses the invoice's sequence (sets reply_paused_at, cancels open
 *      reminder tasks) — same priority as the paid/dispute/refund stop logic,
 *      across ALL Trust Modes. Never re-pauses an already-stopped invoice.
 *   5. Forwards the original reply to the merchant's real inbox
 *      (merchant.reply_to ?? merchant.email) and notifies them via the
 *      standard notify machinery.
 *   6. Responds 200 fast. D1b (pipeline/reply-ai.ts) then processes the reply
 *      INLINE right here: classify → draft → conditional send / hold / opt-out
 *      (see below). The webhook response therefore includes the AI processing
 *      time (bounded by a 20s LLM timeout); on any AI failure the reply stays
 *      captured-and-held (safe default) — the webhook itself never 5xxs.
 *
 * ── reply_status state machine (see migrations/011 for the full picture) ──
 *   captured         stored here (D1a)
 *   pending_approval classified + drafted + held for approve/edit/reject (D1b)
 *   auto_sent        question + high confidence + Full Auto: sent automatically
 *   sent             merchant approved (optionally after editing) and it sent
 *   rejected         merchant rejected the draft
 *   handled          terminal: opt-out confirmation sent / no response needed
 *
 * ── Inbound payload contract (the worker sends EXACTLY this) ──
 *   POST {BASE_URL}/inbound/reply
 *   Authorization: Bearer {INBOUND_WEBHOOK_TOKEN}
 *   Content-Type: application/json
 *   {
 *     "sequence_id": "42",                 // reply+ tag value, invoice internal DB id (string)
 *     "received_at": "2026-08-12T15:00:00Z", // ISO timestamp (optional; server falls back to now)
 *     "from_email": "customer@example.com",
 *     "from_name": "Jane Customer",        // optional
 *     "subject": "Re: Friendly Reminder...", // optional
 *     "body": "raw reply text...",         // plain-text body
 *     "raw_message": { ... },              // optional: full original message (any JSON)
 *     "provider_message_id": "..."         // optional: provider message id; used as idempotency key
 *   }
 *
 * ── Idempotency ──
 * Keyed on provider_message_id when the worker provides one, else derived as
 * SHA-256(sequence_id|received_at|body). The idempotency_key column is UNIQUE;
 * INSERT OR IGNORE + changes==0 detects the duplicate → 200 no-op, so worker
 * retries can never double-insert, double-pause, double-forward or
 * double-notify.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getInvoiceById, getMerchantById, cancelTasksForInvoice, logSend } from "../db";
import type { Invoice, Merchant } from "../db";
import { notifyMerchant, isPlaceholderMerchant } from "../pipeline/notify";
import { sendEmailForReal } from "../pipeline/sender";
import { processReplyAI } from "../pipeline/reply-ai";
import type { EmailDraft } from "../pipeline/drafter";

const INBOUND_TOKEN = process.env.INBOUND_WEBHOOK_TOKEN;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Token verification: `Authorization: Bearer {INBOUND_WEBHOOK_TOKEN}`. */
function authorized(req: Request): boolean {
  if (!INBOUND_TOKEN) return false;
  const auth = req.headers.get("Authorization") ?? "";
  return auth === `Bearer ${INBOUND_TOKEN}`;
}

interface InboundReplyPayload {
  sequence_id?: unknown;
  received_at?: unknown;
  from_email?: unknown;
  from_name?: unknown;
  subject?: unknown;
  body?: unknown;
  raw_message?: unknown;
  provider_message_id?: unknown;
}

/** Which stop reason an invoice already carries (for logs/response). */
function stoppedReason(invoice: Invoice): string {
  if (invoice.status === "paid") return "paid";
  if (invoice.dispute_id) return "disputed";
  if (invoice.refund_id) return "refunded";
  if (invoice.reply_paused_at) return "reply-paused";
  if (invoice.reply_opt_out_at) return "opt-out";
  return "";
}

/**
 * Forward the original customer reply to the merchant's real inbox
 * (merchant.reply_to ?? merchant.email). The merchant's reply_to is the
 * FORWARD TARGET now — it no longer appears in any Reply-To header (sender.ts
 * uses the system-tracked address instead).
 *
 * Logged to send_logs as type 'reply_forward' so the flow is auditable and
 * testable. Never throws: send failures are caught, logged, and swallowed —
 * the inbound webhook must stay 200-fast (the reply is already captured and
 * the sequence already paused; the forward is best-effort on top).
 */
async function forwardReply(
  db: Database,
  invoice: Invoice,
  reply: { fromEmail: string; fromName: string | null; subject: string | null; body: string },
): Promise<void> {
  // merchants.reply_to lives on the settings-pack columns (migration 009),
  // not the base Merchant type — narrow the row so tsc sees it.
  const merchant = getMerchantById(db, invoice.merchant_id) as (Merchant & { reply_to: string | null }) | null;
  const configured = (merchant?.reply_to || "").trim();
  const target = configured || merchant?.email || "";

  if (!target) {
    console.log(`[inbound] no forward target for invoice ${invoice.stripe_invoice_id} — skipping forward`);
    return;
  }
  // Placeholder merchants (acct_default / .local seeds) have no deliverable
  // inbox unless the merchant explicitly configured reply_to as the target.
  if (!configured && merchant && isPlaceholderMerchant(merchant)) {
    console.log(`[inbound] merchant ${invoice.merchant_id} has no real forward target — skipping forward`);
    return;
  }

  const subject = `Re: ${reply.subject?.trim() || `reply about invoice ${invoice.stripe_invoice_id}`}`;
  const fromLabel = reply.fromName ? `${reply.fromName} <${reply.fromEmail}>` : reply.fromEmail;
  const bodyText =
    `From: ${fromLabel}\n` +
    (reply.subject ? `Subject: ${reply.subject}\n` : "") +
    `\n${(reply.body || "").trimEnd()}\n\n` +
    `— — —\n` +
    `This customer reply paused CollectionsCopilot's reminder sequence for invoice ${invoice.stripe_invoice_id}. ` +
    `It is captured in your dashboard; reminders stay paused until you resume the sequence.`;

  const draft: EmailDraft = { subject, body: bodyText };
  try {
    const result = await sendEmailForReal(db, null, draft, target, undefined, { skipCanspam: true });
    logSend(
      db,
      0,
      result.success ? "success" : "failed",
      `Reply forwarded to ${target}: ${result.message}`,
      "reply_forward",
    );
    console.log(`[inbound] reply for invoice ${invoice.stripe_invoice_id} forwarded to ${target} (${result.provider || "stub"})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logSend(db, 0, "failed", `Reply forward error for invoice ${invoice.stripe_invoice_id}: ${msg}`, "reply_forward");
    console.warn(`[inbound] forward failed for invoice ${invoice.stripe_invoice_id}: ${msg}`);
  }
}

export async function handleInboundReply(db: Database, req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!authorized(req)) {
    return json({ error: "Unauthorized — missing or invalid INBOUND_WEBHOOK_TOKEN" }, 403);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const p = payload as InboundReplyPayload;

  // ── Validate the contract ──
  const seq = String(p.sequence_id ?? "").trim();
  const invoiceId = Number.parseInt(seq, 10);
  if (!seq || !Number.isInteger(invoiceId) || invoiceId <= 0) {
    return json({ error: "Invalid sequence_id — expected the invoice's internal DB id as a string" }, 400);
  }
  const fromEmail = typeof p.from_email === "string" ? p.from_email.trim() : "";
  if (!fromEmail) {
    return json({ error: "from_email is required" }, 400);
  }
  const replyBody = typeof p.body === "string" ? p.body : "";

  // ── Resolve the invoice; unknown sequence → 200 no-op ──
  const invoice = getInvoiceById(db, invoiceId);
  if (!invoice) {
    console.log(`[inbound] reply for unknown sequence_id ${seq} — ignored (200 no-op)`);
    return json({ status: "ignored", reason: "unknown_sequence" }, 200);
  }

  // ── Idempotency: provider_message_id when given, else derived hash ──
  const receivedAt = typeof p.received_at === "string" && p.received_at.trim()
    ? p.received_at.trim()
    : new Date().toISOString();
  const providerMsgId = typeof p.provider_message_id === "string" && p.provider_message_id.trim()
    ? p.provider_message_id.trim()
    : "";
  const idemKey = providerMsgId || createHash("sha256").update(`${seq}|${receivedAt}|${replyBody}`).digest("hex");

  const subject = typeof p.subject === "string" && p.subject.trim() ? p.subject.trim() : null;
  const fromName = typeof p.from_name === "string" && p.from_name.trim() ? p.from_name.trim() : null;
  const rawMessage = typeof p.raw_message === "string"
    ? p.raw_message
    : p.raw_message !== undefined
      ? JSON.stringify(p.raw_message)
      : null;

  const inserted = db.run(
    `INSERT OR IGNORE INTO inbound_replies
       (merchant_id, invoice_id, sequence_key, received_at, from_email, from_name,
        subject, body, raw_message, idempotency_key, reply_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'captured')`,
    [invoice.merchant_id, invoice.id, seq, receivedAt, fromEmail, fromName, subject, replyBody, rawMessage, idemKey],
  );
  if (inserted.changes === 0) {
    console.log(`[inbound] duplicate reply for sequence_id ${seq} (idem ${idemKey.slice(0, 12)}…) — ignored (200 no-op)`);
    return json({ status: "ignored", reason: "duplicate" }, 200);
  }
  console.log(`[inbound] reply stored for sequence_id ${seq} (invoice ${invoice.stripe_invoice_id}, idem ${idemKey.slice(0, 12)}…)`);

  // ── Auto-pause: same priority as paid/dispute/refund, all Trust Modes ──
  const stopped = stoppedReason(invoice);
  const paused = !stopped;
  if (paused) {
    const now = new Date().toISOString();
    db.run("UPDATE invoices SET reply_paused_at=? WHERE id=?", [now, invoice.id]);
    cancelTasksForInvoice(db, invoice.id);
    logSend(db, 0, "success", `Customer reply captured — sequence paused for invoice ${invoice.stripe_invoice_id}`, "reply");
    console.log(`[inbound] invoice ${invoice.stripe_invoice_id} — sequence paused (reply), tasks cancelled`);
  } else {
    console.log(`[inbound] invoice ${invoice.stripe_invoice_id} — already ${stopped}, reply captured without re-pausing`);
  }

  // ── Forward + notify (best-effort; never fail the webhook) ──
  await forwardReply(db, invoice, { fromEmail, fromName, subject, body: replyBody });
  try {
    await notifyMerchant(
      db,
      invoice.merchant_id,
      `Customer reply — invoice ${invoice.stripe_invoice_id} sequence paused`,
      `${invoice.customer_name} replied to invoice ${invoice.stripe_invoice_id} — sequence paused, awaiting your review.`,
    );
  } catch (err: unknown) {
    console.warn(`[inbound] merchant notification failed for invoice ${invoice.stripe_invoice_id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── D1b: AI classification + draft + conditional send (inline) ──
  // Runs only for the FIRST delivery (the duplicate path above already
  // returned), so worker retries can never double-process. Any failure inside
  // processReplyAI is contained (safe hold: 'other' + confidence 0 →
  // pending_approval); the webhook still answers 200.
  const replyId = Number(inserted.lastInsertRowid);
  try {
    const outcome = await processReplyAI(db, replyId);
    console.log(`[inbound] reply ${replyId} processed → ${outcome?.status ?? "noop"} (${outcome?.classification ?? "n/a"}, action ${outcome?.action ?? "n/a"})`);
  } catch (err: unknown) {
    console.warn(`[inbound] AI processing failed for reply ${replyId}: ${err instanceof Error ? err.message : String(err)} — safe hold`);
    try {
      const row = db.query("SELECT reply_status FROM inbound_replies WHERE id=?").get(replyId) as { reply_status: string } | null;
      if (row?.reply_status === "captured") {
        db.run("UPDATE inbound_replies SET classification='other', confidence=0, reply_status='pending_approval' WHERE id=?", [replyId]);
      }
    } catch {
      // nothing more we can do — the row is already captured + paused (safe)
    }
  }

  return json({ status: "captured", paused, invoice_id: invoice.id, sequence_key: seq }, 200);
}
