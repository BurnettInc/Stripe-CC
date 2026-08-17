/**
 * In-process scheduler / continuous-sync engine (PROMISES_AUDIT #10/#12/#24/
 * #26/#29/#42 — the "automatic escalating chase" build).
 *
 * Before this module the app had NO scheduler, poller, or timed trigger
 * anywhere: everything "automatic" ran only on Stripe webhooks, and Stripe
 * does NOT emit invoice.overdue for one-off invoices — so overdue one-off
 * invoices appeared on the dashboard but were never followed up, the
 * escalation ladder (1–6 / 7–20 / 21+ days) was computed once at task
 * creation and never advanced, weekly recovery reports were never sent, and
 * the 30-day deletion clock had no consumer.
 *
 * Four guarded passes, started at server boot (Bun setInterval — Railway runs
 * one Bun service; no external cron):
 *
 *   1. INVOICE SYNC PASS (default every 15 min) — for each connected merchant
 *      (stripe_connections mirror, not disconnected, no deletion clock):
 *      refresh the OAuth access token when expired, pull invoices (reuses
 *      syncMerchantInvoices), propagate status changes (paid → close +
 *      one-time payment notification, void/uncollectible/draft → stop open
 *      sequences — matching the watcher's close/stop semantics), and CREATE
 *      TASKS for newly-overdue invoices through the shared watcher factory
 *      (createTaskForOverdueInvoice), so the escalation pipeline actually
 *      fires for one-off invoices. An HTTP 401 from the pull means the stored
 *      token pair is dead → mark the merchant disconnected and cancel open
 *      sequences (mirrors account.application.deauthorized).
 *   2. ESCALATION ADVANCE PASS (default daily) — re-evaluate every overdue
 *      invoice's stage by days-overdue against the merchant's ladder timing
 *      (default 1–6 / 7–20 / 21+; Pro custom stage1_days/stage2_days) and
 *      advance when a threshold is crossed, honoring the same task rules
 *      (free-draft allowance, Trust Mode auto-send, stopped-sequence guard).
 *   3. WEEKLY SUMMARY PASS (default daily, per-merchant 7-day cadence) —
 *      reuse the existing summary generation + paid-gated send for merchants
 *      with a real email on a paid plan; each merchant is sent at most once
 *      per 7 days (summary_sends ledger — send_logs rows for summaries carry
 *      reminder_task_id NULL, so they can't be attributed to a merchant).
 *   4. DAILY PURGE PASS (default daily) — merchants whose
 *      deletion_scheduled_at has passed are purged via purgeMerchantData
 *      (idempotent, transactional); log counts.
 *
 * Every pass is factored as a pure-ish (db, deps) function — deps.now() and
 * deps.log() are injectable so tests drive the passes with seeded data and
 * fake clocks; NO real timers are used in tests. Overlap guard: each pass is
 * single-flight (a tick is skipped while the previous run of the same pass is
 * still going — startScheduler wraps every pass in singleFlightPass).
 *
 * Env config (all optional, sane defaults):
 *   SCHEDULER_ENABLED                 — "0"/"false" disables boot wiring entirely
 *   SCHEDULER_SYNC_INTERVAL_MS        — 900000  (15 min)
 *   SCHEDULER_SYNC_INITIAL_DELAY_MS   — 30000   (first sync tick after boot)
 *   SCHEDULER_START_DELAY_MS          — 60000   (first tick of the daily passes)
 *   SCHEDULER_ADVANCE_INTERVAL_MS     — 86400000 (24 h)
 *   SCHEDULER_SUMMARY_INTERVAL_MS     — 86400000 (24 h)
 *   SCHEDULER_PURGE_INTERVAL_MS       — 86400000 (24 h)
 */
import type { Database } from "bun:sqlite";
import { syncMerchantInvoices } from "../routes/oauth-app-install";
import { createTaskForOverdueInvoice } from "./watcher";
import { generateWeeklySummary } from "./summary";
import { formatSummaryEmail } from "./summary-email";
import { sendEmailForReal } from "./sender";
import { isPlaceholderMerchant, notifyMerchant } from "./notify";
import { getEscalationStage } from "./escalation";
import {
  cancelTasksForInvoice,
  logSend,
  purgeMerchantData,
  invoiceLimitFor,
  freeDraftsRemaining,
  isActivePaidSubscriber,
  isInvoiceSequenceStopped,
  getTaskForInvoice,
} from "../db";
import type { Invoice, Merchant, ReminderTask } from "../db";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_CADENCE_MS = 7 * DAY_MS;

/** SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC) — same format datetime('now')
 * writes, so string comparisons against stored timestamps are correct. */
function sqliteDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function formatMoney(cents: number, currency: string): string {
  const value = (cents / 100).toFixed(2);
  return currency === "usd" ? `$${value}` : `${currency.toUpperCase()} ${value}`;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface SchedulerDeps {
  /** Injectable clock — tests drive passes with fake dates. Defaults to new Date(). */
  now?: () => Date;
  /** Injectable logger (structured [scheduler] lines). Defaults to console.log. */
  log?: (msg: string) => void;
  /** Injectable invoice pull — defaults to syncMerchantInvoices. Tests stub the
   * 401 path here instead of hitting the network. */
  syncInvoices?: (
    db: Database,
    merchantId: number,
  ) => Promise<{ inserted: number; synced: boolean; reason?: string }>;
}

// ── Single-flight overlap guard ──

/**
 * Wrap a pass so a tick is SKIPPED while the previous run of the same pass is
 * still in flight. `run` must never reject (passes catch internally); a throw
 * is still swallowed and logged so one bad tick can never kill the loop.
 */
export function singleFlightPass(
  passName: string,
  run: () => Promise<unknown>,
  log: (msg: string) => void = console.log,
): () => Promise<{ skipped: boolean }> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      log(`[scheduler] ${passName} pass SKIPPED — previous run still in flight`);
      return { skipped: true };
    }
    inFlight = true;
    const started = Date.now();
    try {
      await run();
      return { skipped: false };
    } catch (err) {
      log(`[scheduler] ${passName} pass FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return { skipped: false };
    } finally {
      inFlight = false;
      log(`[scheduler] ${passName} pass done (${Date.now() - started}ms)`);
    }
  };
}

// ── Shared helpers ──

function countTrackedOverdue(db: Database, merchantId: number): number {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT i.id) AS n FROM invoices i
       JOIN reminder_tasks rt ON rt.invoice_id = i.id
       WHERE i.merchant_id = ? AND i.status = 'overdue'`
    )
    .get(merchantId) as { n: number };
  return row.n;
}

/** Mark a merchant disconnected + cancel open sequences — the exact semantics
 * of watcher's account.application.deauthorized handler (a dead token pair is
 * equivalent to a deauthorized account). */
function markDisconnected(db: Database, merchantId: number): void {
  db.run("UPDATE merchants SET disconnected=1 WHERE id=?", [merchantId]);
  db.run(
    `UPDATE reminder_tasks SET status='cancelled'
     WHERE status IN ('pending','drafted','reviewed')
       AND invoice_id IN (SELECT id FROM invoices WHERE merchant_id=?)`,
    [merchantId]
  );
}

/**
 * Status propagation for one sync run: an invoice that transitioned to
 * 'paid' or 'void' since the previous sync gets the same close/stop
 * treatment the watcher applies on invoice.paid (cancel tasks + one-time
 * payment-received notification) and the void analog (cancel open tasks +
 * log). Detected by diffing the pre-sync snapshot against the post-sync rows,
 * so a missed webhook is recovered — the stale local state can no longer
 * keep a sequence alive forever (PROMISES_AUDIT #9).
 */
