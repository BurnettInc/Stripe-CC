/**
 * AI-DRAFTING HEALTH ALERT (owner alert, 2026-11-13).
 *
 * Why this exists. On 2026-11-12 an invalid `OPENAI_API_KEY` made every single
 * draft silently fall back to the deterministic template. Reminders still went
 * out — complete, reviewer-approved, sendable — so nothing failed loudly, the
 * merchant saw nothing wrong, and NOBODY was told. The only place the truth
 * appeared was `GET /admin/data` → `drafting` (drafterHealth()), which someone
 * has to go and look at.
 *
 * This pass closes that gap the same way the daily revenue digest does:
 *   - a guarded scheduler pass, single-flight, that NEVER throws;
 *   - it reads drafterHealth() (pipeline/drafter.ts) — a pure in-process read,
 *     no network, no DB;
 *   - it emails OWNER_NOTIFY_EMAIL (never a merchant) when drafting is
 *     degraded: the key is missing, or there have been consecutive fallbacks;
 *   - the copy NAMES the last fallback reason (the provider's error code, e.g.
 *     `credit_balance_exhausted`) so the owner knows what to fix;
 *   - its cadence is DURABLE — at most one alert per 24h, enforced from a
 *     send_logs ledger (type `drafter_alert`) exactly like owner-digest, so a
 *     restart or a Railway auto-deploy cannot re-send and cannot be the thing
 *     that makes the alert fire.
 *
 * The check interval is deliberately shorter than the 24h window (1h default):
 * the guard decides whether a second EMAIL may go out, the interval decides how
 * fast a fresh outage is noticed. A degraded drafter found at 09:05 is reported
 * at 09:05, not the next day.
 *
 * A healthy drafter writes NO ledger row and sends nothing — the common tick is
 * one log line and no I/O.
 */

import type { Database } from "bun:sqlite";
import { logSend } from "../db";
import { drafterHealth } from "./drafter";
import type { DrafterHealth } from "./drafter";
import { sendEmailForReal } from "./sender";
import { getOwnerNotifyEmail } from "./owner-notify";
// Shared timestamp parser (SQLite 'YYYY-MM-DD HH:MM:SS' → epoch ms, UTC-pinned)
// and the elapsed-time formatter — the same helpers owner-digest uses, so the
// ledger is read one way and the log lines read alike.
import { parseStoredDate } from "./summary";
import { formatElapsed } from "./owner-digest";

/** send_logs.type for this feature (free-form TEXT since migration 007). */
export const DRAFTER_ALERT_LOG_TYPE = "drafter_alert";

/** At most one alert email per 24h (durable, send_logs ledger). */
export const ALERT_CADENCE_MS = 24 * 60 * 60 * 1000;

// ── The health decision (pure) ──

export type DrafterAlertCause = "missing_key" | "fallbacks" | "healthy";

export interface DrafterAlertDecision {
  shouldAlert: boolean;
  cause: DrafterAlertCause;
  /** The last recorded fallback reason (provider error code/type), or null. */
  lastReason: string | null;
  /** One short human sentence — goes into the subject line and the log. */
  summary: string;
}

/**
 * The rule, exported so it is testable on its own:
 *   - OPENAI_API_KEY missing           → alert (cause missing_key);
 *   - consecutive_fallbacks > 0        → alert (cause fallbacks);
 *   - anything else                    → healthy, no alert.
 * `consecutive_fallbacks` resets to 0 on the first successful model call, so a
 * one-off provider blip followed by a success does not alert. A missing key is
 * alerted on its own terms because with no key there may be no fallback
 * recorded yet in this process — the very first draft of a fresh process would
 * be the first sign.
 */
