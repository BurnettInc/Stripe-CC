import type { Database } from "bun:sqlite";
import type { Invoice, ReminderTask } from "../db";
import { getMerchantById } from "../db";
import { getEscalationStage } from "../pipeline/escalation";
import { draftEmail } from "../pipeline/drafter";
import { reviewDraft } from "../pipeline/reviewer";
import { getLateFeeText } from "../pipeline/late-fee";
import { requestLivemode } from "../middleware/mode";

const jsonHeaders = { "Content-Type": "application/json" };
const modes = ["draft", "semi", "full"];
const STAGE_OVERRIDES = [1, 2, 3];

function resolveInvoice(db: Database, rawId: string, livemode: number) {
  const numericId = Number(rawId);
  if (Number.isInteger(numericId) && numericId > 0) {
    const byId = db.query("SELECT * FROM invoices WHERE id=? AND livemode=?").get(numericId, livemode);
    if (byId) return byId as Record<string, unknown>;
  }
  return db.query("SELECT * FROM invoices WHERE stripe_invoice_id=? AND livemode=?").get(rawId, livemode) as Record<string, unknown> | null;
}

function notFound() { return new Response(JSON.stringify({ error: "Invoice not found" }), { status: 404, headers: jsonHeaders }); }

export async function handleInvoices(db: Database, req: Request, rawPath: string, merchantId: number): Promise<Response> {
  const match = rawPath.match(/^\/([^/]+)(?:\/(trust-mode|stage))?$/);
  if (!match) return notFound();
  const rawId = decodeURIComponent(match[1]);
  const action = match[2] ?? "";
  const isTrustMode = action === "trust-mode";
  const livemode = requestLivemode(req);
  const invoice = resolveInvoice(db, rawId, livemode);
  if (!invoice || invoice.merchant_id !== merchantId) return notFound();
  const id = invoice.id as number;

  // ── Manual escalation-stage override (migration 031) ──
  // PUT /invoices/:id/stage  { stage: 1|2|3 | 0 | null | "" }
  //   - 1|2|3  → set a manual override (pins the invoice's stage)
  //   - 0 / null / ""  → clear it (restore automatic days-overdue progression)
  // Resolves the invoice by identity scoped to the authenticated merchant but
  // NOT livemode (the /past-due page, the only UI for this feature, lists the
  // merchant's invoices across both Stripe modes — see handlePastDuePage).
  // Reconciles the invoice's current OPEN task so the override takes effect on
  // the very next reminder: the open task's stage + draft content are
  // re-drafted at the new effective stage (no immediate send, no free-draft
  // consumption, no cancel → a Full-Auto merchant is never surprised by a send
  // just from setting an override).
  if (action === "stage") {
    if (req.method !== "PUT") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
    }
    let rawStage: unknown;
    try {
      const body = await req.json() as { stage?: unknown };
      rawStage = body.stage;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: jsonHeaders });
    }
    let override: number | null = null;
    let invalid = false;
    if (rawStage === null || rawStage === undefined || rawStage === "" || rawStage === 0) {
      override = null; // Auto
    } else if (typeof rawStage === "string") {
      const n = Number(rawStage);
      if (STAGE_OVERRIDES.includes(n)) override = n;
      else invalid = true;
    } else if (typeof rawStage === "number") {
      if (STAGE_OVERRIDES.includes(rawStage)) override = rawStage;
      else invalid = true;
    } else {
      invalid = true;
    }
    if (invalid) {
      return new Response(JSON.stringify({ error: "stage must be Auto (0/null), Stage 1, 2, or 3" }), { status: 400, headers: jsonHeaders });
    }

    db.run("UPDATE invoices SET stage_override=? WHERE id=?", [override, id]);

    // Recompute the invoice's new effective stage: the override wins when set,
    // otherwise the automatic days-overdue stage (merchant timing ladder).
    const dueDate = String(invoice.due_date ?? "");
    const timing = db.query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?").get(merchantId) as { stage1_days: number; stage2_days: number } | null;
    const daysOverdue = dueDate
      ? Math.max(0, Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)))
      : 0;
    const effective = override ?? getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);

    // Reconcile the invoice's open (not yet sent/cancelled) task so the very
    // next reminder carries the new effective stage + matching draft content.
    let taskReconciled = false;
    const open = db.query(
      "SELECT * FROM reminder_tasks WHERE invoice_id=? AND status IN ('pending','drafted','reviewed') ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(id) as ReminderTask | null;
    if (open) {
      try {
        const adjustedTask = { ...open, stage: effective } as ReminderTask;
        const draft = await draftEmail(adjustedTask, invoice as unknown as Invoice, getMerchantById(db, merchantId)?.email, db);
        const review = reviewDraft(draft, invoice as unknown as Invoice, {
          lateFeeText: getLateFeeText(db, merchantId, invoice as unknown as Invoice, effective),
        });
        db.run(
          "UPDATE reminder_tasks SET stage=?, draft_subject=?, draft_body=?, reviewer_notes=?, status='reviewed' WHERE id=?",
          [effective, draft.subject, draft.body, JSON.stringify(review), open.id]
        );
        taskReconciled = true;
      } catch (err: unknown) {
        // Best-effort: if re-drafting/reviewing fails, still move the task to
        // the new effective stage so the override is honored on the next send
        // (content stays at the prior stage's draft — never fail the request).
        console.warn(`[invoices] stage-override draft/review failed for task ${open.id}: ${err instanceof Error ? err.message : String(err)} — task stage updated only`);
        db.run("UPDATE reminder_tasks SET stage=? WHERE id=?", [effective, open.id]);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      invoice_id: id,
      stage_override: override,
      is_overridden: override !== null,
      effective_stage: effective,
      task_reconciled: taskReconciled,
    }), { headers: jsonHeaders });
  }

  if (!isTrustMode && req.method === "GET") {
    const task = db.query("SELECT * FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(id) as Record<string, unknown> | null;
    const sent = db.query("SELECT COUNT(*) as count, MAX(created_at) as last_send_date FROM send_logs WHERE reminder_task_id=? AND type='reminder' AND status='success'").get((task?.id as number | undefined) ?? -1) as { count: number; last_send_date: string | null };
    // Paused reflects BOTH a parked task (status 'paused') and the invoice's
    // pause flags (reply_paused_at from a customer reply, manually_paused_at
    // from the drawer's Pause button) so the drawer detail view shows the true
    // state even when the pause left no open task (reply pause cancels tasks).
    const invoicePaused = !!invoice.reply_paused_at || !!invoice.manually_paused_at;
    const taskPaused = task?.status === "paused";
    const sequenceStatus = task ? { emails_sent: sent.count, last_send_date: sent.last_send_date, next_scheduled: null, active: !["cancelled", "paused"].includes(String(task.status)) && !invoicePaused, paused: taskPaused || invoicePaused, stage: task.stage, status: task.status } : null;
    // Alias keys the Stripe App InvoiceDetailView reads (DASHBOARD_AUDIT #40).
    // The view renders "Amount unavailable" / "Unknown" / "Not available"
    // without them, and displays id as the invoice number. Original keys stay
    // untouched so the response remains backward-compatible.
    const amountCents = invoice.amount_cents as number;
    const dueDate = String(invoice.due_date ?? "");
    const daysOverdue = dueDate
      ? Math.max(0, Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)))
      : null;
    const timing = db.query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?").get(merchantId) as { stage1_days: number; stage2_days: number } | null;
    const override = (invoice.stage_override as number | null) ?? null;
    const autoStage = daysOverdue === null ? null : getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);
    const escalationStage = sequenceStatus?.stage ?? autoStage;
    return new Response(JSON.stringify({
      ...invoice,
      sequence_status: sequenceStatus,
      amount_due: amountCents,
      days_overdue: daysOverdue,
      escalation_stage: escalationStage,
      stage_override: override,
      is_overridden: override !== null,
      invoice_number: (invoice.stripe_invoice_id as string) || `invoice-${id}`,
    }), { headers: jsonHeaders });
  }

  if (isTrustMode && req.method === "GET") {
    return new Response(JSON.stringify({ trust_mode: invoice.trust_mode_override ?? null }), { headers: jsonHeaders });
  }

  if (isTrustMode && req.method === "PUT") {
    let body: { trust_mode?: string | null };
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: jsonHeaders }); }
    if (body.trust_mode !== null && !modes.includes(body.trust_mode ?? "")) {
      return new Response(JSON.stringify({ error: "trust_mode must be draft, semi, full, or null" }), { status: 400, headers: jsonHeaders });
    }
    db.run("UPDATE invoices SET trust_mode_override=? WHERE id=?", [body.trust_mode ?? null, id]);
    return new Response(JSON.stringify({ trust_mode: body.trust_mode ?? null }), { headers: jsonHeaders });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
}
