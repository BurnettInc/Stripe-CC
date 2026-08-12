/**
 * Reply review queue — merchant-facing endpoints for held customer replies
 * (reply-pause D1b, owner spec item 7). Session-authenticated like every
 * /tasks route; every operation enforces merchant ownership (foreign rows →
 * 404, never leak existence).
 *
 * ── Routes ──
 *   GET  /replies              list the merchant's replies (default: actionable
 *                              rows only — captured + pending_approval;
 *                              ?status=all returns every row incl. history).
 *   POST /replies/{id}/approve send the draft (or the edited subject/body in
 *                              the JSON body) to the customer; marks the row
 *                              'sent' + handled_at.
 *   POST /replies/{id}/edit    replace draft_reply_subject/draft_reply_body
 *                              (body required, subject optional); a 'captured'
 *                              row becomes 'pending_approval'.
 *   POST /replies/{id}/reject  mark the row 'rejected' + handled_at (no send).
 *
 * ── Approve/edit/reject JSON ──
 *   POST /replies/5/approve
 *     {}                                    → send the stored AI draft
 *     { "subject": "Re: …", "body": "…" }   → send edited content instead
 *   POST /replies/5/edit
 *     { "body": "…", "subject": "Re: …" }   → body required, subject optional
 *   POST /replies/5/reject    (no body needed)
 *
 * ── reply_status state machine (see migrations/011 for the full picture) ──
 *   captured         stored by the inbound webhook (D1a)
 *   pending_approval classified + drafted + held for approve/edit/reject (D1b)
 *   auto_sent        question + high confidence + Full Auto: sent automatically
 *   sent             merchant approved (optionally after editing) and it sent
 *   rejected         merchant rejected the draft
 *   handled          terminal: opt-out confirmation sent / no response needed
 *   Terminal states (auto_sent / sent / rejected / handled) are immutable —
 *   approve/edit/reject return 409.
 *
 * ── UI contract note ──
 * This list is the canonical review queue for the future dashboard UI. The
 * PR #56 chips key off /tasks rows carrying reply_paused_at / reply_opt_out_at
 * (added to the /tasks payload in db.ts getAllTasks) — the pause-reason chip
 * lights there; the approve/edit/reject actions consume this /replies list.
 */

import type { Database } from "bun:sqlite";
import { getInvoiceById, getMerchantById, isUnsubscribed, logSend } from "../db";
import type { Invoice } from "../db";
import { sendEmailForReal } from "../pipeline/sender";
import { appendCanspamFooter } from "../pipeline/canspam";
import { getReplyById } from "../pipeline/reply-ai";
import type { InboundReplyRow } from "../pipeline/reply-ai";

const headers = { "Content-Type": "application/json" };

const json404 = () => new Response(JSON.stringify({ error: "Reply not found" }), { status: 404, headers });

/** Resolve a reply and verify it belongs to the authenticated merchant. */
function resolveOwnedReply(db: Database, replyId: number, merchantId: number): InboundReplyRow | null {
  const reply = getReplyById(db, replyId);
  if (!reply || reply.merchant_id !== merchantId) return null;
  return reply;
}

const TERMINAL_STATUSES = new Set(["auto_sent", "sent", "rejected", "handled"]);

/** The tracked reply address for an invoice (same derivation as sender.ts). */
function trackedReplyToForInvoice(invoiceId: number): string {
  const domain = process.env.REPLY_DOMAIN || "replies.getcollectionscopilot.com";
  return `reply+${invoiceId}@${domain}`;
}

/**
 * Send a reply draft to the CUSTOMER (manual approve path). Mirrors
 * sendReplyToCustomer in pipeline/reply-ai.ts: CAN-SPAM footer scoped to the
 * real merchant, tracked Reply-To, sender branding, global-unsubscribe guard.
 * Returns null on success (row already updated by the caller), or an error
 * Response on failure.
 */
async function sendApprovedReply(
  db: Database,
  reply: InboundReplyRow,
  invoice: Invoice,
  draft: { subject: string; body: string },
): Promise<Response | null> {
  const customerEmail = invoice.customer_email || "";
  if (!customerEmail) {
    return new Response(JSON.stringify({ error: "Invoice has no customer email — cannot send the reply" }), { status: 400, headers });
  }
  if (isUnsubscribed(db, invoice.merchant_id, customerEmail)) {
    return new Response(
      JSON.stringify({ error: "This customer has opted out of all reminders — reply not sent. Answer them from your own inbox instead." }),
      { status: 400, headers },
    );
  }

  const merchant = getMerchantById(db, invoice.merchant_id) as
    | (import("../db").Merchant & { sender_name: string | null })
    | null;
  const body = appendCanspamFooter(draft.body, invoice.merchant_id, customerEmail);
  const result = await sendEmailForReal(db, null, { subject: draft.subject, body }, customerEmail, undefined, {
    skipCanspam: true, // footer already appended above
    replyTo: trackedReplyToForInvoice(invoice.id),
    senderName: merchant?.sender_name ?? null,
  });

  logSend(db, 0, result.success ? "success" : "failed", `Reply sent to ${customerEmail} (approved by merchant): ${result.message}`, "reply_send");
  if (!result.success) {
    return new Response(JSON.stringify({ error: "send_failed", message: result.message }), { status: 502, headers });
  }
  return null;
}