export function evaluateDrafterAlert(health: DrafterHealth): DrafterAlertDecision {
  const lastReason = health.last_fallback?.reason ?? null;
  if (!health.key_configured) {
    return {
      shouldAlert: true,
      cause: "missing_key",
      lastReason,
      summary: "OPENAI_API_KEY is not set — every reminder is the template",
    };
  }
  if (health.consecutive_fallbacks > 0) {
    const n = health.consecutive_fallbacks;
    return {
      shouldAlert: true,
      cause: "fallbacks",
      lastReason,
      summary: `${n} consecutive template fallback${n === 1 ? "" : "s"}${lastReason ? ` (last reason: ${lastReason})` : ""}`,
    };
  }
  return {
    shouldAlert: false,
    cause: "healthy",
    lastReason,
    summary:
      health.status === "unknown"
        ? "no draft attempt recorded yet in this process"
        : `drafting healthy (${health.successes_total} model draft${health.successes_total === 1 ? "" : "s"} since ${health.tracking_since})`,
  };
}

// ── Durable once-per-24h guard ──

export interface LastDrafterAlertState {
  /** Epoch ms of the most recent SUCCESSFUL alert, or null. */
  lastSuccessMs: number | null;
  lastSuccessAt: string | null;
  /** Epoch ms of the most recent attempt (success or failed), or null. */
  lastAttemptMs: number | null;
  /** Status of that most recent attempt ('success' | 'failed' | 'skipped'). */
  lastAttemptStatus: string | null;
}

/**
 * Read the durable ledger. Throws on a DB error — the caller decides what a
 * failed read means (this pass fails CLOSED: if we cannot prove we have not
 * already alerted, we do not send a second one).
 */
export function readLastDrafterAlertState(db: Database): LastDrafterAlertState {
  const row = db
    .query(
      `SELECT
         (SELECT created_at FROM send_logs WHERE type = ?1 AND status = 'success'
            ORDER BY datetime(created_at) DESC, id DESC LIMIT 1) AS last_success_at,
         (SELECT created_at FROM send_logs WHERE type = ?1
            ORDER BY datetime(created_at) DESC, id DESC LIMIT 1) AS last_attempt_at,
         (SELECT status FROM send_logs WHERE type = ?1
            ORDER BY datetime(created_at) DESC, id DESC LIMIT 1) AS last_attempt_status`
    )
    .get(DRAFTER_ALERT_LOG_TYPE) as
    | { last_success_at: string | null; last_attempt_at: string | null; last_attempt_status: string | null }
    | null;
  return {
    lastSuccessMs: parseStoredDate(row?.last_success_at),
    lastSuccessAt: row?.last_success_at ?? null,
    lastAttemptMs: parseStoredDate(row?.last_attempt_at),
    lastAttemptStatus: row?.last_attempt_status ?? null,
  };
}

export interface DrafterAlertGuardDecision {
  shouldSend: boolean;
  /** Human-readable why (always populated — it goes into the log line). */
  reason: string;
  /** Epoch ms when the 24h window opens again; null when an alert is due now. */
  nextAttemptMs: number | null;
}

/**
 * Same rule as evaluateDigestGuard:
 *   - no successful alert on record → send;
 *   - one sent less than 24h ago    → SKIP, next attempt at lastSuccess + 24h;
 *   - one sent 24h ago or longer    → send.
 * A last-success timestamp in the FUTURE (clock skew between a host and the
 * ledger) is treated as "just sent": never double-send on a clock disagreement.
 */
export function evaluateDrafterAlertGuard(
  state: LastDrafterAlertState,
  nowMs: number,
): DrafterAlertGuardDecision {
  if (state.lastSuccessMs === null) {
    return { shouldSend: true, reason: "no alert on record yet", nextAttemptMs: null };
  }
  const elapsed = nowMs - state.lastSuccessMs;
  if (elapsed < ALERT_CADENCE_MS) {
    const reason =
      elapsed < 0
        ? `last alert is timestamped ${formatElapsed(elapsed)} in the future — treating it as just sent`
        : `last alert sent ${formatElapsed(elapsed)} ago (window is 24h)`;
    return { shouldSend: false, reason, nextAttemptMs: state.lastSuccessMs + ALERT_CADENCE_MS };
  }
  return { shouldSend: true, reason: `last alert sent ${formatElapsed(elapsed)} ago — window open`, nextAttemptMs: null };
}

