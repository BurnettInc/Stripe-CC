import type { Database } from "bun:sqlite";
import { upsertInvoice, createReminderTask, cancelTasksForInvoice, ensureDefaultMerchant, resolveMerchant, hasActiveSubscription, freeDraftsRemaining, countOverdueInvoices, getTaskForInvoice, invoiceLimitFor, logSend, getTaskById, getInvoiceById, getMerchantById } from "../db";
import type { Invoice } from "../db";
import { getEscalationStage } from "./escalation";
import { getStripeKey } from "../middleware/auth";
import { notifyMerchant } from "./notify";
import { draftEmail } from "./drafter";
import { reviewDraft } from "./reviewer";
import { getLateFeeText } from "./late-fee";
import Stripe from "stripe";

export interface WebhookEvent {
  type: string;
  /** Stripe connected-account ID the event belongs to (top-level `account` field). */
  account?: string;
  data: {
    object: {
      id: string;
      customer_name?: string;
      customer_email?: string;
      amount_due?: number;
      currency?: string;
      due_date?: number; // unix timestamp
      status?: string;
      [key: string]: unknown;
    };
  };
}

/** Compact currency formatter for merchant notification bodies: $12.00 / EUR 12.00. */
function formatMoney(cents: number, currency: string): string {
  const value = (cents / 100).toFixed(2);
  return currency === "usd" ? `$${value}` : `${currency.toUpperCase()} ${value}`;
}

/**
 * Resolve a local invoice for a charge-linked webhook event (dispute, refund).
 *
 * 1. If a Stripe API key is available, fetch the charge and use its `invoice`
 *    field (the authoritative link for invoice-backed payments). When the
 *    invoice isn't found locally, enrich the fallback with the charge's
 *    billing details + amount.
 * 2. Fall back to matching the merchant's own invoices by amount, then
 *    customer email, then customer name (in that preference order).
 *
 * Never throws: any API failure degrades to the DB-only match so the event is
 * still processed. Returns null when nothing matches.
 */
async function resolveInvoiceForCharge(
  db: Database,
  merchantId: number,
  chargeId: string | undefined,
  fallback: { amountCents?: number; customerName?: string; customerEmail?: string },
): Promise<Invoice | null> {
  if (chargeId) {
    const key = getStripeKey(db, merchantId);
    if (key) {
      try {
        const stripe = new Stripe(key);
        const charge = await stripe.charges.retrieve(chargeId);
        // The SDK's Charge type omits `invoice` (it IS present on the real
        // API object — docs.stripe.com/api/charges/object), so read it via a
        // narrow cast rather than a full any.
        const chargeInvoice = (charge as { invoice?: string | null }).invoice;
        if (chargeInvoice) {
          const byInvoice = db
            .query("SELECT * FROM invoices WHERE stripe_invoice_id=? AND merchant_id=?")
            .get(chargeInvoice, merchantId) as Invoice | null;
          if (byInvoice) return byInvoice;
        }
        // Enrich the fallback with facts only the charge carries (billing name/email).
        fallback = {
          amountCents: typeof charge.amount === "number" ? charge.amount : fallback.amountCents,
          customerEmail: charge.billing_details?.email || fallback.customerEmail,
          customerName: charge.billing_details?.name || fallback.customerName,
        };
      } catch (err: unknown) {
        console.warn(
          `[webhook] charge lookup failed for ${chargeId}: ${err instanceof Error ? err.message : String(err)} — falling back to DB match`
        );
      }
    }
  }

  return matchInvoiceByAmountAndCustomer(db, merchantId, fallback);
}