function reconcileInvoiceStatuses(
  db: Database,
  merchantId: number,
  before: Map<string, { status: string; id: number }>,
  log: (m: string) => void,
): void {
  const after = db
    .query(
      "SELECT id, stripe_invoice_id, status, paid_notified, customer_name, amount_cents, currency FROM invoices WHERE merchant_id=?"
    )
    .all(merchantId) as Array<{
      id: number;
      stripe_invoice_id: string;
      status: string;
      paid_notified: number;
      customer_name: string;
      amount_cents: number;
      currency: string;
    }>;
  for (const row of after) {
    const prev = before.get(row.stripe_invoice_id);
    if (!prev || prev.status === row.status) continue;

    if (row.status === "paid") {
      // Mirror watcher's invoice.paid handler: only notify when the invoice
      // was actually followed up (a task existed in flight), once per invoice
      // (paid_notified guard).
      const followed = db
        .query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=? AND status IN ('pending','drafted','reviewed','sent')")
        .get(row.id) as { n: number };
      cancelTasksForInvoice(db, row.id);
      if (followed.n > 0 && !row.paid_notified) {
        db.run("UPDATE invoices SET paid_notified=1 WHERE id=?", [row.id]);
        const money = formatMoney(row.amount_cents, row.currency);
        // notifyMerchant is fully guarded and never throws; fire-and-forget is
        // safe and keeps the sync pass non-blocking on email delivery.
        void notifyMerchant(
          db,
          merchantId,
          `Payment received — invoice ${row.stripe_invoice_id}`,
          `Payment received — invoice ${row.stripe_invoice_id} (${money}) from ${row.customer_name}. We've stopped reminders for it.`
        );
        log(`[scheduler] invoice-sync: invoice ${row.stripe_invoice_id} became paid — sequence closed, payment-received notification sent`);
      } else {
        log(`[scheduler] invoice-sync: invoice ${row.stripe_invoice_id} became paid — sequence closed${followed.n > 0 ? "" : " (never followed up)"}`);
      }
    } else if (row.status === "void") {
      // Void / uncollectible / draft in Stripe = the debt is no longer active:
      // stop open sequences (the void analog of watcher's close/stop paths).
      const cancelled = db
        .run(
          "UPDATE reminder_tasks SET status='cancelled' WHERE invoice_id=? AND status IN ('pending','drafted','reviewed')",
          [row.id]
        ).changes;
      if (cancelled > 0) {
        logSend(db, 0, "success", `Invoice ${row.stripe_invoice_id} voided in Stripe — stopped ${cancelled} open sequence(s)`, "disconnect");
        log(`[scheduler] invoice-sync: invoice ${row.stripe_invoice_id} became void — ${cancelled} open sequence(s) stopped`);
      } else {
        log(`[scheduler] invoice-sync: invoice ${row.stripe_invoice_id} became void (no open sequences)`);
      }
    }
  }
}

// ── Pass 1: invoice sync ──

export interface InvoiceSyncPassResult {
  merchants: number;
  invoicesUpserted: number;
  tasksCreated: number;
  blocked: { standardLimit: number; freeDraftLimit: number; stopped: number };
  disconnected: string[];
  errors: string[];
}

/**
 * Pull invoices for every connected merchant and reconcile local state:
 * upsert (idempotent), propagate paid/void transitions, and create tasks for
 * newly-overdue invoices (Standard cap + blocked-resume, free-draft allowance,
 * Trust Mode via the shared watcher factory). HTTP 401 → mark disconnected.
 */
