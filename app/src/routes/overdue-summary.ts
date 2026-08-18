import type { Database } from "bun:sqlite";
import { corsHeadersFor } from "../middleware/cors";
import { requestLivemode } from "../middleware/mode";
import { getEscalationStage } from "../pipeline/escalation";

/**
 * GET /overdue/summary — JSON summary for the Stripe App drawer's
 * OverviewView. Session-authenticated (index.ts enforces requireSession before
 * calling); this handler returns the CORS headers itself on every response
 * because the drawer fetches from inside a sandboxed iframe (Origin: null).
 *
 * Response shape (the drawer consumes it as-is):
 * {
 *   counts: { total, active, paused, awaiting_approval },
 *   invoices: up to 20 rows, sorted by days overdue desc:
 *     { id, stripe_invoice_id, customer_name, amount_due (cents), currency,
 *       days_overdue, stage, status: 'active'|'paused'|'awaiting_approval',
 *       pause_reason: 'manual'|'reply'|null },
 *   recent_reminders: up to 5 most recent successful reminder sends:
 *     { invoice_id, customer_name, amount_due (cents), currency, stage, sent_at }
 * }
 *
 * Status derivation mirrors the watcher's model:
 * - base set: invoices.status='overdue' AND not disputed/refunded/opted-out
 *   (paid/void are never 'overdue').
 * - paused: manually_paused_at OR reply_paused_at OR the invoice's most recent
 *   task is 'paused' (the drawer's Pause button parks open tasks as 'paused').
 * - awaiting_approval: most recent task is 'drafted' or 'reviewed'.
 * - active: most recent task is 'pending', or there is NO task yet (the
 *   watcher will create one on the next event), or the most recent task is
 *   'cancelled' — the watcher treats a cancelled task as nothing in flight, so
 *   the invoice is "active again" unless a pause flag is set.
 * - sent: an invoice whose most recent task is 'sent' is still being chased
 *   (next escalation event replaces the sent task) but has nothing pending in
 *   the inbox — the row is listed as 'active' so the merchant can still pause
 *   it, but it is excluded from counts.active (which counts actionable
 *   invoices only), keeping the chips aligned with the spec.
 */

interface InvoiceRow {
  id: number;
  stripe_invoice_id: string;
  customer_name: string;
  customer_email: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  status: string;
  manually_paused_at: string | null;
  reply_paused_at: string | null;
  reply_opt_out_at: string | null;
  dispute_id: string | null;
  refund_id: string | null;
}

type InvoiceStatus = "active" | "paused" | "awaiting_approval";
type PauseReason = "manual" | "reply" | null;

export function handleOverdueSummary(db: Database, merchantId: number, req: Request): Response {
  const livemode = requestLivemode(req);
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
    });

  const invoices = db.query(`
    SELECT id, stripe_invoice_id, customer_name, customer_email, amount_cents, currency,
           due_date, status, manually_paused_at, reply_paused_at, reply_opt_out_at,
           dispute_id, refund_id
    FROM invoices
    WHERE merchant_id=? AND status='overdue' AND livemode=?
      AND dispute_id IS NULL AND refund_id IS NULL AND reply_opt_out_at IS NULL
  `).all(merchantId, livemode) as InvoiceRow[];

  const timing = db.query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?")
    .get(merchantId) as { stage1_days: number; stage2_days: number } | null;

  // Most recent task per invoice (mirrors getTaskForInvoice's ordering).
  const taskRows = db.query(`
    SELECT invoice_id, stage, status FROM reminder_tasks
    WHERE invoice_id IN (SELECT id FROM invoices WHERE merchant_id=? AND livemode=?)
    ORDER BY created_at DESC, id DESC
  `).all(merchantId, livemode) as Array<{ invoice_id: number; stage: number; status: string }>;
  const latestTaskByInvoice = new Map<number, { stage: number; status: string }>();
  for (const t of taskRows) {
    if (!latestTaskByInvoice.has(t.invoice_id)) latestTaskByInvoice.set(t.invoice_id, t);
  }

  const now = Date.now();
  const rows = invoices.map((inv) => {
    const daysOverdue = Math.max(
      0,
      Math.floor((now - new Date(inv.due_date).getTime()) / (1000 * 60 * 60 * 24)),
    );
    const stage = getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);
    const task = latestTaskByInvoice.get(inv.id);
    const taskStatus = task?.status ?? null;
    const flagsPaused = !!inv.manually_paused_at || !!inv.reply_paused_at;
    let status: InvoiceStatus;
    let pause_reason: PauseReason = null;
    let sentTask = false;
    if (flagsPaused || taskStatus === "paused") {
      status = "paused";
      if (inv.manually_paused_at) pause_reason = "manual";
      else if (inv.reply_paused_at) pause_reason = "reply";
    } else if (taskStatus === "drafted" || taskStatus === "reviewed") {
      status = "awaiting_approval";
    } else if (taskStatus === "sent") {
      // Reminder already sent; next escalation event replaces the task. Still
      // listed (merchant can pause) but not counted in counts.active.
      sentTask = true;
      status = "active";
    } else {
      // 'pending' task, no task yet, or 'cancelled' (active-again).
      status = "active";
    }
    return { inv, daysOverdue, stage, status, pause_reason, sentTask };
  });

  rows.sort((a, b) => b.daysOverdue - a.daysOverdue || b.inv.id - a.inv.id);

  const invoicesOut = rows.slice(0, 20).map((r) => ({
    id: r.inv.id,
    stripe_invoice_id: r.inv.stripe_invoice_id,
    customer_name: r.inv.customer_name,
    amount_due: r.inv.amount_cents,
    currency: r.inv.currency,
    days_overdue: r.daysOverdue,
    stage: r.stage,
    status: r.status,
    pause_reason: r.pause_reason,
  }));

  const counts = {
    total: rows.length,
    active: rows.filter((r) => r.status === "active" && !r.sentTask).length,
    paused: rows.filter((r) => r.status === "paused").length,
    awaiting_approval: rows.filter((r) => r.status === "awaiting_approval").length,
  };

  const recentRows = db.query(`
    SELECT sl.created_at AS sent_at, rt.stage, i.id AS invoice_id, i.customer_name,
           i.amount_cents, i.currency
    FROM send_logs sl
    JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
    JOIN invoices i ON rt.invoice_id = i.id
    WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=? AND i.livemode=?
    ORDER BY sl.id DESC
    LIMIT 5
  `).all(merchantId) as Array<{
    sent_at: string; stage: number; invoice_id: number; customer_name: string;
    amount_cents: number; currency: string;
  }>;

  const recent_reminders = recentRows.map((r) => ({
    invoice_id: r.invoice_id,
    customer_name: r.customer_name,
    amount_due: r.amount_cents,
    currency: r.currency,
    stage: r.stage,
    sent_at: r.sent_at,
  }));

  return respond(200, { counts, invoices: invoicesOut, recent_reminders });
}