/** Match a merchant's invoice by amount, preferring customer email then name. */
function matchInvoiceByAmountAndCustomer(
  db: Database,
  merchantId: number,
  match: { amountCents?: number; customerName?: string; customerEmail?: string },
): Invoice | null {
  const amount = typeof match.amountCents === "number" ? match.amountCents : 0;
  if (match.customerEmail) {
    const byEmail = db
      .query("SELECT * FROM invoices WHERE merchant_id=? AND amount_cents=? AND customer_email=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(merchantId, amount, match.customerEmail) as Invoice | null;
    if (byEmail) return byEmail;
  }
  if (match.customerName) {
    const byName = db
      .query("SELECT * FROM invoices WHERE merchant_id=? AND amount_cents=? AND customer_name=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(merchantId, amount, match.customerName) as Invoice | null;
    if (byName) return byName;
  }
  return db
    .query("SELECT * FROM invoices WHERE merchant_id=? AND amount_cents=? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(merchantId, amount) as Invoice | null;
}

/**
 * Handle an incoming Stripe webhook event.
 * Returns a summary of what was done.
 */
export async function handleWebhookEvent(db: Database, event: WebhookEvent): Promise<{ action: string; invoiceId?: number; taskId?: number }> {
  ensureDefaultMerchant(db);

  // Attribute the event to the merchant that owns the Stripe account it came
  // from — never blindly "row 1". Falls back to the default merchant when the
  // account isn't (yet) in stripe_connections.
  const merchant = resolveMerchant(db, event.account);
  const merchantId = merchant?.id ?? 1;

  switch (event.type) {
    case "invoice.overdue":
    case "invoice.payment_failed": {
      const inv = event.data.object;
      const stripeInvoiceId = inv.id;
      const customerName = inv.customer_name || "Unknown";
      const customerEmail = inv.customer_email || "";
      const amountCents = inv.amount_due || 0;
      const currency = inv.currency || "usd";
      const dueDate = inv.due_date
        ? new Date((inv.due_date as number) * 1000).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

      // Standard plan cap: an active Standard merchant may track at most 50
      // overdue invoices at once. Capture the pre-existing overdue count
      // BEFORE the upsert below so the 50th invoice is still trackable and
      // the 51st is blocked (count >= 50 means 50 rows were already tracked).
      const limit = invoiceLimitFor(db, merchantId);
      const overdueBefore = limit !== null ? countOverdueInvoices(db, merchantId) : 0;

      const invoiceId = upsertInvoice(db, {
        stripe_invoice_id: stripeInvoiceId,
        merchant_id: merchantId,
        customer_name: customerName,
        customer_email: customerEmail,
        amount_cents: amountCents,
        currency,
        due_date: dueDate,
        status: "overdue",
      });

      const daysOverdue = Math.floor(
        (Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)
      );
      // Pro merchants can customize the ladder boundaries (PUT /settings
      // stage1_days/stage2_days); fall back to the default 6/20 ladder.
      const timing = db
        .query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?")
        .get(merchantId) as { stage1_days: number; stage2_days: number } | null;
      const stage = getEscalationStage(
        daysOverdue,
        timing?.stage1_days ?? 6,
        timing?.stage2_days ?? 20,
      );
      if (!hasActiveSubscription(db, merchantId) && freeDraftsRemaining(db, merchantId) <= 0) {
        console.log(`Skipping task creation for merchant ${merchantId}: free draft limit reached, no subscription`);
        return { action: `skipped reminder task for invoice ${stripeInvoiceId}: free draft limit reached` , invoiceId };
      }
      // The invoice was still upserted above so it stays visible in the
      // dashboard — only task creation (tracking / reminders) is blocked.
      // Invoices that already have a task are never blocked: a re-fired event
      // for an already-tracked invoice must not be skipped, and a
      // previously-blocked invoice is automatically picked up once the
      // merchant drops back under the limit.
      if (limit !== null && overdueBefore >= limit && !getTaskForInvoice(db, invoiceId)) {
        console.log(`[watcher] Merchant ${merchantId} at Standard 50-invoice limit — invoice ${stripeInvoiceId} not tracked. Upgrade to Pro for unlimited.`);
        return { action: `skipped invoice ${stripeInvoiceId}: Standard 50-invoice limit reached (upgrade to Pro)`, invoiceId };
      }
      const taskId = createReminderTask(db, invoiceId, stage);

      // Auto-draft at creation: webhook-created tasks arrive with a visible
      // draft (AI when OPENAI_API_KEY is set, template fallback otherwise) and
      // a reviewer verdict — matching what the dashboard/runbook promise
      // ("the task shows a drafted email at Stage 1"). Mirrors the pending→
      // draft path in routes/tasks.ts (draft → persist → freemium count →
      // review → persist). Safe by construction: if drafting throws for any
      // reason, log and leave the task 'pending' — never fail the webhook.
      try {
        const task = getTaskById(db, taskId);
        const invoice = getInvoiceById(db, invoiceId);
        if (task && invoice) {
          const draft = await draftEmail(task, invoice, getMerchantById(db, invoice.merchant_id)?.email, db);
          db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=?, status='drafted' WHERE id=?", [
            draft.subject, draft.body, taskId,
          ]);
          // The freemium allowance is derived from drafted tasks (see
          // freeDraftsRemaining in db.ts) — no counter write needed here.
          const review = reviewDraft(draft, invoice, {
            lateFeeText: getLateFeeText(db, invoice.merchant_id, invoice, task.stage),
          });
          db.run("UPDATE reminder_tasks SET reviewer_notes=?, status='reviewed' WHERE id=?", [
            JSON.stringify(review), taskId,
          ]);
          console.log(`[watcher] auto-drafted task ${taskId} for invoice ${stripeInvoiceId} (stage ${stage}, ${review.approved ? "reviewed-ok" : "review-issues:" + review.issues.length})`);
        }
      } catch (err) {
        console.warn(`[watcher] auto-draft failed for task ${taskId} (invoice ${stripeInvoiceId}): ${err instanceof Error ? err.message : String(err)} — task left pending`);
      }

      return { action: `created reminder task for invoice ${stripeInvoiceId} at stage ${stage}`, invoiceId, taskId };
    }

    case "invoice.paid": {
      const inv = event.data.object;
      const stripeInvoiceId = inv.id;

      const existing = db
        .query("SELECT * FROM invoices WHERE stripe_invoice_id = ?")
        .get(stripeInvoiceId) as Invoice | null;

      if (existing) {
        // Were we actually following up on this invoice? Only notify the
        // merchant when there was at least one reminder task in flight
        // (pending/drafted/reviewed/sent) — never notify for invoices we
        // never chased (avoids noise).
        const followed = db
          .query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=? AND status IN ('pending','drafted','reviewed','sent')")
          .get(existing.id) as { n: number };
        const wasFollowedUp = followed.n > 0;

        db.run("UPDATE invoices SET status='paid' WHERE id=?", [existing.id]);
        cancelTasksForInvoice(db, existing.id);

        let action = `invoice ${stripeInvoiceId} marked paid, active tasks cancelled`;

        // Payment-received notification — once per invoice (paid_notified
        // flag guards against replayed invoice.paid events double-notifying).
        if (wasFollowedUp && !existing.paid_notified) {
          db.run("UPDATE invoices SET paid_notified=1 WHERE id=?", [existing.id]);
          const money = formatMoney(existing.amount_cents, existing.currency);
          await notifyMerchant(
            db,
            existing.merchant_id,
            `Payment received — invoice ${stripeInvoiceId}`,
            `Payment received — invoice ${stripeInvoiceId} (${money}) from ${existing.customer_name}. We've stopped reminders for it.`
          );
          action += " — payment-received notification sent";
        }
        return { action, invoiceId: existing.id };
      }
      return { action: `invoice ${stripeInvoiceId} not found locally, no action taken` };
    }

    // Homepage FAQ: "If a customer disputes an invoice, the sequence pauses
    // immediately — you'll be notified."
    case "charge.dispute.created": {
      const dispute = event.data.object as Record<string, unknown>;
      const disputeId = typeof dispute.id === "string" ? dispute.id : "";
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : undefined;
      const amount = typeof dispute.amount === "number" ? dispute.amount : undefined;

      const invoice = await resolveInvoiceForCharge(db, merchantId, chargeId, { amountCents: amount });
      if (!invoice) {
        console.log(`[webhook] dispute.created ${disputeId}: no local invoice matched (charge ${chargeId ?? "?"}, merchant ${merchantId}) — no action`);
        return { action: `dispute ${disputeId} not matched to a local invoice — no action` };
      }

      // Idempotency: a replayed charge.dispute.created for the same dispute id
      // must not pause again or double-notify. A genuinely new dispute (new
      // id) pauses + notifies again.
      if (invoice.dispute_id === disputeId) {
        return { action: `dispute ${disputeId} already handled for invoice ${invoice.stripe_invoice_id} — skipped (idempotent)` };
      }

      // Pause the invoice's sequence: cancel open tasks. invoices.status is a
      // constrained CHECK column ('open'|'paid'|'void'|'overdue') so there is
      // no 'disputed' state to set — the cancelled tasks ARE the pause.
      cancelTasksForInvoice(db, invoice.id);
      db.run("UPDATE invoices SET dispute_id=? WHERE id=?", [disputeId, invoice.id]);

      const money = formatMoney(invoice.amount_cents, invoice.currency);
      await notifyMerchant(
        db,
        invoice.merchant_id,
        `Dispute filed on invoice ${invoice.stripe_invoice_id}`,
        `${invoice.customer_name} disputed invoice ${invoice.stripe_invoice_id} (${money}) — we've paused reminders for it. Respond in your Stripe dashboard.`
      );

      return { action: `dispute ${disputeId}: paused reminders for invoice ${invoice.stripe_invoice_id}`, invoiceId: invoice.id };
    }

    // Refund safety: a fully-refunded charge must never keep being dunned.
    // Stripe sends one refund object per refund; `status: succeeded` means the
    // refund executed. (Charge-level "fully refunded" would need a charge
    // fetch — see resolveInvoiceForCharge — so treat a succeeded refund as
    // refunded; Stripe emits charge.refunded separately when a charge is
    // fully refunded via multiple partials, out of scope here.)
    case "charge.refunded": {
      const refund = event.data.object as Record<string, unknown>;
      const refundId = typeof refund.id === "string" ? refund.id : "";
      const refundStatus = typeof refund.status === "string" ? refund.status : "";

      if (refundStatus !== "succeeded") {
        return { action: `refund ${refundId} status '${refundStatus || "unknown"}' — no action (only succeeded refunds stop sequences)` };
      }

      const chargeId = typeof refund.charge === "string" ? refund.charge : undefined;
      const amount = typeof refund.amount === "number" ? refund.amount : undefined;

      const invoice = await resolveInvoiceForCharge(db, merchantId, chargeId, { amountCents: amount });
      if (!invoice) {
        console.log(`[webhook] charge.refunded ${refundId}: no local invoice matched (charge ${chargeId ?? "?"}, merchant ${merchantId}) — no action`);
        return { action: `refund ${refundId} not matched to a local invoice — no action` };
      }

      // Stop the sequence: cancel open tasks. No merchant notification
      // (homepage doesn't promise refund alerts) — but log it.
      cancelTasksForInvoice(db, invoice.id);
      logSend(
        db,
        0,
        "success",
        `Charge refunded — stopped reminders for invoice ${invoice.stripe_invoice_id} (${formatMoney(invoice.amount_cents, invoice.currency)})`,
        "refund"
      );

      return { action: `refund ${refundId}: stopped reminders for invoice ${invoice.stripe_invoice_id}`, invoiceId: invoice.id };
    }

    // Homepage FAQ: "disconnect your Stripe account... sequences stop
    // immediately." The merchant is marked disconnected, ALL their open
    // sequences are cancelled, and automatic sends are skipped until they
    // reconnect (isMerchantDisconnected guard in the pipeline).
    case "account.application.deauthorized": {
      const accountId = event.account;
      if (!accountId) {
        return { action: "deauthorized event without account id — no action" };
      }

      // STRICT lookup — never fall back to the default merchant on a
      // deauthorization: only act when this account is actually connected.
      const conn = db
        .query("SELECT merchant_id FROM stripe_connections WHERE id = ?")
        .get(accountId) as { merchant_id: number } | null;
      if (!conn) {
        console.log(`[webhook] deauthorized: account ${accountId} is not connected locally — no action`);
        return { action: `deauthorized account ${accountId} not connected locally — no action` };
      }

      const disconnectedMerchantId = conn.merchant_id;
      db.run("UPDATE merchants SET disconnected=1 WHERE id=?", [disconnectedMerchantId]);

      const cancelled = db
        .run(
          `UPDATE reminder_tasks SET status='cancelled'
           WHERE status IN ('pending','drafted','reviewed')
             AND invoice_id IN (SELECT id FROM invoices WHERE merchant_id=?)`,
          [disconnectedMerchantId]
        ).changes;

      // Merchant-level log entry (no email — the account is gone, nothing to
      // notify). Distinct send_logs type keeps merchant_notification counts
      // clean.
      logSend(
        db,
        0,
        "success",
        `Stripe account ${accountId} disconnected (application.deauthorized) — ${cancelled} open sequence(s) stopped`,
        "disconnect"
      );

      return { action: `account ${accountId} disconnected: ${cancelled} open sequence(s) cancelled (merchant ${disconnectedMerchantId})` };
    }

    default:
      return { action: `event type '${event.type}' not handled` };
  }
}