export async function runInvoiceSyncPass(db: Database, deps: SchedulerDeps = {}): Promise<InvoiceSyncPassResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const syncInvoices = deps.syncInvoices ?? syncMerchantInvoices;
  const result: InvoiceSyncPassResult = {
    merchants: 0,
    invoicesUpserted: 0,
    tasksCreated: 0,
    blocked: { standardLimit: 0, freeDraftLimit: 0, stopped: 0 },
    disconnected: [],
    errors: [],
  };

  // Connected merchants: real Stripe accounts (never the acct_default
  // placeholder), with a stored connection mirror, not already disconnected,
  // and not on the deletion clock.
  const merchants = db
    .query(
      `SELECT m.id FROM merchants m
       WHERE m.stripe_account_id != 'acct_default'
         AND m.disconnected = 0
         AND m.deletion_scheduled_at IS NULL
         AND EXISTS (SELECT 1 FROM stripe_connections sc WHERE sc.merchant_id = m.id)
       ORDER BY m.id ASC`
    )
    .all() as { id: number }[];

  for (const { id: merchantId } of merchants) {
    result.merchants++;
    // Pre-sync snapshot for paid/void transition detection.
    const before = new Map<string, { status: string; id: number }>();
    for (const row of db.query("SELECT id, stripe_invoice_id, status FROM invoices WHERE merchant_id=?").all(merchantId) as {
      id: number;
      stripe_invoice_id: string;
      status: string;
    }[]) {
      before.set(row.stripe_invoice_id, row);
    }

    const sync = await syncInvoices(db, merchantId);
    result.invoicesUpserted += sync.inserted || 0;

    if (!sync.synced && sync.reason === "disconnected") continue;

    // Dead token pair (HTTP 401 — platform_api_key_expired): mirror
    // application.deauthorized semantics — mark disconnected + stop sequences.
    if (!sync.synced || (sync.reason ?? "").includes("HTTP 401")) {
      if ((sync.reason ?? "").includes("HTTP 401")) {
        markDisconnected(db, merchantId);
        result.disconnected.push(String(merchantId));
        log(`[scheduler] invoice-sync: merchant ${merchantId} token rejected (HTTP 401) — marked disconnected, sequences stopped`);
      } else if (sync.reason) {
        result.errors.push(`merchant ${merchantId}: ${sync.reason}`);
      }
      continue;
    }

    reconcileInvoiceStatuses(db, merchantId, before, log);

    // Task creation for newly-overdue invoices — the core of the chase
    // promise. Every overdue invoice with no task is considered, oldest
    // first. The Standard cap blocks only when the number of ALREADY-tracked
    // overdue invoices is at the limit (50), so the 50th is still trackable
    // and a previously-blocked invoice is picked up automatically once the
    // tracked count drops below the limit (db.ts's documented blocked-resume
    // contract — the watcher's per-event rule would block an entire burst).
    const limit = invoiceLimitFor(db, merchantId);
    let tracked = limit !== null ? countTrackedOverdue(db, merchantId) : 0;
    const untracked = db
      .query(
        `SELECT i.* FROM invoices i
         WHERE i.merchant_id = ? AND i.status = 'overdue'
           AND NOT EXISTS (SELECT 1 FROM reminder_tasks rt WHERE rt.invoice_id = i.id)
         ORDER BY i.id ASC`
      )
      .all(merchantId) as Invoice[];

    for (const invoice of untracked) {
      if (isInvoiceSequenceStopped(invoice)) {
        result.blocked.stopped++;
        continue;
      }
      const created = await createTaskForOverdueInvoice(db, invoice, {
        overdueBefore: limit !== null ? tracked : 0,
        now,
      });
      if (created.taskId) {
        result.tasksCreated++;
        tracked++;
      } else if (created.skipped === "standard-limit") {
        result.blocked.standardLimit++;
      } else if (created.skipped === "free-draft-limit") {
        result.blocked.freeDraftLimit++;
      } else {
        result.blocked.stopped++;
      }
    }
  }

  log(
    `[scheduler] invoice-sync pass: ${result.merchants} merchant(s), ${result.invoicesUpserted} invoice(s) upserted, ` +
      `${result.tasksCreated} task(s) created, ${result.blocked.standardLimit} cap-blocked, ` +
      `${result.blocked.freeDraftLimit} draft-blocked, ${result.blocked.stopped} stopped, ` +
      `${result.disconnected.length} disconnected, ${result.errors.length} error(s)`
  );
  return result;
}

// ── Pass 2: escalation advance ──

export interface AdvancePassResult {
  merchants: number;
  advanced: number;
  alreadyLatest: number;
  skipped: { stopped: number; cancelled: number; noTask: number; draftLimit: number };
  errors: string[];
}

/**
 * Re-evaluate every overdue invoice's stage by days-overdue against the
 * merchant's ladder timing (default 1–6 / 7–20 / 21+; Pro custom
 * stage1_days/stage2_days) and advance when a threshold is crossed — the
 * ladder now actually moves for one-off invoices (PROMISES_AUDIT #10/#24/#29).
 *
 * Advance = create the NEXT task at the higher stage via the shared watcher
 * factory (createReminderTask cancels the prior open task; the auto-draft +
 * Trust Mode auto-send rules apply — Semi-Auto stage 2+ lands 'reviewed' for
 * approval, Full Auto sends). An invoice whose latest task is cancelled (or
 * paused) is a stopped sequence and is NEVER resurrected; an overdue invoice
 * with no task at all is left to the sync pass (which owns creation).
 */
