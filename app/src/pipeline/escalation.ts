/**
 * Escalation ladder: determines which stage an overdue invoice is at
 * based on the number of days past due.
 *
 * Defaults (hardcoded ladder used by every merchant unless they set custom
 * Pro thresholds):
 *   Stage 1: 1–6 days  — friendly reminder
 *   Stage 2: 7–20 days — firmer follow-up
 *   Stage 3: 21+ days  — final notice
 *
 * Pro merchants may customize the boundaries via PUT /settings
 * (stage1_days / stage2_days); those values are validated so that
 * 1 <= stage1Max < stage2Max <= 90 and threaded through the watcher here.
 *
 * IMPORTANT: getEscalationStage answers "how overdue is this invoice", NOT
 * "which notice may we send". A 60-day-old invoice is stage 3 by age even
 * though its customer never received a single reminder — so every path that
 * CREATES a reminder task must go through resolveContactStage below, which
 * caps the stage by what was actually sent and paces the next notice.
 */
import type { Database } from "bun:sqlite";

export function getEscalationStage(daysOverdue: number, stage1Max = 6, stage2Max = 20): 1 | 2 | 3 {
  if (daysOverdue <= 0) {
    return 1; // treat current / future as stage 1
  }
  if (daysOverdue <= stage1Max) return 1;
  if (daysOverdue <= stage2Max) return 2;
  return 3;
}

export function getEscalationLabel(stage: number): string {
  switch (stage) {
    case 1: return "Friendly reminder";
    case 2: return "Follow-up";
    case 3: return "Final notice";
    default: return "Unknown";
  }
}

export function getStageLabel(stage: number): string {
  switch (stage) {
    case 1: return "Day 1 - friendly";
    case 2: return "Day 7 - firm";
    case 3: return "Day 14 - final notice";
    default: return "Reminder";
  }
}

export function getStageSubjectPrefix(stage: number): string {
  switch (stage) {
    case 1: return "Quick reminder";
    case 2: return "Following up";
    case 3: return "Final notice";
    default: return "Reminder";
  }
}

// ── Contact-history-aware stage (owner decision 2026-11-18) ──
//
// The defect this fixes (observed in production 2026-11-16): every one of
// merchant 12's eight first-ever drafts went out labelled stage 3 — "Final
// notice" — because the stage came from days-overdue alone. One customer
// received three "Final notice" emails plus a "Friendly reminder" inside four
// seconds. Copy that claims a notice the customer never received is misleading
// and costs the merchant credibility with their own customer.
//
// The rule: a draft may never claim a notice stage higher than the reminders
// actually SENT for that invoice (min(requested, sentCount + 1)), and the next
// notice must respect the ladder's own day gaps measured from the last
// successful send. One helper, used by the watcher, the escalation-advance pass
// and POST /tasks/resume, so all three agree.

const CONTACT_DAY_MS = 24 * 60 * 60 * 1000;

/** What has actually reached the customer for one invoice. */
export interface ContactHistory {
  /** send_logs rows with type='reminder' AND status='success' for this invoice. */
  sentCount: number;
  /** send_logs.created_at of the most recent such row ('YYYY-MM-DD HH:MM:SS' UTC). */
  lastSentAt: string | null;
  /** Stage of the task that carried that most recent successful send. */
  lastSentStage: number | null;
}

export function getContactHistory(db: Database, invoiceId: number): ContactHistory {
  const count = db
    .query(
      `SELECT COUNT(*) AS n FROM send_logs sl
         JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
        WHERE rt.invoice_id = ? AND sl.type = 'reminder' AND sl.status = 'success'`
    )
    .get(invoiceId) as { n: number } | null;
  const last = db
    .query(
      `SELECT rt.stage AS stage, sl.created_at AS at FROM send_logs sl
         JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
        WHERE rt.invoice_id = ? AND sl.type = 'reminder' AND sl.status = 'success'
        ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1`
    )
    .get(invoiceId) as { stage: number; at: string } | null;
  return {
    sentCount: count?.n ?? 0,
    lastSentAt: last?.at ?? null,
    lastSentStage: last?.stage ?? null,
  };
}

