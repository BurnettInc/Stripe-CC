/**
 * Free-trial expiry email engine (owner-approved direction 2026-10-26).
 *
 * As a merchant's 30-day free trial approaches its end the app emails them a
 * short, scheduled arc of owner-copy reminders, then (optionally) one win-back
 * note after the trial lapses. This module is the ENGINE only — the copy lives
 * in pipeline/trial-expiry-copy.ts and is placeholder text pending the owner's
 * verbatim approval.
 *
 * ─── SAFETY: OFF BY DEFAULT, AND OFF IN DEV/TEST ────────────────────────────
 * Two independent gates must BOTH pass before a single email can leave:
 *   1. TRIAL_EXPIRY_EMAILS_ENABLED must be exactly "true" (or "1"/"yes").
 *      Absent / "false" / anything else → the pass is a NO-OP that still logs
 *      its tick. It is NOT set anywhere in the repo, in start.sh, in the
 *      Dockerfile or in any test default — the lead flips it in production
 *      ONLY after the owner has approved the copy.
 *   2. The environment must not be dev/test (NODE_ENV development/dev/test, or
 *      a localhost/127.0.0.1 BASE_URL).
 * On top of that, every merchant is re-checked per tick: dev_pro accounts, the
 * acct_default placeholder, .local test emails, disconnected/deletion-scheduled
 * merchants, opted-out merchants and anyone with an ACTIVE paid subscription
 * are all skipped, and each (merchant, touchpoint) pair is sent at most once
 * ever.
 *
 * ─── TRIAL SEMANTICS (unchanged; db.ts owns them) ───────────────────────────
 * Free trial = full access for FREE_TRIAL_DAYS (30) days from merchants.
 * created_at, strictly before created_at + 30d. Trial merchants have no active
 * subscription (an active subscriber is NEVER "in trial"). After the window
 * sending locks (every send path 402s) while drafting stays free. This module
 * reads that window and never changes it — the day-30 lock stays strict, and
 * t_plus_3 is a pure win-back note, not a grace period.
 *
 * ─── TOUCHPOINTS (hours-to-expiry buckets, 24h wide) ────────────────────────
 * Anchored to h = hours until trial_expires_at (= created_at + 30 days), in
 * 24h-wide buckets so the pass's 6-hour cadence can never skip one:
 *   t_minus_7  144 < h <= 168
 *   t_minus_3   72 < h <=  96
 *   t_minus_1   24 < h <=  48
 *   t_zero       0 <= h <=  24
 *   t_plus_3   -72 < h <    0     (h == 0 belongs to t_zero: the trial has not
 *                                  lapsed until strictly after the instant)
 * plus one ABSOLUTE window for the idle track only:
 *   mid_trial_checkin  created_at + 10d <= now < created_at + 11d
 *
 * Track: ACTIVE when the merchant has at least one synced invoice OR one draft
 * (a task with a non-empty draft body); otherwise IDLE. The active track gets
 * the full T-7/T-3/T-1/T-0 arc; the idle track gets the day-10 check-in plus
 * T-3 and T-0 (no T-7/T-1 nagging). T+3 applies to both.
 *
 * ─── SENDING ────────────────────────────────────────────────────────────────
 * Same provider path the rest of the product uses (sendEmailForReal → Resend,
 * SendGrid fallback, log-only when no key). Sender identity is the support@
 * address the welcome emails used. Each send is logged in send_logs with type
 * 'trial_expiry' (mail log only — dedupe lives in its own table so digest-style
 * type filters over send_logs stay clean). The 14:00 UTC tick is the natural
 * "US morning" slot; no timezone logic in v1 (deliberate).
 *
 * Never throws: every failure is logged (and recorded) and the scheduler loop
 * stays alive.
 */