export async function runEscalationAdvancePass(db: Database, deps: SchedulerDeps = {}): Promise<AdvancePassResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const result: AdvancePassResult = {
    merchants: 0,
    advanced: 0,
    alreadyLatest: 0,
    skipped: { stopped: 0, cancelled: 0, noTask: 0, draftLimit: 0 },
    errors: [],
  };

  const merchantIds = db
    .query(
      `SELECT DISTINCT i.merchant_id AS id FROM invoices i
       JOIN merchants m ON m.id = i.merchant_id
       WHERE i.status = 'overdue'
         AND m.deletion_scheduled_at IS NULL
         AND m.disconnected = 0
       ORDER BY i.merchant_id ASC`
    )
    .all() as { id: number }[];

  for (const { id: merchantId } of merchantIds) {
    result.merchants++;
    const timing = db
      .query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?")
      .get(merchantId) as { stage1_days: number; stage2_days: number } | null;

    const overdueInvoices = db
      .query("SELECT * FROM invoices WHERE merchant_id=? AND status='overdue' ORDER BY id ASC")
      .all(merchantId) as Invoice[];

    for (const invoice of overdueInvoices) {
      if (isInvoiceSequenceStopped(invoice)) {
        result.skipped.stopped++;
        continue;
      }
      const latest = db
        .query("SELECT * FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(invoice.id) as ReminderTask | null;
      if (!latest) {
        result.skipped.noTask++;
        continue;
      }
      if (latest.status === "cancelled" || latest.status === "paused") {
        result.skipped.cancelled++;
        continue;
      }
      const daysOverdue = Math.floor((now.getTime() - new Date(invoice.due_date).getTime()) / DAY_MS);
      const expected = getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);
      if (expected <= latest.stage) {
        result.alreadyLatest++;
        continue;
      }
      // overdueBefore=0: an already-tracked invoice is never cap-blocked
      // (getTaskForInvoice short-circuits the Standard-limit check), and the
      // free-draft gate still applies (a free merchant at the allowance cap
      // cannot draft the next stage).
      const created = await createTaskForOverdueInvoice(db, invoice, { overdueBefore: 0, now });
      if (created.taskId) {
        result.advanced++;
        log(`[scheduler] escalation-advance: invoice ${invoice.stripe_invoice_id} stage ${latest.stage} → ${expected} (${daysOverdue} days overdue, task ${created.taskId})`);
      } else if (created.skipped === "free-draft-limit") {
        result.skipped.draftLimit++;
        log(`[scheduler] escalation-advance: invoice ${invoice.stripe_invoice_id} not advanced — free draft allowance exhausted`);
      } else if (created.skipped === "stopped") {
        result.skipped.stopped++;
      } else {
        result.skipped.noTask++;
      }
    }
  }

  log(
    `[scheduler] escalation-advance pass: ${result.merchants} merchant(s), ${result.advanced} sequence(s) advanced, ` +
      `${result.alreadyLatest} already at latest stage, ${result.skipped.stopped} stopped, ` +
      `${result.skipped.cancelled} cancelled-latest, ${result.skipped.noTask} no-task, ${result.skipped.draftLimit} draft-blocked`
  );
  return result;
}

// ── Pass 3: weekly summary ──

export interface SummaryPassResult {
  considered: number;
  sent: number;
  failed: number;
  skipped: { notPaid: number; placeholder: number; notDue: number };
  errors: string[];
}

/** Generate + send one merchant's weekly summary (the same path the manual
 * POST /summary/send route uses), then record the attempt in summary_sends so
 * the pass enforces the 7-day cadence. */