// ── The email ──

export interface DrafterAlertEmail {
  subject: string;
  body: string;
}

/** The admin dashboard URL for "details" (token-gated, owner-only). */
function adminUrl(): string {
  return `${process.env.BASE_URL || "https://stripe-cc-production.up.railway.app"}/admin`;
}

/**
 * Compose the owner alert. Truthful, specific, no urgency theatre: it says what
 * is degraded, what the merchant is getting instead, the last recorded reason,
 * and where the live status lives. Internal owner alert only — no CAN-SPAM
 * footer (there is no customer opt-out to honor).
 */
export function formatDrafterAlertEmail(
  health: DrafterHealth,
  decision: DrafterAlertDecision,
  now: Date,
): DrafterAlertEmail {
  const causeLine =
    decision.cause === "missing_key"
      ? "OPENAI_API_KEY is not set"
      : `${health.consecutive_fallbacks} consecutive template fallback${health.consecutive_fallbacks === 1 ? "" : "s"}`;

  const subject =
    decision.cause === "missing_key"
      ? "⚠️ AI drafting is OFF — OPENAI_API_KEY is not set (reminders are template copy)"
      : `⚠️ AI drafting is degraded — ${causeLine}${decision.lastReason ? ` (${decision.lastReason})` : ""}`;

  const last = health.last_fallback;
  const lines = [
    "AI drafting is DEGRADED. Reminders are still being produced and sent, but they",
    "are the deterministic template, not model-written copy — the merchant sees",
    "nothing wrong, so this email is the only warning that the model is out.",
    "",
    `  Cause:                 ${causeLine}`,
    `  Key configured:        ${health.key_configured ? "yes" : "no"}`,
    `  Consecutive fallbacks: ${health.consecutive_fallbacks}`,
    `  Fallbacks / successes (this process): ${health.fallbacks_total} / ${health.successes_total}`,
    `  Last fallback reason:  ${decision.lastReason ?? "none recorded in this process"}`,
  ];
  if (last) {
    lines.push(
      `  Last fallback at:      ${last.at}`,
      `  Last fallback detail:  ${last.detail}${last.http_status === null ? "" : ` (HTTP ${last.http_status})`}`,
    );
  }
  lines.push(
    `  Last model success:    ${health.last_success_at ?? "none in this process"}`,
    `  Counters since:        ${health.tracking_since} (process start — counters reset on restart)`,
    "",
    decision.cause === "missing_key"
      ? "Fix: set OPENAI_API_KEY on the service to a working key; drafting picks it up on the next draft."
      : "Fix: check the OpenAI key, its billing/credits, and the provider status; the reason above is the provider's own error code.",
    "",
    `Live status (drafting block): ${adminUrl()}`,
    `Checked at: ${now.toISOString()}`,
    "",
    "Internal owner alert — never sent to a customer. At most one of these per 24h.",
  );

  return { subject, body: lines.join("\n").trimEnd() + "\n" };
}

// ── The pass ──

export interface DrafterAlertDeps {
  /** Injectable clock — tests drive the 24h window with a fixed date. */
  now?: () => Date;
  /** Injectable logger (structured [scheduler] lines). Defaults to console.log. */
  log?: (msg: string) => void;
  /** Injectable health reader — tests seed a degraded drafter without a model. */
  health?: () => DrafterHealth;
}

export interface DrafterAlertResult {
  success: boolean;
  message: string;
  /** True when nothing was sent (healthy drafter / owner email unset / inside the 24h window). */
  skipped?: boolean;
  /** Epoch ms of the next allowed attempt — set only by the once-per-24h guard. */
  nextAttemptMs?: number;
  /** The health reading this run decided on (present whenever health was read). */
  health?: DrafterHealth;
}