import type { Database } from "bun:sqlite";
import { FREE_TRIAL_DAYS, getSubscriptionByMerchantId, isDevPro, isUnsubscribed, logSend } from "../db";
import type { Merchant } from "../db";
import type { EmailDraft } from "./drafter";
import { isDevOrTestMerchant } from "./owner-notify";
import { sendEmailForReal } from "./sender";
import {
  TRIAL_BILLING_PATH,
  TRIAL_EMAIL_FROM,
  TRIAL_EMAIL_SUPPORT,
  formatExpiryDateUtc,
  greetingNameFor,
  renderTrialEmail,
} from "./trial-expiry-copy";
import type { TrialExpiryMergeFields, TrialTouchpoint, TrialTrack } from "./trial-expiry-copy";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Master switch. DEFAULT OFF — see the module doc. */
export const TRIAL_EXPIRY_FLAG = "TRIAL_EXPIRY_EMAILS_ENABLED";
/** send_logs.type for this feature (mail log only, never used for dedupe). */
export const TRIAL_EXPIRY_LOG_TYPE = "trial_expiry";

/** Canonical days-left figure per touchpoint — the number the copy quotes.
 *  Taken from the touchpoint itself (T-7 → 7, T-3 → 3 …) rather than a raw
 *  ceil() of hours-to-expiry, which inside a 24h-wide bucket can read 4 on a
 *  "3 days left" email. */
const DAYS_LEFT_FOR_TOUCHPOINT: Record<TrialTouchpoint, number> = {
  mid_trial_checkin: 19, // ~day 10 of a 30-day trial
  t_minus_7: 7,
  t_minus_3: 3,
  t_minus_1: 1,
  t_zero: 0,
  t_plus_3: 0,
};

/** Touchpoints that only the ACTIVE track receives (T-7/T-1 are noise for a
 *  merchant who never got as far as syncing an invoice or drafting). */
const ACTIVE_ONLY_TOUCHPOINTS: readonly TrialTouchpoint[] = ["t_minus_7", "t_minus_1"];
/** Touchpoints only the IDLE track receives. */
const IDLE_ONLY_TOUCHPOINTS: readonly TrialTouchpoint[] = ["mid_trial_checkin"];

/** Touchpoints reachable purely from hours-to-expiry (no mid-trial window). */
export type TrialWindowTouchpoint = Exclude<TrialTouchpoint, "mid_trial_checkin">;

// ── Gates (exported so tests can prove them directly) ──

/** The master switch. Anything but an explicit truthy value means OFF. */
export function isTrialExpiryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[TRIAL_EXPIRY_FLAG] || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Dev/test environment detection. Deliberately a DENY-list, not an
 * allow-list: the product's production env sets neither NODE_ENV nor a
 * localhost BASE_URL, so requiring "NODE_ENV === production" would keep the
 * feature dead forever even with the flag on. The master flag (default OFF) is
 * the real safety gate; this only stops local/test runs from ever emailing a
 * real merchant.
 */
export function isDevOrTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "development" || nodeEnv === "dev" || nodeEnv === "test") return true;
  const baseUrl = (env.BASE_URL || "").trim().toLowerCase();
  if (baseUrl && /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(baseUrl)) return true;
  return false;
}

// ── Pure timing helpers ──

/** Hours from `now` until the trial expires (may be negative after lapse). */
export function hoursToExpiry(createdAtMs: number, nowMs: number): number {
  const expiresAtMs = createdAtMs + FREE_TRIAL_DAYS * DAY_MS;
  return (expiresAtMs - nowMs) / HOUR_MS;
}

/**
 * The touchpoint whose 24h-wide bucket contains `hoursToExpiry`, or null.
 * Buckets are inclusive of their upper edge and exclusive of their lower edge
 * except t_zero, which owns h === 0 (the trial has not lapsed at that exact
 * instant). Any two windows are disjoint, so a tick can match at most one.
 */