async function sendWeeklySummaryForMerchant(db: Database, merchant: Merchant): Promise<{ success: boolean }> {
  const summary = generateWeeklySummary(db, merchant.id);
  const email = formatSummaryEmail(summary, merchant.stripe_account_id === "acct_default" ? "Merchant" : merchant.email);
  const sendResult = await sendEmailForReal(db, null, email, merchant.email);
  // send_logs.status allows only success|failed|skipped (CHECK constraint);
  // summary_sends.status allows only sent|failed — mirror each table's
  // contract and the manual /summary/send route exactly.
  const status = sendResult.success ? "success" : "failed";
  logSend(db, 0, status, `Weekly summary ${sendResult.success ? "sent" : "failed"}: ${sendResult.message}`, "weekly_summary");
  db.run("INSERT INTO summary_sends (merchant_id, status, detail) VALUES (?, ?, ?)", [
    merchant.id,
    sendResult.success ? "sent" : "failed",
    sendResult.message,
  ]);
  return { success: sendResult.success };
}

/**
 * Weekly recovery reports for every eligible merchant: paid plan (Standard or
 * Pro — homepage parity, same isActivePaidSubscriber gate the manual route
 * uses), real deliverable email (never a placeholder), and at least 7 days
 * since the merchant's last summary (or since creation for the first one).
 * Merchants are staggered naturally by their own send history — a daily pass
 * only sends to merchants whose anchor is older than the 7-day cutoff.
 */
export async function runWeeklySummaryPass(db: Database, deps: SchedulerDeps = {}): Promise<SummaryPassResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const result: SummaryPassResult = {
    considered: 0,
    sent: 0,
    failed: 0,
    skipped: { notPaid: 0, placeholder: 0, notDue: 0 },
    errors: [],
  };
  const cutoff = sqliteDateTime(new Date(now.getTime() - SUMMARY_CADENCE_MS));

  const merchants = db
    .query(
      "SELECT * FROM merchants WHERE stripe_account_id != 'acct_default' AND deletion_scheduled_at IS NULL ORDER BY id ASC"
    )
    .all() as Merchant[];

  for (const merchant of merchants) {
    if (!isActivePaidSubscriber(db, merchant.id)) {
      result.skipped.notPaid++;
      continue;
    }
    if (isPlaceholderMerchant(merchant)) {
      result.skipped.placeholder++;
      continue;
    }
    // Cadence: anchor = last scheduled send, or the merchant's creation date
    // for the first send (a brand-new merchant gets their first summary after
    // one full week, not on day one).
    const last = db
      .query("SELECT MAX(sent_at) AS s FROM summary_sends WHERE merchant_id=?")
      .get(merchant.id) as { s: string | null };
    const anchor = last?.s ?? merchant.created_at;
    if (!anchor || anchor > cutoff) {
      result.skipped.notDue++;
      continue;
    }
    result.considered++;
    try {
      const out = await sendWeeklySummaryForMerchant(db, merchant);
      if (out.success) result.sent++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      result.errors.push(`merchant ${merchant.id}: ${err instanceof Error ? err.message : String(err)}`);
      log(`[scheduler] weekly-summary FAILED for merchant ${merchant.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    `[scheduler] weekly-summary pass: ${result.considered} due, ${result.sent} sent, ${result.failed} failed, ` +
      `${result.skipped.notPaid} not-paid, ${result.skipped.placeholder} placeholder, ${result.skipped.notDue} not-due`
  );
  return result;
}

// ── Pass 4: daily purge ──

export interface PurgePassResult {
  expired: number;
  purged: number;
  errors: string[];
}

/**
 * Data-rights daily purge (PROMISES_AUDIT #42): every merchant whose
 * deletion_scheduled_at has passed is fully purged via purgeMerchantData
 * (idempotent + transactional; a failure rolls the merchant's purge back and
 * is logged — the next daily pass retries). Merchants with a future clock or
 * no clock are never touched.
 */
export async function runPurgePass(db: Database, deps: SchedulerDeps = {}): Promise<PurgePassResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const result: PurgePassResult = { expired: 0, purged: 0, errors: [] };

  const due = db
    .query("SELECT id FROM merchants WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= ? ORDER BY id ASC")
    .all(sqliteDateTime(now)) as { id: number }[];
  result.expired = due.length;

  for (const { id } of due) {
    try {
      purgeMerchantData(db, id);
      result.purged++;
      log(`[scheduler] purge: merchant ${id} purged (deletion clock expired)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`merchant ${id}: ${msg}`);
      log(`[scheduler] purge FAILED for merchant ${id}: ${msg}`);
    }
  }

  log(`[scheduler] purge pass: ${result.expired} merchant(s) with expired deletion clock, ${result.purged} purged, ${result.errors.length} error(s)`);
  return result;
}

