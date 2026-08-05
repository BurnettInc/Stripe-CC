import type { Database } from "bun:sqlite";
import { upsertInvoice, createReminderTask, cancelTasksForInvoice, ensureDefaultMerchant, resolveMerchant } from "../db";
import { getEscalationStage } from "./escalation";

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

/**
 * Handle an incoming Stripe webhook event.
 * Returns a summary of what was done.
 */
export function handleWebhookEvent(db: Database, event: WebhookEvent): { action: string; invoiceId?: number; taskId?: number } {
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
      const stage = getEscalationStage(daysOverdue);
      const taskId = createReminderTask(db, invoiceId, stage);

      return { action: `created reminder task for invoice ${stripeInvoiceId} at stage ${stage}`, invoiceId, taskId };
    }

    case "invoice.paid": {
      const inv = event.data.object;
      const stripeInvoiceId = inv.id;

      const existing = db
        .query("SELECT id FROM invoices WHERE stripe_invoice_id = ?")
        .get(stripeInvoiceId) as { id: number } | null;

      if (existing) {
        db.run("UPDATE invoices SET status='paid' WHERE id=?", [existing.id]);
        cancelTasksForInvoice(db, existing.id);
        return { action: `invoice ${stripeInvoiceId} marked paid, active tasks cancelled`, invoiceId: existing.id };
      }
      return { action: `invoice ${stripeInvoiceId} not found locally, no action taken` };
    }

    default:
      return { action: `event type '${event.type}' not handled` };
  }
}