export function touchpointForHours(hours: number): TrialWindowTouchpoint | null {
  if (!Number.isFinite(hours)) return null;
  if (hours >= 0 && hours <= 24) return "t_zero";
  if (hours > -72 && hours < 0) return "t_plus_3";
  if (hours > 24 && hours <= 48) return "t_minus_1";
  if (hours > 72 && hours <= 96) return "t_minus_3";
  if (hours > 144 && hours <= 168) return "t_minus_7";
  return null;
}

/** True while `now` is inside the idle track's absolute day-10 window:
 *  created_at + 10d <= now < created_at + 11d. */
export function inMidTrialWindow(createdAtMs: number, nowMs: number): boolean {
  const start = createdAtMs + 10 * DAY_MS;
  const end = createdAtMs + 11 * DAY_MS;
  return nowMs >= start && nowMs < end;
}

/**
 * Whether the merchant has an ACTIVE PAID subscription — a real one.
 *
 * ⚠️ Deliberately NOT db.ts's isActivePaidSubscriber: that helper is the
 * ENTITLEMENT check and returns true for any merchant inside the 30-day free
 * trial (the trial grants paid-equivalent access). Using it here would classify
 * every trial merchant as "subscribed" and the engine could never send a single
 * email. This mirrors only its subscription arm: an active standard/pro
 * subscription row. dev_pro is a separate gate (and a separate skip counter) in
 * the pass. Once a merchant really subscribes the pass stops mailing them, and
 * that re-check every tick is also what makes the T+3 win-back conditional on
 * "still not subscribed".
 */
export function hasActivePaidSubscription(db: Database, merchantId: number): boolean {
  const sub = getSubscriptionByMerchantId(db, merchantId);
  return !!sub && sub.status === "active" && (sub.tier === "standard" || sub.tier === "pro");
}

/** Which arc the merchant is on: ACTIVE once they have a synced invoice or a
 *  drafted reminder, IDLE until then. */