// ── Boot wiring ──

export interface SchedulerConfig {
  syncIntervalMs: number;
  advanceIntervalMs: number;
  summaryIntervalMs: number;
  purgeIntervalMs: number;
  /** First tick of the daily passes after boot (lets the HTTP server come up). */
  startDelayMs: number;
  /** First sync tick after boot — invoices created while the server was down
   * are picked up quickly. */
  syncInitialDelayMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  syncIntervalMs: 15 * 60 * 1000,
  advanceIntervalMs: 24 * 60 * 60 * 1000,
  summaryIntervalMs: 24 * 60 * 60 * 1000,
  purgeIntervalMs: 24 * 60 * 60 * 1000,
  startDelayMs: 60 * 1000,
  syncInitialDelayMs: 30 * 1000,
};

export interface SchedulerHandle {
  /** Stop every timer. Idempotent. */
  stop(): void;
}

/**
 * Start the four passes at boot. Intervals are env-configurable
 * (SCHEDULER_*_MS) with the sane defaults above; each pass is single-flight
 * and fully guarded — a failing tick logs and never crashes the server.
 */
export function startScheduler(
  db: Database,
  config: Partial<SchedulerConfig> = {},
  deps: SchedulerDeps = {},
): SchedulerHandle {
  const cfg: SchedulerConfig = {
    syncIntervalMs: envMs("SCHEDULER_SYNC_INTERVAL_MS", DEFAULT_SCHEDULER_CONFIG.syncIntervalMs),
    advanceIntervalMs: envMs("SCHEDULER_ADVANCE_INTERVAL_MS", DEFAULT_SCHEDULER_CONFIG.advanceIntervalMs),
    summaryIntervalMs: envMs("SCHEDULER_SUMMARY_INTERVAL_MS", DEFAULT_SCHEDULER_CONFIG.summaryIntervalMs),
    purgeIntervalMs: envMs("SCHEDULER_PURGE_INTERVAL_MS", DEFAULT_SCHEDULER_CONFIG.purgeIntervalMs),
    startDelayMs: envMs("SCHEDULER_START_DELAY_MS", DEFAULT_SCHEDULER_CONFIG.startDelayMs),
    syncInitialDelayMs: envMs("SCHEDULER_SYNC_INITIAL_DELAY_MS", DEFAULT_SCHEDULER_CONFIG.syncInitialDelayMs),
    ...config,
  };
  const log = deps.log ?? console.log;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const schedule = (delayMs: number, intervalMs: number, tick: () => Promise<unknown>): void => {
    timers.push(
      setTimeout(() => {
        void tick();
        timers.push(setInterval(() => void tick(), intervalMs));
      }, delayMs)
    );
  };

  schedule(cfg.syncInitialDelayMs, cfg.syncIntervalMs, singleFlightPass("invoice-sync", () => runInvoiceSyncPass(db, deps), log));
  schedule(cfg.startDelayMs, cfg.advanceIntervalMs, singleFlightPass("escalation-advance", () => runEscalationAdvancePass(db, deps), log));
  schedule(cfg.startDelayMs, cfg.summaryIntervalMs, singleFlightPass("weekly-summary", () => runWeeklySummaryPass(db, deps), log));
  schedule(cfg.startDelayMs, cfg.purgeIntervalMs, singleFlightPass("purge", () => runPurgePass(db, deps), log));

  log(
    `[scheduler] started: invoice-sync every ${cfg.syncIntervalMs}ms (first in ${cfg.syncInitialDelayMs}ms), ` +
      `escalation-advance every ${cfg.advanceIntervalMs}ms, weekly-summary every ${cfg.summaryIntervalMs}ms, purge every ${cfg.purgeIntervalMs}ms`
  );

  return { stop: () => { for (const t of timers) clearTimeout(t); } };
}
