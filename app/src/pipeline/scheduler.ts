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
 * Five guarded passes, started at server boot (Bun setInterval — Railway runs
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
 *      (Standard invoice cap, Trust Mode auto-send, stopped-sequence guard).
 *   3. WEEKLY SUMMARY PASS (default daily, per-merchant 7-day cadence) —
 *      reuse the existing summary generation + paid-gated send for merchants
 *      with a real email on a paid plan; each merchant is sent at most once
 *      per 7 days (summary_sends ledger — send_logs rows for summaries carry
 *      reminder_task_id NULL, so they can't be attributed to a merchant).
 *   4. DAILY PURGE PASS (default daily) — merchants whose
 *      deletion_scheduled_at has passed are purged via purgeMerchantData
 *      (idempotent, transactional); log counts.
 *   5. DAILY OWNER REVENUE DIGEST (default daily) — read this app's OWN Stripe
 *      account (the account behind STRIPE_SECRET_KEY, read-only) and email the
 *      owner a compact revenue summary: balance, last-24h net
 *      (payments − refunds − fees), active subscribers, MRR, and one line per
 *      payment/subscription event. Internal owner alert only — it is addressed
 *      to OWNER_NOTIFY_EMAIL, never to a customer, and the pass no-ops when
 *      that variable is unset (see pipeline/owner-digest.ts).
 *   6. FREE-TRIAL EXPIRY EMAILS (default every 6 hours) — email merchants a
 *      scheduled arc of trial-expiry reminders as their 30-day trial runs out
 *      (T-7/T-3/T-1/T-0 on the active track, a day-10 check-in plus T-3/T-0 on
 *      the idle track, optional T+3 win-back). DISABLED BY DEFAULT: the pass is
 *      a logged no-op unless TRIAL_EXPIRY_EMAILS_ENABLED is exactly "true", and
 *      it never runs in a dev/test environment. See pipeline/trial-expiry.ts.
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
 *   SCHEDULER_OWNER_DIGEST_INTERVAL_MS — 86400000 (24 h)
 */
import type { Database } from "bun:sqlite";
import { getAppOAuthTokens, refreshAppAccessToken, syncMerchantInvoices } from "../routes/oauth-app-install";
import { getStripeConnectionFor } from "../middleware/auth";
import { createTaskForOverdueInvoice } from "./watcher";
import { generateWeeklySummary } from "./summary";
import { formatSummaryEmail } from "./summary-email";
import { sendEmailForReal } from "./sender";
import { isPlaceholderMerchant, notifyMerchant } from "./notify";
import { getEscalationStage } from "./escalation";
import { runDailyOwnerDigest } from "./owner-digest";
import { runTrialExpiryPass } from "./trial-expiry";
import { recordFunnelEvent } from "../funnel";
import {
  cancelTasksForInvoice,
  logSend,
  purgeMerchantData,
  invoiceLimitFor,
  isActivePaidSubscriber,
  isInvoiceSequenceStopped,
  getTaskForInvoice,
  recordRecoveryEvent,
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
   * 401 path here instead of hitting the network. `opts.livemode` selects the
   * mode (1 = live default, 0 = test) — the pass runs the pull once per mode. */
  syncInvoices?: (
    db: Database,
    merchantId: number,
    opts?: { livemode?: number },
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

function countTrackedOverdue(db: Database, merchantId: number, livemode = 1): number {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT i.id) AS n FROM invoices i
       JOIN reminder_tasks rt ON rt.invoice_id = i.id
       WHERE i.merchant_id = ? AND i.status = 'overdue' AND i.livemode = ?`
    )
    .get(merchantId, livemode === 0 ? 0 : 1) as { n: number };
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
 * 'paid', 'void', or 'uncollectible' since the previous sync gets the same
 * close/stop treatment the watcher applies on invoice.paid (cancel tasks +
 * one-time payment-received notification) and the void/uncollectible analog
 * (cancel open tasks + log, distinct message per status). Detected by diffing
 * the pre-sync snapshot against the post-sync rows, so a missed webhook is
 * recovered — the stale local state can no longer keep a sequence alive
 * forever (PROMISES_AUDIT #9).
 */
function reconcileInvoiceStatuses(
  db: Database,
  merchantId: number,
  before: Map<string, { status: string; id: number }>,
  livemode: number,
  log: (m: string) => void,
): void {
  const after = db
    .query(
      "SELECT id, stripe_invoice_id, status, paid_notified, customer_name, amount_cents, currency, due_date, ever_overdue FROM invoices WHERE merchant_id=? AND livemode=?"
    )
    .all(merchantId, livemode === 0 ? 0 : 1) as Array<{
      id: number;
      stripe_invoice_id: string;
      status: string;
      paid_notified: number;
      customer_name: string;
      amount_cents: number;
      currency: string;
      due_date: string;
      ever_overdue: number;
    }>;
  for (const row of after) {
    const prev = before.get(row.stripe_invoice_id);
    if (!prev || prev.status === row.status) continue;

    if (row.status === "paid") {
      // Admin telemetry (migration 020): the sync observed this invoice
      // becoming paid — record the recovery event when it was ever overdue.
      // Pure observation, idempotent per invoice_id (INSERT OR IGNORE), and
      // try/catch-guarded so a telemetry failure can never break the close/
      // stop logic below. The paid_at timestamp is the sync run time (we
      // don't know the exact payment moment from the list API).
      try {
        const rec = recordRecoveryEvent(db, { ...row, merchant_id: merchantId }, { source: "sync", paidAt: new Date().toISOString() });
        if (rec.recorded) {
          log(`[scheduler] invoice-sync: recovery event recorded for invoice ${row.stripe_invoice_id} (${rec.reason})`);
        }
        // Funnel: this merchant's first overdue invoice became paid (idempotent).
        recordFunnelEvent(db, merchantId, "paid");
      } catch (err) {
        console.error(
          `[scheduler] invoice-sync: recovery event record failed for ${row.stripe_invoice_id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
    } else if (row.status === "void" || row.status === "uncollectible") {
      // Void / uncollectible in Stripe = the debt is no longer active: stop
      // open sequences (the terminal analog of watcher's close/stop paths).
      // Drafts never carry tasks (they are never stored as overdue), so the
      // only inactive statuses that reach here are 'void' and
      // 'uncollectible' — each with a DISTINCT log message so the two are
      // distinguishable in the audit trail (reviewer fix #2).
      const cancelled = db
        .run(
          "UPDATE reminder_tasks SET status='cancelled' WHERE invoice_id=? AND status IN ('pending','drafted','reviewed')",
          [row.id]
        ).changes;
      const reason = row.status === "void" ? "voided" : "marked uncollectible";
      if (cancelled > 0) {
        logSend(db, 0, "success", `Invoice ${row.stripe_invoice_id} ${reason} in Stripe — stopped ${cancelled} open sequence(s)`, "disconnect");
        log(`[scheduler] invoice-sync: invoice ${row.stripe_invoice_id} became ${row.status} — ${cancelled} open sequence(s) stopped`);
      } else {
        log(`[scheduler] invoice-sync: invoice ${row.stripe_invoice_id} became ${row.status} (no open sequences)`);
      }
    }
  }
}

/**
 * A live invoice pull that answers HTTP 401 does NOT necessarily mean the
 * merchant deauthorized the app. Access tokens expire ~1h and the stored
 * `expires_at` is written from OUR clock AFTER the exchange round-trip, so it
 * over-estimates Stripe's real expiry by the request latency: a sync tick that
 * lands inside that gap sends a token Stripe has already invalidated and is
 * answered with a 401. (Production incident 2026-10-09: merchant 7 — the first
 * real paying merchant — was marked disconnected 4 seconds past the app's own
 * expiry, and because every pass excludes disconnected merchants, no code path
 * ever retried the refresh: the account stayed dark for 25 h with a perfectly
 * valid rolling refresh token on file. The customer voided the invoice and
 * retried "reconnect" into a flow that cannot work for a marketplace install.)
 *
 * Self-heal: force-refresh the rolling token pair through the app's own OAuth
 * helper and retry the pull ONCE. Returns the retry result when the connection
 * is usable again, or null when the pair really is dead (no refresh token, the
 * refresh itself failed, or the retry still 401s) — only then may the caller
 * mark the merchant disconnected. Never throws: any error inside the heal path
 * is logged and returns null, leaving the caller's existing semantics intact.
 */
async function retryAfterForcedTokenRefresh(
  db: Database,
  merchantId: number,
  syncInvoices: NonNullable<SchedulerDeps["syncInvoices"]>,
  log: (msg: string) => void,
): Promise<{ inserted: number; synced: boolean; reason?: string } | null> {
  try {
    const tok = db
      .query("SELECT stripe_user_id FROM oauth_tokens WHERE merchant_id = ? AND livemode = 1 ORDER BY updated_at DESC LIMIT 1")
      .get(merchantId) as { stripe_user_id: string } | null;
    if (!tok?.stripe_user_id) return null;
    const refreshed = await refreshAppAccessToken(db, tok.stripe_user_id, true);
    if (!refreshed.ok) {
      log(`[scheduler] invoice-sync: merchant ${merchantId} live token rejected and the forced refresh failed (${refreshed.error})`);
      return null;
    }
    // Mirror the fresh decrypted pair into the legacy stripe_connections row,
    // exactly like syncMerchantInvoices does on a refresh, so every other
    // consumer sees the current token rather than the stale mirror.
    const fresh = getAppOAuthTokens(db, tok.stripe_user_id);
    const conn = getStripeConnectionFor(db, merchantId, 1);
    if (fresh?.access_token && conn) {
      db.run("UPDATE stripe_connections SET access_token=?, refresh_token=?, updated_at=? WHERE id=?", [
        fresh.access_token,
        fresh.refresh_token,
        new Date().toISOString(),
        conn.id,
      ]);
    }
    const retry = await syncInvoices(db, merchantId, { livemode: 1 });
    if (retry.synced && !(retry.reason ?? "").includes("HTTP 401")) {
      log(`[scheduler] invoice-sync: merchant ${merchantId} live token rejected (HTTP 401) — forced a token refresh and the retry succeeded; merchant stays connected`);
      return retry;
    }
    // Disconnected mid-flight (concurrent deauthorize webhook): the retry
    // correctly no-ops; do not treat it as cause to re-mark the merchant.
    if (!retry.synced && retry.reason === "disconnected") return retry;
    log(`[scheduler] invoice-sync: merchant ${merchantId} still failing after a forced token refresh (${retry.reason ?? "no reason"})`);
    return null;
  } catch (err) {
    log(`[scheduler] invoice-sync: forced token refresh for merchant ${merchantId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Pass 1: invoice sync ──

export interface InvoiceSyncPassResult {
  merchants: number;
  invoicesUpserted: number;
  tasksCreated: number;
  blocked: { standardLimit: number; stopped: number };
  disconnected: string[];
  errors: string[];
}

/**
 * Pull invoices for every connected merchant and reconcile local state:
 * upsert (idempotent), propagate paid/void transitions, and create tasks for
 * newly-overdue invoices (Standard cap + blocked-resume, stopped-sequence
 * guard, Trust Mode via the shared watcher factory). HTTP 401 → mark
 * disconnected.
 *
 * MODE-AWARE since reviewer fix #5: the pass runs ONCE PER MODE for every
 * merchant — live (livemode=1, always: web-connect merchants have only the
 * live mirror) and test (livemode=0, only when the merchant has a marketplace
 * TEST install — oauth_tokens row with livemode=0). Each mode pulls with its
 * own token (getStripeConnectionFor), tags its own rows, and reconciles its
 * own state; the Standard cap counts per mode (test overdue rows never count
 * against the live cap). A dead token 401 marks the merchant disconnected ONLY
 * in live mode (a dead test token must not stop live collections); a test-mode
 * 401 is logged as an error and the merchant keeps running.
 */
export async function runInvoiceSyncPass(db: Database, deps: SchedulerDeps = {}): Promise<InvoiceSyncPassResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const syncInvoices = deps.syncInvoices ?? ((db: Database, merchantId: number, opts?: { livemode?: number }) =>
    // The periodic sync MUST include inactive statuses: void / uncollectible
    // invoices in Stripe carry no webhook (only payment_failed/overdue do),
    // so the ONLY way to detect a void/uncollectible transition after a
    // missed webhook is to pull those rows and diff them (reviewer fix #2 —
    // the reconcile pass then cancels the open sequence). The install
    // backfill path keeps includeInactive=false (never surface dead debts as
    // actionable on first connect); the draft status stays excluded either way.
    syncMerchantInvoices(db, merchantId, { includeInactive: true, ...opts }));
  const result: InvoiceSyncPassResult = {
    merchants: 0,
    invoicesUpserted: 0,
    tasksCreated: 0,
    blocked: { standardLimit: 0, stopped: 0 },
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
    // ── Mode loop (reviewer fix #5) ──
    // Live always; test only when the merchant has a marketplace TEST install.
    // Each iteration is a fully independent pipeline run for that mode: its
    // own token pull (syncInvoices → getStripeConnectionFor), its own
    // snapshot/reconcile, its own cap accounting, its own task creation.
    for (const livemode of [1, 0] as const) {
      if (livemode === 0) {
        // Test mode exists only for merchants with a marketplace TEST install.
        // Web-connect merchants (no oauth_tokens at all) have no test
        // connection; merchants with a live-only install must not have their
        // live rows re-tagged as test (the upsert key is mode-scoped, so a
        // test pull WOULD write parallel test copies). Skip test unless a
        // test token row is actually present.
        const hasTest = db
          .query("SELECT 1 FROM oauth_tokens WHERE merchant_id = ? AND livemode = 0 LIMIT 1")
          .get(merchantId);
        if (!hasTest) continue;
      }
      // Pre-sync snapshot for paid/void transition detection — mode-scoped.
      const before = new Map<string, { status: string; id: number }>();
      for (const row of db.query(
        "SELECT id, stripe_invoice_id, status FROM invoices WHERE merchant_id=? AND livemode=?"
      ).all(merchantId, livemode) as {
        id: number;
        stripe_invoice_id: string;
        status: string;
      }[]) {
        before.set(row.stripe_invoice_id, row);
      }
      const sync = await syncInvoices(db, merchantId, { livemode });
      result.invoicesUpserted += sync.inserted || 0;
      if (!sync.synced && sync.reason === "disconnected") continue;
      // Dead token pair (HTTP 401 — platform_api_key_expired): mirror
      // application.deauthorized semantics — mark disconnected + stop
      // sequences — but ONLY after a real attempt to heal the connection.
      // A live 401 can be a stale-token race (the stored expires_at is written
      // after the exchange round-trip and over-estimates Stripe's real expiry),
      // and a false "disconnected" is unrecoverable in-process: every pass
      // skips disconnected merchants, so the rolling refresh token on file is
      // never used again. Force a refresh + one retry first; only a pair that
      // cannot be refreshed (or still 401s with a fresh token) is treated as
      // dead. LIVE mode only: a dead TEST token must never stop live
      // collections — that stays logged as an error.
      const rejected401 = (sync.reason ?? "").includes("HTTP 401");
      const healedSync =
        rejected401 && livemode === 1
          ? await retryAfterForcedTokenRefresh(db, merchantId, syncInvoices, log)
          : null;
      if ((!sync.synced || rejected401) && !healedSync) {
        if (rejected401 && livemode === 1) {
          markDisconnected(db, merchantId);
          result.disconnected.push(String(merchantId));
          log(`[scheduler] invoice-sync: merchant ${merchantId} live token rejected (HTTP 401) — marked disconnected, sequences stopped`);
        } else if (sync.reason) {
          result.errors.push(`merchant ${merchantId} (livemode=${livemode}): ${sync.reason}`);
        }
        continue;
      }
      if (healedSync) {
        result.invoicesUpserted += healedSync.inserted || 0;
        // The heal path refreshed the token and the retry still could not pull
        // with it (e.g. a concurrent deauthorize) — nothing to reconcile.
        if (!healedSync.synced) continue;
      }
      // Funnel: this merchant got a real invoice pull from Stripe (idempotent
      // per merchant — recorded once even though sync runs on a cadence).
      recordFunnelEvent(db, merchantId, "invoices_synced");
      reconcileInvoiceStatuses(db, merchantId, before, livemode, log);

      // Task creation for newly-overdue invoices — the core of the chase
    // promise. Every overdue invoice with no task is considered, oldest
    // first. The Standard cap blocks only when the number of ALREADY-tracked
    // overdue invoices is at the limit (50), so the 50th is still trackable
    // and a previously-blocked invoice is picked up automatically once the
    // tracked count drops below the limit (db.ts's documented blocked-resume
    // contract — the watcher's per-event rule would block an entire burst).
    const limit = invoiceLimitFor(db, merchantId);
    let tracked = limit !== null ? countTrackedOverdue(db, merchantId, livemode) : 0;
    const untracked = db
      .query(
        `SELECT i.* FROM invoices i
         WHERE i.merchant_id = ? AND i.status = 'overdue' AND i.livemode = ?
           AND NOT EXISTS (SELECT 1 FROM reminder_tasks rt WHERE rt.invoice_id = i.id)
         ORDER BY i.id ASC`
      )
      .all(merchantId, livemode) as Invoice[];

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
      } else {
        result.blocked.stopped++;
      }
    }
    }
  }

  log(
    `[scheduler] invoice-sync pass: ${result.merchants} merchant(s), ${result.invoicesUpserted} invoice(s) upserted, ` +
      `${result.tasksCreated} task(s) created, ${result.blocked.standardLimit} cap-blocked, ` +
      `${result.blocked.stopped} stopped, ` +
      `${result.disconnected.length} disconnected, ${result.errors.length} error(s)`
  );
  return result;
}

// ── Pass 2: escalation advance ──

export interface AdvancePassResult {
  merchants: number;
  advanced: number;
  alreadyLatest: number;
  skipped: { stopped: number; cancelled: number; noTask: number };
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
 * approval, Copilot Mode sends). An invoice whose latest task is cancelled (or
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
    skipped: { stopped: 0, cancelled: 0, noTask: 0 },
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
      const autoStage = getEscalationStage(daysOverdue, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);
      // A manual per-invoice override (migration 031) layers on top of auto
      // progression: the override pins the expected stage while set (escalate
      // early or hold back), and clearing it restores pure days-overdue auto
      // progression. Because createTaskForOverdueInvoice honors the same
      // override in its own stage computation, the recreated task lands at
      // exactly this expected stage.
      const expected = invoice.stage_override ?? autoStage;
      if (expected <= latest.stage) {
        result.alreadyLatest++;
        continue;
      }
      // overdueBefore=0: an already-tracked invoice is never cap-blocked
      // (getTaskForInvoice short-circuits the Standard-limit check). Free
      // Draft Mode is unlimited (9/2) — the draft allowance gate is gone, so
      // escalation advances for every merchant; only the Standard invoice cap
      // (and stopped-sequence guards) can hold a sequence back.
      const created = await createTaskForOverdueInvoice(db, invoice, { overdueBefore: 0, now });
      if (created.taskId) {
        result.advanced++;
        log(`[scheduler] escalation-advance: invoice ${invoice.stripe_invoice_id} stage ${latest.stage} → ${expected} (${daysOverdue} days overdue, task ${created.taskId})`);
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
      `${result.skipped.cancelled} cancelled-latest, ${result.skipped.noTask} no-task`
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

// ── Pass 5: daily owner revenue digest ──

/**
 * Email the owner a compact daily revenue summary read from the app's OWN
 * Stripe account (owner request 2026-10-12). The pass itself lives in
 * pipeline/owner-digest.ts — same never-throw discipline as the other passes,
 * and a pure no-op (no Stripe call, no send) when OWNER_NOTIFY_EMAIL is unset.
 *
 * Re-exported here so the scheduler module stays the single entry point for
 * every pass (tests and manual triggers may import it from either module).
 */
export { runDailyOwnerDigest } from "./owner-digest";
export type { OwnerDigestData, OwnerDigestResult } from "./owner-digest";

// ── Pass 6: free-trial expiry emails ──

/**
 * The free-trial expiry email engine (owner-approved direction 2026-10-26)
 * lives in pipeline/trial-expiry.ts. Re-exported here so the scheduler module
 * stays the single entry point for every pass.
 *
 * SAFETY: the pass is OFF unless TRIAL_EXPIRY_EMAILS_ENABLED is exactly "true"
 * and the environment is not dev/test — with the flag unset it is a no-op that
 * only logs its tick. Nothing in the repo sets that flag.
 */
export { runTrialExpiryPass, isTrialExpiryEnabled, isDevOrTestEnv, touchpointForHours } from "./trial-expiry";
export type { TrialExpiryPassResult } from "./trial-expiry";

// ── Boot wiring ──

export interface SchedulerConfig {
  syncIntervalMs: number;
  advanceIntervalMs: number;
  summaryIntervalMs: number;
  purgeIntervalMs: number;
  ownerDigestIntervalMs: number;
  /** Free-trial expiry emails (pipeline/trial-expiry.ts) — off by default, so
   *  the cadence only matters once the lead flips the flag in production. */
  trialExpiryIntervalMs: number;
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
  ownerDigestIntervalMs: 24 * 60 * 60 * 1000,
  // 6 hours. Touchpoint windows are 24h wide, so this cadence can never land
  // between two windows and miss one; the 14:00 UTC tick is the natural
  // "US morning" slot (no timezone logic in v1 — deliberate).
  trialExpiryIntervalMs: 6 * 60 * 60 * 1000,
  startDelayMs: 60 * 1000,
  syncInitialDelayMs: 30 * 1000,
};

export interface SchedulerHandle {
  /** Stop every timer. Idempotent. */
  stop(): void;
}

/**
 * Start the five passes at boot. Intervals are env-configurable
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
    ownerDigestIntervalMs: envMs("SCHEDULER_OWNER_DIGEST_INTERVAL_MS", DEFAULT_SCHEDULER_CONFIG.ownerDigestIntervalMs),
    trialExpiryIntervalMs: envMs("SCHEDULER_TRIAL_EXPIRY_INTERVAL_MS", DEFAULT_SCHEDULER_CONFIG.trialExpiryIntervalMs),
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
  // Daily owner revenue digest (owner request 2026-10-12) — reads the app's own
  // Stripe account and emails the owner. Registered exactly like the other
  // daily passes: 24h interval, first tick at startDelayMs, single-flight
  // wrapper, so it logs `[scheduler] owner-digest pass …` like the rest.
  schedule(cfg.startDelayMs, cfg.ownerDigestIntervalMs, singleFlightPass("owner-digest", () => runDailyOwnerDigest(db, deps), log));
  // Free-trial expiry emails (owner-approved direction 2026-10-26). Registered
  // exactly like the other passes — 6h interval, first tick at startDelayMs,
  // single-flight wrapper — so it logs `[scheduler] trial-expiry pass …` even
  // while it is a no-op. OFF unless TRIAL_EXPIRY_EMAILS_ENABLED is "true".
  schedule(cfg.startDelayMs, cfg.trialExpiryIntervalMs, singleFlightPass("trial-expiry", () => runTrialExpiryPass(db, deps), log));

  log(
    `[scheduler] started: invoice-sync every ${cfg.syncIntervalMs}ms (first in ${cfg.syncInitialDelayMs}ms), ` +
      `escalation-advance every ${cfg.advanceIntervalMs}ms, weekly-summary every ${cfg.summaryIntervalMs}ms, purge every ${cfg.purgeIntervalMs}ms, ` +
      `owner-digest every ${cfg.ownerDigestIntervalMs}ms, trial-expiry every ${cfg.trialExpiryIntervalMs}ms`
  );

  return { stop: () => { for (const t of timers) clearTimeout(t); } };
}