/** GET /replies — review queue. Default: actionable rows; ?status=all → history too. */
function handleList(db: Database, merchantId: number, req: Request): Response {
  const url = new URL(req.url);
  const includeAll = url.searchParams.get("status") === "all";
  const rows = db.query(`
    SELECT r.*,
           i.stripe_invoice_id, i.customer_name, i.customer_email,
           i.amount_cents, i.currency, i.due_date, i.status AS invoice_status,
           i.reply_paused_at, i.reply_opt_out_at
    FROM inbound_replies r
    JOIN invoices i ON r.invoice_id = i.id
    WHERE r.merchant_id = ?
      ${includeAll ? "" : "AND r.reply_status IN ('captured', 'pending_approval')"}
    ORDER BY r.id DESC
  `).all(merchantId) as Array<Record<string, unknown>>;
  return new Response(JSON.stringify(rows), { status: 200, headers });
}

/** POST /replies/{id}/edit — replace the draft; 'captured' rows become pending_approval. */
async function handleEdit(
  db: Database,
  reply: InboundReplyRow,
  req: Request,
): Promise<Response> {
  let body: { subject?: unknown; body?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
  }
  const draftBody = typeof body.body === "string" ? body.body.trim() : "";
  if (!draftBody) {
    return new Response(JSON.stringify({ error: "body is required and must be non-empty" }), { status: 400, headers });
  }
  if (draftBody.length > 10000) {
    return new Response(JSON.stringify({ error: "body exceeds the 10,000 character limit" }), { status: 400, headers });
  }
  const draftSubject = typeof body.subject === "string" && body.subject.trim()
    ? body.subject.trim()
    : (reply.draft_reply_subject ?? `Re: your message about invoice #${reply.sequence_key}`);
  if (draftSubject.length > 500) {
    return new Response(JSON.stringify({ error: "subject exceeds the 500 character limit" }), { status: 400, headers });
  }

  const nextStatus = reply.reply_status === "captured" ? "pending_approval" : reply.reply_status;
  db.run("UPDATE inbound_replies SET draft_reply_subject=?, draft_reply_body=?, reply_status=? WHERE id=?", [
    draftSubject, draftBody, nextStatus, reply.id,
  ]);
  return new Response(JSON.stringify(getReplyById(db, reply.id)), { status: 200, headers });
}

/** POST /replies/{id}/approve — send the draft (or the edited content) and mark 'sent'. */
async function handleApprove(
  db: Database,
  reply: InboundReplyRow,
  req: Request,
): Promise<Response> {
  let body: { subject?: unknown; body?: unknown } = {};
  const raw = await req.text().catch(() => "");
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as { subject?: unknown; body?: unknown };
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }
  }

  const editedBody = typeof body.body === "string" && body.body.trim() ? body.body.trim() : "";
  const editedSubject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : "";

  const draftBody = editedBody || reply.draft_reply_body || "";
  if (!draftBody) {
    return new Response(
      JSON.stringify({ error: "No draft to approve — edit the reply first (POST /replies/{id}/edit) or provide subject/body in this request." }),
      { status: 400, headers },
    );
  }
  const draftSubject = editedSubject || reply.draft_reply_subject || `Re: your message about invoice #${reply.sequence_key}`;

  const invoice = getInvoiceById(db, reply.invoice_id);
  if (!invoice) return json404();

  const sendError = await sendApprovedReply(db, reply, invoice, { subject: draftSubject, body: draftBody });
  if (sendError) return sendError;

  const now = new Date().toISOString();
  // Persist the exact content that went out so the row reflects the send.
  db.run(
    "UPDATE inbound_replies SET draft_reply_subject=?, draft_reply_body=?, reply_status='sent', handled_at=? WHERE id=?",
    [draftSubject, draftBody, now, reply.id],
  );
  console.log(`[replies] merchant ${invoice.merchant_id} approved reply ${reply.id} -> sent`);
  return new Response(JSON.stringify({ ok: true, reply: getReplyById(db, reply.id), message: "Reply sent to the customer." }), { status: 200, headers });
}

/** POST /replies/{id}/reject — mark 'rejected' + handled_at, no send. */
function handleReject(db: Database, reply: InboundReplyRow): Response {
  const now = new Date().toISOString();
  db.run("UPDATE inbound_replies SET reply_status='rejected', handled_at=? WHERE id=?", [now, reply.id]);
  logSend(db, 0, "skipped", `Reply ${reply.id} rejected by merchant — not sent`, "reply_reject");
  return new Response(JSON.stringify({ ok: true, reply: getReplyById(db, reply.id), message: "Reply rejected — nothing was sent." }), { status: 200, headers });
}

export async function handleReplies(db: Database, req: Request, pathSuffix: string, merchantId: number): Promise<Response> {
  // GET /replies
  if (req.method === "GET" && pathSuffix === "") {
    return handleList(db, merchantId, req);
  }

  // POST /replies/:id/approve | /edit | /reject
  const actionMatch = pathSuffix.match(/^\/(\d+)\/(approve|edit|reject)$/);
  if (req.method === "POST" && actionMatch) {
    const replyId = parseInt(actionMatch[1], 10);
    const action = actionMatch[2];
    const reply = resolveOwnedReply(db, replyId, merchantId);
    if (!reply) return json404();

    if (TERMINAL_STATUSES.has(reply.reply_status)) {
      return new Response(
        JSON.stringify({ error: `Reply already ${reply.reply_status} — cannot ${action} a terminal reply`, currentStatus: reply.reply_status }),
        { status: 409, headers },
      );
    }

    if (action === "edit") return handleEdit(db, reply, req);
    if (action === "approve") return handleApprove(db, reply, req);
    return handleReject(db, reply);
  }

  return new Response("Not found", { status: 404 });
}
