import type { Database } from "bun:sqlite";
import { getInvoiceById, getMerchantById, isActiveProSubscriber, type Invoice } from "../db";
import { getLateFeeText } from "./late-fee";
import { reviewDraft } from "./reviewer";
import { customerCanPayFrom, type CustomerCanPay } from "./payability";

/**
 * Stranded-draft visibility (2026-11-06).
 *
 * THE GAP: Trust Mode only auto-sends at DRAFT CREATION time (watcher
 * createTaskForOverdueInvoice). So a stage-1 reminder drafted while the
 * merchant was in Draft Mode stays 'reviewed' forever after the merchant flips
 * to Semi-Auto / Copilot Mode — Semi-Auto never retroactively sends it, and
 * nothing in the product told the merchant it was sendable. Live case:
 * merchant 11's $27.00 stage-1 draft (reminder_task 72) sat in 'reviewed' with
 * nothing anywhere saying it was ready.
 *
 * THIS MODULE ADDS NO SEND PATH. It is a READ-ONLY derived flag, computed at
 * read time (no DB column, no migration), so it can never change what Semi-Auto
 * sends at creation, and the send-time guards (/approve 402/409, the reviewer
 * gates) keep working exactly as they do.
 *
 * The reviewer's rules are NOT re-implemented here: readiness calls the same
 * reviewDraft() the watcher calls, with the same late-fee input, so a draft can
 * never be marked "ready" while the gate that guards the send would reject it.
 */

export type TrustMode = "draft" | "semi" | "full";

export interface DraftReadiness {
  /** Reviewed draft the merchant can send right now: mode is Semi-Auto or
   *  Copilot Mode, the invoice is still overdue, and the reviewer passes. */
  ready_to_send: boolean;
  /** Ready AND the merchant's CURRENT mode would have sent this draft
   *  automatically at creation (semi → stage 1, full → any stage). This is the
   *  stranded case: the only reason it is sitting there is that it was written
   *  before the mode change, so the UI explains exactly that. */
  stranded: boolean;
  /** Mode is semi/full and the invoice is still overdue, but the reviewer
   *  rejects the stored draft — needs a human fix before it can send. */
  needs_attention: boolean;
  /** Reviewer gate failures (empty when the draft passes). */
  issues: string[];
  /** Trust mode actually in force for this invoice (override, with the same
   *  non-Pro 'full' → 'semi' demotion the watcher applies). */
  effective_mode: TrustMode;
}

/** The task fields readiness needs (a reminder_tasks row). */
export interface ReadinessTask {
  stage: number;
  status: string;
  draft_subject?: string | null;
  draft_body?: string | null;
}

function asMode(value: string | null | undefined): TrustMode {
  return value === "semi" || value === "full" ? value : "draft";
}

/**
 * The trust mode in force for an invoice: the per-invoice override wins over
 * the merchant setting, and a stored 'full' on a merchant that is not active
 * Pro is demoted to 'semi' — exactly the watcher's auto-send derivation.
 */
export function effectiveTrustMode(
  db: Database,
  invoice: Invoice,
  merchantTrustMode: string | null | undefined,
): TrustMode {
  const stored = asMode(invoice.trust_mode_override ?? merchantTrustMode);
  if (stored === "full" && !isActiveProSubscriber(db, invoice.merchant_id)) return "semi";
  return stored;
}

/**
 * Derive the readiness of one reviewed draft. Returns null when the question
 * does not apply — the task is not 'reviewed' (nothing is waiting on a human)
 * or it carries no usable draft body.
 */