/**
 * The pass: read drafterHealth(), and if drafting is degraded email the owner —
 * at most once per 24h. Never throws and never rejects; every failure is logged
 * (and recorded in send_logs when a send was attempted) so the scheduler loop
 * stays alive.
 *
 * Log line (same shape as the other passes):
 *   [scheduler] drafter-alert pass: <summary> — <sent|failed|skipped>
 * plus singleFlightPass's own `[scheduler] drafter-alert pass done (Xms)`.
 */
export async function runDrafterHealthAlertPass(
  db: Database,
  deps: DrafterAlertDeps = {},
): Promise<DrafterAlertResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();

  try {
    // Internal owner alert only — without the owner address there is nothing to do.
    const to = getOwnerNotifyEmail();
    if (!to) {
      log("[scheduler] drafter-alert pass: skipped — OWNER_NOTIFY_EMAIL not set");
      return { success: false, skipped: true, message: "OWNER_NOTIFY_EMAIL not set — drafter alert disabled" };
    }

    let health: DrafterHealth;
    try {
      health = (deps.health ?? drafterHealth)();
    } catch (err) {
      const msg = `health read failed (${err instanceof Error ? err.message : String(err)})`;
      log(`[scheduler] drafter-alert pass: skipped — ${msg}`);
      return { success: false, skipped: true, message: msg };
    }

    const decision = evaluateDrafterAlert(health);
    if (!decision.shouldAlert) {
      log(`[scheduler] drafter-alert pass: skipped — ${decision.summary}`);
      return { success: false, skipped: true, message: decision.summary, health };
    }

    // ── Durable once-per-24h guard, consulted BEFORE the send ──
    let lastState: LastDrafterAlertState;
    try {
      lastState = readLastDrafterAlertState(db);
    } catch (err) {
      // Fail CLOSED: without the ledger we cannot prove an alert has not already
      // gone out, and a duplicate owner email is the thing being avoided. The
      // next tick (an hour) re-reads a healthy ledger and sends.
      const msg = `guard read failed (${err instanceof Error ? err.message : String(err)}) — not sending a possible duplicate`;
      log(`[scheduler] drafter-alert pass: skipped — ${msg}`);
      return { success: false, skipped: true, message: msg, health };
    }
    const guard = evaluateDrafterAlertGuard(lastState, now.getTime());
    if (!guard.shouldSend) {
      const next =
        guard.nextAttemptMs === null
          ? ""
          : `; next attempt ${new Date(guard.nextAttemptMs).toISOString().slice(0, 16).replace("T", " ")} UTC (in ${formatElapsed(guard.nextAttemptMs - now.getTime())})`;
      log(`[scheduler] drafter-alert pass: skipped — ${guard.reason}${next}`);
      return {
        success: false,
        skipped: true,
        message: `already alerted inside the 24h window — ${guard.reason}`,
        ...(guard.nextAttemptMs === null ? {} : { nextAttemptMs: guard.nextAttemptMs }),
        health,
      };
    }

    const email = formatDrafterAlertEmail(health, decision, now);
    const sendResult = await sendEmailForReal(db, null, email, to, undefined, { skipCanspam: true });
    const status = sendResult.success ? "success" : "failed";
    try {
      logSend(
        db,
        0,
        status,
        `Drafter health alert ${sendResult.success ? "sent" : "failed"}: ${email.subject} (${sendResult.message})`,
        DRAFTER_ALERT_LOG_TYPE,
        undefined,
        now,
      );
    } catch {
      // Logging failed too — nothing more we can do; never throw to the caller.
    }
    log(
      `[scheduler] drafter-alert pass: ${decision.summary} — ${sendResult.success ? "sent" : `send failed (${sendResult.message})`}`,
    );
    return { success: sendResult.success, message: sendResult.message, health };
  } catch (err: unknown) {
    const msg = `drafter-alert build error: ${err instanceof Error ? err.message : String(err)}`;
    log(`[scheduler] drafter-alert pass: ${msg}`);
    try {
      logSend(db, 0, "failed", msg, DRAFTER_ALERT_LOG_TYPE, undefined, now);
    } catch {
      // ignore
    }
    return { success: false, message: msg };
  }
}