/**
 * Minimum days between one notice and the next, taken from the ladder's own
 * spacing (defaults stage1Max=6, stage2Max=20 → 6 days after notice 1,
 * 15 days after notice 2; Pro thresholds move both).
 */
export function noticeGapDays(noticeNumber: number, stage1Max = 6, stage2Max = 20): number {
  if (noticeNumber <= 1) return Math.max(1, stage1Max - 1 + 1);
  return Math.max(1, stage2Max - stage1Max + 1);
}

export interface StageDecision {
  /** The stage a task may actually be created at. */
  stage: number;
  /** The stage the caller asked for (override, or days-overdue). */
  requestedStage: number;
  sentCount: number;
  /** requestedStage was reduced because the customer never earned it. */
  capped: boolean;
  /** True = too soon after the last send; create nothing this pass. */
  paced: boolean;
  gapDays: number | null;
  /** ISO timestamp the next notice becomes eligible (paced decisions only). */
  nextEligibleAt: string | null;
  reason: string;
}

/**
 * Decide the stage a reminder task may be created at for one invoice.
 *
 * `requestedStage` is what the caller would send by ladder timing or by the
 * merchant's per-invoice override; the decision caps it at `sentCount + 1` and,
 * when the result is a NEW notice beyond the last one sent, checks that the
 * ladder's gap has elapsed since that send. A decision with `paced: true` means
 * the invoice must NOT be advanced this pass.
 *
 * A stage at or below the last sent stage is not a new notice (the caller's
 * idempotency / duplicate-send guards own that case), so it is never paced.
 */
export function resolveContactStage(
  db: Database,
  invoiceId: number,
  opts: { requestedStage: number; stage1Max?: number; stage2Max?: number; now?: Date }
): StageDecision {
  const now = opts.now ?? new Date();
  const stage1Max = opts.stage1Max ?? 6;
  const stage2Max = opts.stage2Max ?? 20;
  const requested = Math.min(3, Math.max(1, Math.round(opts.requestedStage)));
  const history = getContactHistory(db, invoiceId);

  const stage = Math.min(requested, history.sentCount + 1);
  const capped = stage < requested;
  const base = { stage, requestedStage: requested, sentCount: history.sentCount, capped };

  if (history.sentCount === 0 || history.lastSentAt === null) {
    // First contact: no notice to be paced against — it goes out as soon as the
    // invoice is overdue (as stage 1, whatever the invoice's age).
    return {
      ...base,
      paced: false,
      gapDays: null,
      nextEligibleAt: null,
      reason: capped
        ? `stage capped ${requested}→${stage}: no reminder has been sent for this invoice yet`
        : `stage ${stage}: first notice for this invoice`,
    };
  }

  const lastStage = history.lastSentStage ?? 0;
  if (stage <= lastStage) {
    return {
      ...base,
      paced: false,
      gapDays: null,
      nextEligibleAt: null,
      reason: `stage ${stage} is not beyond the last notice sent (stage ${lastStage})`,
    };
  }

  const gapDays = noticeGapDays(history.sentCount, stage1Max, stage2Max);
  const lastMs = Date.parse(history.lastSentAt.replace(" ", "T") + "Z");
  const nextEligibleMs = (Number.isNaN(lastMs) ? 0 : lastMs) + gapDays * CONTACT_DAY_MS;
  const paced = now.getTime() < nextEligibleMs;
  return {
    ...base,
    paced,
    gapDays,
    nextEligibleAt: new Date(nextEligibleMs).toISOString(),
    reason: paced
      ? `stage ${stage} paced: last notice sent ${history.lastSentAt} UTC, ${gapDays}-day ladder gap not elapsed until ${new Date(nextEligibleMs).toISOString()}`
      : `stage ${stage}: ${gapDays}-day gap since the last notice has elapsed`,
  };
}