export function assessDraftReadiness(
  db: Database,
  task: ReadinessTask,
  invoice: Invoice,
  merchantTrustMode: string | null | undefined,
): DraftReadiness | null {
  if (!task || task.status !== "reviewed") return null;
  const subject = task.draft_subject ?? "";
  const body = task.draft_body ?? "";
  if (body.trim() === "") return null;

  const mode = effectiveTrustMode(db, invoice, merchantTrustMode);
  const modeAutoSends = mode === "semi" || mode === "full";
  const stillOverdue = invoice.status === "overdue";

  // Same gate, same inputs as the watcher's draft-time review — never a second
  // copy of the rules.
  const review = reviewDraft({ subject, body }, invoice, {
    lateFeeText: getLateFeeText(db, invoice.merchant_id, invoice, task.stage),
  });

  const ready = modeAutoSends && stillOverdue && review.approved;
  const needsAttention = modeAutoSends && stillOverdue && !review.approved;
  // The watcher's rule for "this would have gone out on its own today".
  const autoSendsAtCreation = mode === "full" || (mode === "semi" && task.stage === 1);

  return {
    ready_to_send: ready,
    stranded: ready && autoSendsAtCreation,
    needs_attention: needsAttention,
    issues: review.approved ? [] : review.issues,
    effective_mode: mode,
  };
}

/**
 * Annotate task-inbox rows (getAllTasks output) with `draft_readiness`.
 * One invoice lookup + one readiness computation per row; merchants have a
 * handful of open tasks, and the result is never persisted.
 *
 * Also carries `customer_can_pay` — 'yes' | 'no' | 'unknown', read straight
 * from the invoice's stored payability verdict (migration 036, 2026-11-09:
 * "the customer cannot pay this invoice" signal). Read-only like everything
 * else here: it explains what the customer will see when they click the
 * payment link, and it gates nothing.
 */
export function annotateTaskReadiness<T extends Record<string, unknown>>(
  db: Database,
  merchantId: number,
  rows: T[],
): Array<T & { draft_readiness: DraftReadiness | null; customer_can_pay: CustomerCanPay }> {
  const merchant = getMerchantById(db, merchantId);
  const merchantTrustMode = (merchant?.trust_mode as string | undefined) ?? "draft";
  const invoiceCache = new Map<number, Invoice | null>();

  return rows.map((row) => {
    const invoiceId = Number(row.invoice_id);
    if (!invoiceCache.has(invoiceId)) {
      invoiceCache.set(invoiceId, getInvoiceById(db, invoiceId) as Invoice | null);
    }
    const invoice = invoiceCache.get(invoiceId) ?? null;
    const readiness = invoice
      ? assessDraftReadiness(
          db,
          {
            stage: Number(row.stage),
            status: String(row.status ?? ""),
            draft_subject: (row.draft_subject as string | null) ?? null,
            draft_body: (row.draft_body as string | null) ?? null,
          },
          invoice,
          merchantTrustMode,
        )
      : null;
    return { ...row, draft_readiness: readiness, customer_can_pay: customerCanPayFrom(invoice?.payability) };
  });
}

export interface ReadyDraftCounts {
  /** Reviewed drafts the merchant could send right now. */
  ready: number;
  /** Of those, the ones the current mode would have auto-sent at creation. */
  stranded: number;
  /** Reviewed drafts a gate rejects (shown as needing attention). */
  needs_attention: number;
}

/**
 * Count the reviewed drafts for a merchant in one Stripe mode. Used by
 * /copilot-controls so a merchant who just flipped modes sees what is waiting.
 * Read-only; scoped by livemode like every other merchant-facing read.
 */
export function countReadyDrafts(db: Database, merchantId: number, livemode = 1): ReadyDraftCounts {
  const rows = db
    .query(
      `SELECT rt.invoice_id, rt.stage, rt.status, rt.draft_subject, rt.draft_body
         FROM reminder_tasks rt
         JOIN invoices i ON rt.invoice_id = i.id
        WHERE i.merchant_id = ? AND i.livemode = ?
          AND rt.status = 'reviewed' AND i.status = 'overdue'`,
    )
    .all(merchantId, livemode === 0 ? 0 : 1) as Array<Record<string, unknown>>;

  const annotated = annotateTaskReadiness(db, merchantId, rows);
  const counts: ReadyDraftCounts = { ready: 0, stranded: 0, needs_attention: 0 };
  for (const row of annotated) {
    const r = row.draft_readiness;
    if (!r) continue;
    if (r.ready_to_send) counts.ready++;
    if (r.stranded) counts.stranded++;
    if (r.needs_attention) counts.needs_attention++;
  }
  return counts;
}
