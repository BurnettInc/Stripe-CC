import type { Database } from "bun:sqlite";
import { upsertInvoice, createReminderTask, cancelTasksForInvoice, ensureDefaultMerchant, resolveMerchant, hasActiveSubscription, freeDraftsRemaining, countOverdueInvoices, getTaskForInvoice, invoiceLimitFor, logSend, getTaskById, getInvoiceById, getMerchantById, isMerchantPaused, isMerchantDisconnected, isActiveProSubscriber, isInvoiceSequenceStopped, recordRecoveryEvent } from "../db";
import type { Invoice } from "../db";
import { getEscalationStage } from "./escalation";
import { getStripeKey } from "../middleware/auth";
import { notifyMerchant } from "./notify";
import { draftEmail } from "./drafter";
import { reviewDraft } from "./reviewer";
import { sendEmailForReal, sendEmail } from "./sender";
import { getLateFeeText } from "./late-fee";
import Stripe from "stripe";

export interface WebhookEvent {
  type: string;
  /** Stripe connected-account ID the event belongs to (top-level `account` field). */
  account?: string;
  /** Stripe mode the event belongs to (top-level `livemode` field — true =
   * live, false = test). Absent in legacy/test payloads → treated as LIVE
   * (the pre-mode default; all pre-migration rows are live). */
  livemode?: boolean;
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
 * MODE-AWARE (reviewer fix #5): the charge lookup uses the event mode's token
 * (getStripeKey with the event's livemode) and every DB match is scoped to the
 * mode — a live dispute never resolves to a test-mode invoice row.
 *
 * Never throws: any API failure degrades to the DB-only match so the event is
 * still processed. Returns null when nothing matches.
 */
async function resolveInvoiceForCharge(
  db: Database,
  merchantId: number,
  chargeId: string | undefined,
  fallback: { amountCents?: number; customerName?: string; customerEmail?: string },
  livemode: number,
): Promise<Invoice | null> {
  if (chargeId) {
    const key = getStripeKey(db, merchantId, livemode);
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
            .query("SELECT * FROM invoices WHERE stripe_invoice_id=? AND merchant_id=? AND livemode=?")
            .get(chargeInvoice, merchantId, livemode) as Invoice | null;
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

  return matchInvoiceByAmountAndCustomer(db, merchantId, fallback, livemode);
}

/** Match a merchant's invoice by amount, preferring customer email then name.
 * Mode-scoped (reviewer fix #5): `livemode` restricts the match to the event's
 * mode so a live charge can never resolve to a test invoice row. */
function matchInvoiceByAmountAndCustomer(
  db: Database,
  merchantId: number,
  match: { amountCents?: number; customerName?: string; customerEmail?: string },
  livemode: number,
): Invoice | null {
  const amount = typeof match.amountCents === "number" ? match.amountCents : 0;
  if (match.customerEmail) {
    const byEmail = db
      .query("SELECT * FROM invoices WHERE merchant_id=? AND amount_cents=? AND customer_email=? AND livemode=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(merchantId, amount, match.customerEmail, livemode) as Invoice | null;
    if (byEmail) return byEmail;
  }
  if (match.customerName) {
    const byName = db
      .query("SELECT * FROM invoices WHERE merchant_id=? AND amount_cents=? AND customer_name=? AND livemode=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(merchantId, amount, match.customerName, livemode) as Invoice | null;
    if (byName) return byName;
  }
  return db
    .query("SELECT * FROM invoices WHERE merchant_id=? AND amount_cents=? AND livemode=? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(merchantId, amount, livemode) as Invoice | null;
}

/**
 * Create a reminder task for an overdue invoice with the watcher's FULL
 * task-creation semantics, shared by the webhook handler (invoice.overdue /
 * invoice.payment_failed) and the scheduler's invoice-sync + escalation-
 * advance passes so every path behaves identically:
 *
 *   - Stage: days-overdue against the merchant's ladder timing (default
 *     1–6 / 7–20 / 21+; Pro custom stage1_days / stage2_days).
 *   - Free-tier gate: no active subscription + 0 drafts remaining → the task
 *     is skipped (the invoice itself stays visible on the dashboard).
 *   - Standard cap: an invoice with NO existing task is blocked only when the
 *     overdue count was already at the limit (50). An already-tracked invoice
 *     is never re-blocked (escalation advances pass `overdueBefore=0`).
 *   - Stale guard: a stopped invoice (paid / disputed / refunded /
 *     reply-paused / manually-paused / opt-out) is never given a new task.
 *   - Auto-draft at creation (AI when OPENAI_API_KEY, template fallback) +
 *     reviewer verdict, then Trust Mode auto-send with the tier-demotion,
 *     pause/disconnect, and duplicate-send guards.
 *
 * `overdueBefore` defaults to watcher semantics when omitted: the overdue
 * count as it was BEFORE this invoice entered the overdue set (for a
 * sync-found invoice that is the current count minus this invoice when it
 * has no task yet).
 */
export async function createTaskForOverdueInvoice(
  db: Database,
  invoice: Invoice,
  opts: { overdueBefore?: number; now?: Date } = {},
): Promise<{ action: string; invoiceId: number; taskId?: number; skipped?: string }> {
  const merchantId = invoice.merchant_id;
  const now = opts.now ?? new Date();

  if (isInvoiceSequenceStopped(invoice)) {
    console.log(`[watcher] task creation skipped for invoice ${invoice.stripe_invoice_id} — sequence stopped`);
    return { action: `skipped task for invoice ${invoice.stripe_invoice_id}: sequence stopped`, invoiceId: invoice.id, skipped: "stopped" };
  }

  const daysOverdue = Math.floor(
    (now.getTime() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24)
  );
  // Pro merchants can customize the ladder boundaries (PUT /settings
  // stage1_days/stage2_days); fall back to the default 6/20 ladder.
  const timing = db
    .query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?")
    .get(merchantId) as { stage1_days: number; stage2_days: number } | null;
  // Manual per-invoice stage override (migration 031) layers on top of auto
  // progression: an override PINS the effective stage while set; NULL keeps
  // the automatic days-overdue calculation.
  const stage = invoice.stage_override ?? getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);

  const limit = invoiceLimitFor(db, merchantId);
  let overdueBefore = opts.overdueBefore;
  if (overdueBefore === undefined) {
    // Mode-scoped count (reviewer fix #5): the Standard cap measures the
    // invoice's OWN mode's overdue rows, never the other mode's.
    const count = countOverdueInvoices(db, merchantId, invoice.livemode);
    overdueBefore = getTaskForInvoice(db, invoice.id) ? count : Math.max(0, count - 1);
  }

  if (!hasActiveSubscription(db, merchantId) && freeDraftsRemaining(db, merchantId) <= 0) {
    console.log(`Skipping task creation for merchant ${merchantId}: free draft limit reached, no subscription`);
    return { action: `skipped reminder task for invoice ${invoice.stripe_invoice_id}: free draft limit reached`, invoiceId: invoice.id, skipped: "free-draft-limit" };
  }
  // Invoices that already have a task are never blocked: a re-fired event
  // for an already-tracked invoice must not be skipped, and a
  // previously-blocked invoice is automatically picked up once the
  // merchant drops back under the limit.
  if (limit !== null && overdueBefore >= limit && !getTaskForInvoice(db, invoice.id)) {
    console.log(`[watcher] Merchant ${merchantId} at Standard 50-invoice limit — invoice ${invoice.stripe_invoice_id} not tracked. Upgrade to Pro for unlimited.`);
    return { action: `skipped invoice ${invoice.stripe_invoice_id}: Standard 50-invoice limit reached (upgrade to Pro)`, invoiceId: invoice.id, skipped: "standard-limit" };
  }
  const taskId = createReminderTask(db, invoice.id, stage);

  // Auto-draft at creation: tasks arrive with a visible draft (AI when
  // OPENAI_API_KEY is set, template fallback otherwise) and a reviewer
  // verdict — matching what the dashboard/runbook promise ("the task shows a
  // drafted email at Stage 1"). Mirrors the pending→draft path in
  // routes/tasks.ts (draft → persist → freemium count → review → persist).
  // Safe by construction: if drafting throws for any reason, log and leave
  // the task 'pending' — never fail the caller.
  try {
    const task = getTaskById(db, taskId);
    if (task) {
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
      console.log(`[watcher] auto-drafted task ${taskId} for invoice ${invoice.stripe_invoice_id} (stage ${stage}, ${review.approved ? "reviewed-ok" : "review-issues:" + review.issues.length})`);

      // ── Trust Mode auto-send (Full Auto / Semi-Auto stage 1) ──
      // Executes the send server-side, applying the same gates /process
      // does:
      //   1. Reviewer approval — never send an unapproved draft.
      //   2. Trust Mode — 'full' (Pro-only) or 'semi' at stage 1 → send;
      //      'draft' / 'semi' stage 2+ stay 'reviewed' for the inbox.
      //   3. Tier gate — a stored 'full' on a non-active-Pro merchant is
      //      demoted to 'semi' (defense-in-depth; settings PUT + billing
      //      enforcement normally prevent this state).
      //   4. Pause / disconnect — skip, task kept 'reviewed' for resume.
      //   5. Replay/escalation guard — never re-send when this invoice
      //      already has a SENT task at this stage or higher (a replayed
      //      webhook creates a fresh task via createReminderTask, which
      //      would otherwise trigger a duplicate email).
      // Remaining send-time guards live in sendEmailForReal (paid-invoice
      // skip, opt-out skip, send logging, status='sent' on success).
      if (review.approved) {
        try {
          const merchant = getMerchantById(db, invoice.merchant_id);
          const merchantTrustMode = merchant?.trust_mode || "draft";
          const trustMode = invoice.trust_mode_override ?? merchantTrustMode;
          let effective = trustMode;
          if (effective === "full" && !isActiveProSubscriber(db, invoice.merchant_id)) {
            effective = "semi";
            console.log(`[watcher] merchant ${invoice.merchant_id} trust_mode 'full' demoted to 'semi' (no active Pro subscription)`);
          }
          const autoSend = effective === "full" || (effective === "semi" && task.stage === 1);
          if (autoSend) {
            const paused = isMerchantPaused(db, invoice.merchant_id);
            const disconnected = isMerchantDisconnected(db, invoice.merchant_id);
            // Reply-pause defense-in-depth: the stale guard above skips
            // re-fired events for reply-paused and manually-paused
            // invoices entirely, and the pause handlers stop open tasks —
            // so a send should never see one here. If it does (race),
            // skip like paused.
            const replyPaused = !!invoice.reply_paused_at;
            const manuallyPaused = !!invoice.manually_paused_at;
            if (paused || disconnected || replyPaused || manuallyPaused) {
              const reason = disconnected
                ? "stripe account disconnected"
                : replyPaused
                  ? "invoice reply-paused — skipped"
                  : manuallyPaused
                    ? "invoice manually paused — skipped"
                    : "collections paused";
              logSend(db, taskId, "skipped", `${reason} — automatic send skipped (task kept for resume)`);
              console.log(`[watcher] task ${taskId} auto-send skipped: ${reason}`);
            } else {
              const prior = db.query(
                "SELECT COALESCE(MAX(stage),0) AS s FROM reminder_tasks WHERE invoice_id=? AND sent_at IS NOT NULL"
              ).get(invoice.id) as { s: number };
              if (task.stage <= prior.s) {
                logSend(db, taskId, "skipped", `duplicate event — invoice already has a sent reminder at stage ${prior.s}; auto-send skipped`);
                console.log(`[watcher] task ${taskId} auto-send skipped: duplicate webhook (prior sent stage ${prior.s} >= ${task.stage})`);
              } else {
                const customerEmail = invoice.customer_email;
                const sendResult = customerEmail && customerEmail !== ""
                  ? await sendEmailForReal(db, task, draft, customerEmail)
                  : sendEmail(db, task, draft);
                console.log(`[watcher] task ${taskId} auto-sent (trust ${trustMode}, stage ${task.stage}) via ${sendResult.provider || "stub"}: ${sendResult.message}`);
              }
            }
          }
        } catch (err) {
          console.warn(`[watcher] auto-send failed for task ${taskId} (invoice ${invoice.stripe_invoice_id}): ${err instanceof Error ? err.message : String(err)} — task left reviewed`);
        }
      }
    }
  } catch (err) {
    console.warn(`[watcher] auto-draft failed for task ${taskId} (invoice ${invoice.stripe_invoice_id}): ${err instanceof Error ? err.message : String(err)} — task left pending`);
  }

  return { action: `created reminder task for invoice ${invoice.stripe_invoice_id} at stage ${stage}`, invoiceId: invoice.id, taskId };
}

/**
 * Handle an incoming Stripe webhook event.
 * Returns a summary of what was done.
 */
export async function handleWebhookEvent(db: Database, event: WebhookEvent): Promise<{ action: string; invoiceId?: number; taskId?: number }> {
  ensureDefaultMerchant(db);

  // The event's Stripe mode (top-level livemode — reviewer fix #5). Absent /
  // undefined (legacy test payloads) → LIVE, the pre-mode default: existing
  // rows are live, and webhooks without the field must keep working against
  // them. Every lookup and every upsert below is scoped to this mode, so a
  // live event can never touch a test row (and vice versa).
  const livemode = event.livemode === false ? 0 : 1;

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

      // Stale/replayed-event guard: a re-fired overdue/payment_failed event
      // for an invoice we've already stopped must NOT resurrect the sequence.
      // Snapshot the pre-existing row BEFORE the upsert: if the invoice is
      // paid, VOIDED, UNCOLLECTIBLE (reviewer fix #2 — the two are first-class
      // terminal stop states, never resurrected by a late webhook), disputed,
      // refunded, reply-paused, manually-paused, or the customer opted out of
      // reminders for it (reply_opt_out_at), skip entirely WITHOUT upserting —
      // the upsert would flip status back from 'paid'/'void'/'uncollectible'
      // to 'overdue' (defeating the sender's terminal-skip guard) and create a
      // NEW task that would re-dun a stopped customer at the next escalation
      // stage. isInvoiceSequenceStopped is the single shared "stopped" model.
      // Mode-scoped (reviewer fix #5): only the event mode's row can stop the
      // event — a live invoice's stopped state never suppresses a test event.
      const existingRow = db
        .query("SELECT * FROM invoices WHERE stripe_invoice_id = ? AND livemode = ?")
        .get(stripeInvoiceId, livemode) as Invoice | null;
      if (existingRow && isInvoiceSequenceStopped(existingRow)) {
        const stopped = existingRow.status === "paid"
          ? "paid"
          : existingRow.status === "void"
            ? "voided"
            : existingRow.status === "uncollectible"
              ? "uncollectible"
              : existingRow.dispute_id
                ? "disputed"
                : existingRow.refund_id
                  ? "refunded"
                  : existingRow.reply_opt_out_at
                    ? "opt-out"
                    : existingRow.reply_paused_at
                      ? "reply-paused"
                      : "manually-paused";
        console.log(
          `[watcher] stale ${event.type} for invoice ${stripeInvoiceId} skipped — invoice already ${stopped}`
        );
        return { action: `skipped stale ${event.type} for invoice ${stripeInvoiceId}: invoice already ${stopped}`, invoiceId: existingRow.id };
      }

      // Standard plan cap: an active Standard merchant may track at most 50
      // overdue invoices at once — per mode (reviewer fix #5: test rows never
      // count against the live cap). Capture the pre-existing overdue count
      // BEFORE the upsert below so the 50th invoice is still trackable and
      // the 51st is blocked (count >= 50 means 50 rows were already tracked).
      const limit = invoiceLimitFor(db, merchantId);
      const overdueBefore = limit !== null ? countOverdueInvoices(db, merchantId, livemode) : 0;

      const invoiceId = upsertInvoice(db, {
        stripe_invoice_id: stripeInvoiceId,
        merchant_id: merchantId,
        customer_name: customerName,
        customer_email: customerEmail,
        amount_cents: amountCents,
        currency,
        due_date: dueDate,
        status: "overdue",
        livemode,
      });
      const invoice = getInvoiceById(db, invoiceId);
      if (!invoice) {
        return { action: `invoice ${stripeInvoiceId} upserted but row read-back failed`, invoiceId };
      }

      // Shared task factory — the free-draft gate, Standard cap gate, stage
      // computation, auto-draft + reviewer verdict and Trust Mode auto-send
      // above all live in createTaskForOverdueInvoice so the scheduler's
      // invoice-sync and escalation-advance passes produce byte-identical
      // task semantics without duplicating any of this logic.
      const result = await createTaskForOverdueInvoice(db, invoice, { overdueBefore: limit !== null ? overdueBefore : 0 });
      return { action: result.action, invoiceId, taskId: result.taskId };
    }

    case "invoice.paid": {
      const inv = event.data.object;
      const stripeInvoiceId = inv.id;

      // Mode-scoped read (reviewer fix #5): only the event mode's row can be
      // marked paid — a live invoice.paid never flips a test row, and vice
      // versa. (Same id can't normally exist in both modes, but the guard is
      // the isolation contract itself.)
      const existing = db
        .query("SELECT * FROM invoices WHERE stripe_invoice_id = ? AND merchant_id = ? AND livemode = ?")
        .get(stripeInvoiceId, merchantId, livemode) as Invoice | null;

      if (existing) {
        // Admin telemetry (migration 020): record the recovery event — this
        // invoice was ever overdue and just got paid. Pure observation:
        // wrapped in try/catch so a telemetry failure can NEVER change the
        // payment notification / task-cancellation flow below, and idempotent
        // per invoice_id (INSERT OR IGNORE) so replayed events are no-ops.
        // Preferred paid timestamp: Stripe's status_transitions.paid_at (the
        // real payment time); fall back to event-received time.
        try {
          const paidAtUnix = (inv as { status_transitions?: { paid_at?: unknown } }).status_transitions?.paid_at;
          const paidAt =
            typeof paidAtUnix === "number"
              ? new Date(paidAtUnix * 1000).toISOString()
              : new Date().toISOString();
          const rec = recordRecoveryEvent(db, existing, { source: "webhook", paidAt });
          if (rec.recorded) {
            console.log(`[watcher] recovery event recorded for invoice ${stripeInvoiceId} (${rec.reason})`);
          }
        } catch (err) {
          console.error(
            `[watcher] recovery event record failed for ${stripeInvoiceId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
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

      const invoice = await resolveInvoiceForCharge(db, merchantId, chargeId, { amountCents: amount }, livemode);
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

      const invoice = await resolveInvoiceForCharge(db, merchantId, chargeId, { amountCents: amount }, livemode);
      if (!invoice) {
        console.log(`[webhook] charge.refunded ${refundId}: no local invoice matched (charge ${chargeId ?? "?"}, merchant ${merchantId}) — no action`);
        return { action: `refund ${refundId} not matched to a local invoice — no action` };
      }

      // Idempotency: a replayed charge.refunded for the same refund id must
      // not cancel again or write a second refund send_logs row. A genuinely
      // new refund (new id) stops the sequence again + logs again.
      if (invoice.refund_id === refundId) {
        return { action: `refund ${refundId} already handled for invoice ${invoice.stripe_invoice_id} — skipped (idempotent)` };
      }

      // Stop the sequence: cancel open tasks. No merchant notification
      // (homepage doesn't promise refund alerts) — but log it.
      cancelTasksForInvoice(db, invoice.id);
      db.run("UPDATE invoices SET refund_id=? WHERE id=?", [refundId, invoice.id]);
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