export function trackForMerchant(db: Database, merchantId: number): TrialTrack {
  const row = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM invoices WHERE merchant_id = ?) AS invoices,
         (SELECT COUNT(*) FROM reminder_tasks rt
            JOIN invoices i ON i.id = rt.invoice_id
           WHERE i.merchant_id = ? AND TRIM(COALESCE(rt.draft_body, '')) != '') AS drafts`
    )
    .get(merchantId, merchantId) as { invoices: number; drafts: number } | null;
  const invoices = Number(row?.invoices ?? 0);
  const drafts = Number(row?.drafts ?? 0);
  return invoices > 0 || drafts > 0 ? "active" : "idle";
}

/** Whether this touchpoint is reachable for the given track. */
export function touchpointAppliesToTrack(touchpoint: TrialTouchpoint, track: TrialTrack): boolean {
  if (track === "active") return !IDLE_ONLY_TOUCHPOINTS.includes(touchpoint);
  return !ACTIVE_ONLY_TOUCHPOINTS.includes(touchpoint);
}

/**
 * The touchpoint to send on this tick for one merchant, or null. Pure — no DB,
 * no clock beyond the two instants passed in.
 */
export function pickTouchpoint(
  createdAtMs: number,
  nowMs: number,
  track: TrialTrack,
): TrialTouchpoint | null {
  const window = touchpointForHours(hoursToExpiry(createdAtMs, nowMs));
  if (window && touchpointAppliesToTrack(window, track)) return window;
  // A window we deliberately ignore for this track (idle + T-7/T-1) is a miss
  // for this tick, not a fallback to another touchpoint.
  if (window) return null;
  if (track === "idle" && inMidTrialWindow(createdAtMs, nowMs)) return "mid_trial_checkin";
  return null;
}

/** Parse a stored created_at (SQLite datetime, UTC, no zone suffix). */
function parseStoredDate(value: string | null | undefined): number | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── Dedupe ledger (one row per merchant + touchpoint, ever) ──

/**
 * Reserve a send slot. INSERT OR IGNORE against UNIQUE(merchant_id, touchpoint)
 * — false means one was already reserved/sent for this merchant on this
 * touchpoint, so this tick must not send. Reserving BEFORE the send (rather
 * than after) is what makes "at most once ever" true even if a send throws
 * mid-flight; a FAILED send releases its reservation (releaseTrialExpirySend)
 * so a later tick may retry.
 */
export function reserveTrialExpirySend(db: Database, merchantId: number, touchpoint: TrialTouchpoint): boolean {
  const res = db.run(
    "INSERT OR IGNORE INTO trial_expiry_sends (merchant_id, touchpoint, status) VALUES (?, ?, 'reserved')",
    [merchantId, touchpoint]
  );
  return res.changes === 1;
}

/** The send went out — mark the reserved row sent. */
export function markTrialExpirySendSent(db: Database, merchantId: number, touchpoint: TrialTouchpoint, detail = ""): void {
  db.run(
    "UPDATE trial_expiry_sends SET status='sent', sent_at=datetime('now'), detail=? WHERE merchant_id=? AND touchpoint=?",
    [detail, merchantId, touchpoint]
  );
}

/** The send did NOT go out — drop the reservation so a later tick can retry. */
export function releaseTrialExpirySend(db: Database, merchantId: number, touchpoint: TrialTouchpoint): void {
  db.run("DELETE FROM trial_expiry_sends WHERE merchant_id=? AND touchpoint=? AND status='reserved'", [
    merchantId,
    touchpoint,
  ]);
}

/** How many times has this merchant already been sent this touchpoint? */
export function trialExpirySendCount(db: Database, merchantId: number, touchpoint: TrialTouchpoint): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM trial_expiry_sends WHERE merchant_id=? AND touchpoint=?")
    .get(merchantId, touchpoint) as { n: number } | null;
  return Number(row?.n ?? 0);
}

// ── The pass ──

/** Send shape (matches sendEmailForReal; injectable so tests never send). */
export type TrialExpirySender = (
  db: Database,
  task: null,
  draft: EmailDraft,
  toEmail: string,
  fromEmail?: string,
  opts?: { skipCanspam?: boolean }
) => Promise<{ success: boolean; message: string }>;

export interface TrialExpiryDeps {
  /** Injectable clock — tests drive touchpoint windows with a fixed date. */
  now?: () => Date;
  /** Injectable logger (structured [scheduler] lines). Defaults to console.log. */
  log?: (msg: string) => void;
  /** Injectable sender — tests inject a recorder, never a real provider. */
  send?: TrialExpirySender;
}

export interface TrialExpiryPassResult {
  /** Merchants that matched a touchpoint window (before the dedupe check). */
  inScope: number;
  sent: number;
  failed: number;
  skipped: {
    /** Master flag off — every candidate merchant counted here. */
    flagOff: number;
    /** Dev/test environment — every candidate merchant counted here. */
    env: number;
    /** Active paid subscriber (never "in trial"). */
    subscriber: number;
    /** dev_pro account. */
    devPro: number;
    /** acct_default placeholder / .local test email. */
    placeholder: number;
    /** Disconnected, or on the data-rights deletion clock. */
    inactive: number;
    /** Merchant's own address appears in the unsubscribes table. */
    unsubscribed: number;
    /** Already sent this touchpoint (at most once, ever). */
    duplicate: number;
    /** Not inside any touchpoint window on this tick. */
    noWindow: number;
  };
  errors: string[];
}

function emptyResult(): TrialExpiryPassResult {
  return {
    inScope: 0,
    sent: 0,
    failed: 0,
    skipped: {
      flagOff: 0,
      env: 0,
      subscriber: 0,
      devPro: 0,
      placeholder: 0,
      inactive: 0,
      unsubscribed: 0,
      duplicate: 0,
      noWindow: 0,
    },
    errors: [],
  };
}

function skippedTotal(result: TrialExpiryPassResult): number {
  const s = result.skipped;
  return (
    s.flagOff + s.env + s.subscriber + s.devPro + s.placeholder + s.inactive + s.unsubscribed + s.duplicate + s.noWindow
  );
}

/** The scheduler's log line, one shape for every outcome (parses like the
 *  other passes). */
function logLine(result: TrialExpiryPassResult, reason?: string): string {
  const s = result.skipped;
  return (
    `[scheduler] trial-expiry pass: ${result.inScope} in scope, ${result.sent} sent, ${skippedTotal(result)} skipped ` +
    `(flag ${s.flagOff}, env ${s.env}, sub ${s.subscriber}, dup ${s.duplicate}) — ` +
    `dev_pro ${s.devPro}, placeholder ${s.placeholder}, inactive ${s.inactive}, unsubscribed ${s.unsubscribed}, ` +
    `no-window ${s.noWindow}${result.failed > 0 ? `, ${result.failed} failed` : ""}${reason ? ` — ${reason}` : ""}`
  );
}

/**
 * One scheduler tick of the trial-expiry engine.
 *
 * Registered by scheduler.ts as the sixth pass: first tick at
 * SCHEDULER_START_DELAY_MS (60s after boot), then every 6 hours. Never throws;
 * a per-merchant failure is recorded and the rest of the loop continues.
 */
export async function runTrialExpiryPass(
  db: Database,
  deps: TrialExpiryDeps = {},
): Promise<TrialExpiryPassResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();
  const send: TrialExpirySender = deps.send ?? sendEmailForReal;
  const result = emptyResult();

  let merchants: Merchant[];
  try {
    // Everyone who could still be inside the arc: real accounts only, no
    // deletion clock. The window check below decides who actually gets mail.
    merchants = db
      .query(
        `SELECT id, email, created_at, stripe_account_id, dev_pro, disconnected, deletion_scheduled_at
           FROM merchants
          WHERE stripe_account_id != 'acct_default' AND deletion_scheduled_at IS NULL
          ORDER BY id ASC`
      )
      .all() as Merchant[];
  } catch (err) {
    const msg = `merchant list failed: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    log(logLine(result, msg));
    return result;
  }

  // ── Gate 1: master flag (default OFF) ──
  if (!isTrialExpiryEnabled()) {
    result.skipped.flagOff = merchants.length;
    log(logLine(result, `disabled — ${TRIAL_EXPIRY_FLAG} is not "true"`));
    return result;
  }

  // ── Gate 2: never in a dev/test environment ──
  if (isDevOrTestEnv()) {
    result.skipped.env = merchants.length;
    log(logLine(result, "disabled — dev/test environment"));
    return result;
  }

  for (const merchant of merchants) {
    try {
      if (Number(merchant.dev_pro) === 1 || isDevPro(db, merchant.id)) {
        result.skipped.devPro++;
        continue;
      }
      if (isDevOrTestMerchant(merchant)) {
        result.skipped.placeholder++;
        continue;
      }
      if (Number(merchant.disconnected) === 1) {
        result.skipped.inactive++;
        continue;
      }
      // An actively-paying merchant is out of the arc entirely — and this
      // re-check every tick is what makes the T+3 win-back "still not
      // subscribed". NOTE: hasActivePaidSubscription, not the entitlement
      // helper isActivePaidSubscriber (which is true for every in-trial
      // merchant and would mute the whole engine).
      if (hasActivePaidSubscription(db, merchant.id)) {
        result.skipped.subscriber++;
        continue;
      }
      const merchantEmail = (merchant.email || "").trim();
      if (isUnsubscribed(db, merchant.id, merchantEmail)) {
        result.skipped.unsubscribed++;
        continue;
      }
      const createdAtMs = parseStoredDate(merchant.created_at);
      if (createdAtMs === null) {
        result.errors.push(`merchant ${merchant.id}: unparseable created_at`);
        continue;
      }
      const track = trackForMerchant(db, merchant.id);
      const touchpoint = pickTouchpoint(createdAtMs, nowMs, track);
      if (!touchpoint) {
        result.skipped.noWindow++;
        continue;
      }
      result.inScope++;

      // Dedupe: at most one send per (merchant, touchpoint), ever.
      if (!reserveTrialExpirySend(db, merchant.id, touchpoint)) {
        result.skipped.duplicate++;
        continue;
      }

      const expiresAtMs = createdAtMs + FREE_TRIAL_DAYS * DAY_MS;
      const daysLeft = DAYS_LEFT_FOR_TOUCHPOINT[touchpoint];
      const appBaseUrl = (process.env.BASE_URL || "https://stripe-cc-production.up.railway.app").replace(/\/+$/, "");
      const fields: TrialExpiryMergeFields = {
        greetingName: greetingNameFor(merchantEmail),
        merchantEmail,
        expiryDate: formatExpiryDateUtc(expiresAtMs),
        daysLeft,
        trialDays: FREE_TRIAL_DAYS,
        dashboardUrl: `${appBaseUrl}/dashboard`,
        supportEmail: TRIAL_EMAIL_SUPPORT,
        // The approved copy's CTA tokens link to the dashboard's own subscribe
        // route (GET /billing/checkout — same URL the in-app CTA uses).
        billingUrl: `${appBaseUrl}${TRIAL_BILLING_PATH}`,
        track,
      };
      const email = renderTrialEmail(touchpoint, track, fields);

      // Never mail a half-filled template: an unresolved {{field}} is a copy
      // bug, so the send is abandoned (and the reservation released) rather
      // than delivered with a raw token in it.
      if (/\{\{\w+\}\}/.test(`${email.subject}\n${email.body}`)) {
        releaseTrialExpirySend(db, merchant.id, touchpoint);
        const msg = `merchant ${merchant.id} (${touchpoint}): copy has an unresolved merge field — not sent`;
        result.errors.push(msg);
        log(`[scheduler] trial-expiry: ${msg}`);
        continue;
      }

      let sendResult: { success: boolean; message: string };
      try {
        sendResult = await send(db, null, { subject: email.subject, body: email.body }, merchantEmail, TRIAL_EMAIL_FROM, {
          // The invoice-scoped CAN-SPAM footer ("stop reminders for this
          // invoice") is wrong for a merchant account email; the approved copy
          // carries its own opt-out line instead.
          skipCanspam: true,
        });
      } catch (err) {
        sendResult = { success: false, message: `send threw: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (sendResult.success) {
        markTrialExpirySendSent(db, merchant.id, touchpoint, sendResult.message);
        logSend(
          db,
          0,
          "success",
          `Trial-expiry email (${touchpoint}, ${track} track) sent to ${merchantEmail}: ${email.subject} (${sendResult.message})`,
          TRIAL_EXPIRY_LOG_TYPE
        );
        result.sent++;
        log(
          `[scheduler] trial-expiry: merchant ${merchant.id} ${merchantEmail} — ${touchpoint} (${track} track, ${daysLeft}d left) sent`
        );
      } else {
        // Release the reservation so a later tick may retry; log the failure
        // for the owner's mail trail (not counted as a send).
        releaseTrialExpirySend(db, merchant.id, touchpoint);
        logSend(
          db,
          0,
          "failed",
          `Trial-expiry email (${touchpoint}) FAILED for ${merchantEmail}: ${sendResult.message}`,
          TRIAL_EXPIRY_LOG_TYPE
        );
        result.failed++;
        result.errors.push(`merchant ${merchant.id} (${touchpoint}): ${sendResult.message}`);
        log(`[scheduler] trial-expiry: merchant ${merchant.id} ${touchpoint} send failed: ${sendResult.message}`);
      }
    } catch (err) {
      const msg = `merchant ${merchant.id}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      log(`[scheduler] trial-expiry: ${msg}`);
    }
  }

  log(logLine(result));
  return result;
}
