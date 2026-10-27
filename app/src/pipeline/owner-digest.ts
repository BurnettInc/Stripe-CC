/**
 * Daily owner revenue digest (owner request 2026-10-12).
 *
 * Once a day the app emails the OWNER (OWNER_NOTIFY_EMAIL) a compact revenue
 * summary pulled from the app's OWN Stripe account — the account behind
 * STRIPE_SECRET_KEY, i.e. the platform account that bills Standard/Pro
 * subscriptions — PLUS the merchants currently inside the 30-day full-access
 * free trial (owner request 2026-10-26: trial merchants produce no Stripe
 * objects at all, so the revenue lines alone never mention them; the owner
 * wants them tracked to drive conversion). It is an INTERNAL owner alert: it
 * goes through the same product sender as the other owner notifications
 * (sendEmailForReal, with skipCanspam — there is no customer to opt out), and
 * it is never sent to a customer or merchant address.
 *
 * READ-ONLY by construction: three Stripe GETs (balance, balance/history,
 * subscriptions) with the existing STRIPE_SECRET_KEY, plus one local SQLite
 * read of the merchants table for the trial section. No new API key, no new
 * env var beyond the ones the app already reads, and no write of any kind
 * against Stripe. The trial data comes from the app's own DB (merchants.
 * created_at + subscriptions), never from Stripe.
 *
 * Source data:
 *   GET /v1/balance            — available[] + pending[] (usd only) → balance.
 *   GET /v1/balance/history    — the 100 most recent balance transactions,
 *                                filtered to the last 24h → payments, refunds,
 *                                fees and net revenue for the window, plus one
 *                                activity line per payment/refund event.
 *   GET /v1/subscriptions      — active subscriptions (livemode only) → count,
 *                                MRR, and one line per subscription created in
 *                                the window.
 *   merchants table            — free-trial merchants: isWithinFreeTrial
 *                                (strict "now < created_at + FREE_TRIAL_DAYS",
 *                                the same helper the entitlement code uses),
 *                                dev/test placeholders excluded with the
 *                                pipeline's isDevOrTestMerchant rule.
 *
 * Honesty rules baked in:
 *   - livemode only: the product's merchant subscriptions are live-mode; a
 *     test-mode object (reviewer/test installs) is never counted.
 *   - missing/zero data is rendered as $0.00 or "unavailable", never invented.
 *   - a failed Stripe call degrades its own line to "unavailable" and the
 *     digest still goes out; if ALL calls fail, no digest is sent (a page of
 *     "unavailable" would be noise, and the failure is logged instead).
 *   - if the 24h window needed more than 100 balance transactions the body
 *     says so, so a capped number is never read as exact.
 *   - the free-trial section is ALWAYS rendered, including "Merchants in free
 *     trial (0):" — an explicit zero is the owner's ask (omitting the section
 *     would read as "unknown").
 *   - days left is ceil() of the remaining window (SQLite julianday), so a
 *     merchant with hours left reads "1 day left" (never 0) and the strict
 *     30-day boundary stays truthful: at exactly FREE_TRIAL_DAYS they are out.
 *
 * Never throws: a failed Stripe call, a failed send, or a logging failure is
 * logged and swallowed — exactly like owner-notify.ts — so the daily pass can
 * never break the scheduler loop. Disabled entirely (no network call, no log
 * row) when OWNER_NOTIFY_EMAIL is unset.
 */

import type { Database } from "bun:sqlite";
import { FREE_TRIAL_DAYS, freeTrialDaysRemaining, getMerchantById, logSend } from "../db";
import { sendEmailForReal } from "./sender";
import type { EmailDraft } from "./drafter";
import { getOwnerNotifyEmail, isDevOrTestMerchant } from "./owner-notify";


// Stripe API base. STRIPE_API_BASE lets tests point this module at a local stub
// instead of the real API; production keeps the default. Same convention as
// routes/billing.ts and routes/oauth-app-install.ts.
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, "");

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Stripe is normally sub-second; a hung socket must not stall the pass. */
const STRIPE_TIMEOUT_MS = 15_000;
/** One request's worth of history (Stripe max) — the 24h window is read from it. */
const HISTORY_LIMIT = 100;
/** send_logs.type for this feature (free-form TEXT since migration 007). */
const LOG_TYPE = "owner_digest";

// ── Stripe shapes we consume (only the fields that are read) ──

interface StripeAmount {
  amount?: number;
  currency?: string;
}
interface StripeBalance {
  available?: StripeAmount[];
  pending?: StripeAmount[];
}
interface StripeBalanceTransaction {
  id?: string;
  type?: string;
  amount?: number;
  fee?: number;
  net?: number;
  currency?: string;
  created?: number;
  livemode?: boolean;
}
interface StripePrice {
  unit_amount?: number | null;
  nickname?: string | null;
  recurring?: { interval?: string; interval_count?: number } | null;
}
interface StripeSubscriptionItem {
  quantity?: number | null;
  price?: StripePrice | null;
}
interface StripeSubscription {
  id?: string;
  status?: string;
  created?: number;
  livemode?: boolean;
  customer?: string;
  items?: { data?: StripeSubscriptionItem[] };
}

/** Result of one Stripe GET — `ok:false` carries the HTTP status or the error. */
interface StripeGetResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}
export type StripeGet = (path: string) => Promise<StripeGetResult>;

// ── Pure helpers (exported so tests can assert formatting directly) ──

/** `$12.34` / `$1,234.56` — the digest is usd-only (the platform account bills in usd). */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const [whole, frac] = (Math.abs(cents) / 100).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + "$" + grouped + "." + frac;
}

/** `$12.34` for a known amount, `unavailable` when the source call failed. */
function money(cents: number | null): string {
  return cents === null ? "unavailable" : formatUsd(cents);
}

/** Sum of the usd entries of a Stripe balance bucket (other currencies are out
 * of scope for this product and are reported as their own currencies nowhere —
 * the platform account only bills usd). */
function usdSum(bucket: StripeAmount[] | undefined): number | null {
  if (!Array.isArray(bucket)) return null;
  let total = 0;
  for (const entry of bucket) {
    if ((entry.currency || "").toLowerCase() !== "usd") continue;
    if (typeof entry.amount === "number" && Number.isFinite(entry.amount)) total += entry.amount;
  }
  return total;
}

/** `2026-10-09` (UTC) from a Unix seconds timestamp. */
function utcDate(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "unknown date";
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Human plan name for a subscription price: the price nickname when Stripe has
 * one, else the live catalog amounts ($7/$50 Standard, $15/$100 Pro — see
 * PRICE_IDS in routes/billing.ts), else a neutral "Paid plan" (never a guess
 * presented as fact).
 */
export function planNameForPrice(price: StripePrice | null | undefined): string {
  const nickname = (price?.nickname || "").trim();
  if (nickname) return nickname;
  const amount = price?.unit_amount;
  if (amount === 700 || amount === 5000) return "Standard";
  if (amount === 1500 || amount === 10000) return "Pro";
  return "Paid plan";
}

/** Monthly-normalized revenue in cents for one subscription price: monthly at
 * face value, yearly / 12 (the two intervals in our catalog). An unknown
 * interval is counted at face value rather than multiplied. */
export function monthlyCentsForPrice(price: StripePrice | null | undefined, quantity: number): number {
  const unit = price?.unit_amount;
  if (typeof unit !== "number" || !Number.isFinite(unit)) return 0;
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const interval = price?.recurring?.interval;
  const months = interval === "year" ? 12 : 1;
  return Math.round((unit * qty) / months);
}

// ── Free-trial merchants (owner visibility, 2026-10-26) ──

/** One merchant inside the 30-day full-access free trial. */
export interface TrialMerchant {
  /** The merchant's (real, non-placeholder) email. */
  email: string;
  /** Whole days of trial left, ceil()'d — always >= 1 while the trial is on. */
  daysLeft: number;
}

/**
 * The merchants currently inside the 30-day full-access free trial — the ones
 * that produce NO Stripe objects, so the revenue lines above never mention
 * them. Owner request 2026-10-26: track them to drive conversion.
 *
 * Correctness first, cheapest query that cannot miss a merchant:
 *   1. ONE SQL read prefiltered to the trial window with the SAME boundary as
 *      isWithinFreeTrial (strict `datetime('now') < datetime(created_at,
 *      '+FREE_TRIAL_DAYS days')`), so no in-trial row is skipped and old rows
 *      are never enumerated (and the rows come back in connect order).
 *   2. Then freeTrialDaysRemaining — the SHARED db.ts helper (also used by the
 *      owner admin dashboard, so the two can never drift): it returns null
 *      unless the merchant is genuinely in trial (excludes dev_pro merchants
 *      and anyone with an active paid subscription — a subscriber is never
 *      "in trial") and otherwise the whole days left, ceil()'d, never 0.
 *   3. Then the pipeline's dev/test exclusion (isDevOrTestMerchant: dev_pro,
 *      acct_default placeholder account, .local placeholder emails) so our own
 *      test installs never show up in the owner's digest.
 *
 * Never throws: a DB failure is recorded in `errors` (rendered in the body as
 * unavailable) and yields an empty list — the digest still goes out.
 */
export function collectTrialMerchants(db: Database, errors?: string[]): TrialMerchant[] {
  try {
    // Cheap SQL prefilter with the SAME boundary as isWithinFreeTrial, so old
    // rows are never enumerated (and the ordering is the connect order).
    // The days-left figure itself comes from the shared
    // freeTrialDaysRemaining helper — one implementation shared with the owner
    // admin dashboard, so the two can never disagree.
    const interval = `+${FREE_TRIAL_DAYS} days`;
    const rows = db
      .query(
        `SELECT id, email
           FROM merchants
          WHERE datetime('now') < datetime(created_at, ?)
          ORDER BY datetime(created_at) ASC`
      )
      .all(interval) as { id: number; email: string | null }[];

    const out: TrialMerchant[] = [];
    for (const row of rows) {
      const daysLeft = freeTrialDaysRemaining(db, row.id);
      if (daysLeft === null) continue; // dev_pro / active subscriber / boundary
      const merchant = getMerchantById(db, row.id);
      if (isDevOrTestMerchant(merchant)) continue; // our own test installs never reach the owner
      out.push({ email: (merchant?.email || row.email || "unknown").trim(), daysLeft });
    }
    return out;
  } catch (err) {
    const msg = `/merchants (free trial) → ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[owner-digest] ${msg}`);
    if (errors) errors.push(msg);
    return [];
  }
}

// ── Free-trial expiry emails sent (owner visibility, 2026-10-26) ──

/** send_logs.type the trial-expiry engine logs its sends under. */
const TRIAL_EXPIRY_LOG_TYPE = "trial_expiry";

/**
 * How many trial-expiry emails actually went out in the last 24 hours — the
 * one line the owner gets about the free-trial notification arc (the engine is
 * flag-off by default, so this is normally 0 and the line is then OMITTED
 * entirely rather than printed as a zero).
 *
 * Reads the mail trail (send_logs rows with type 'trial_expiry', status
 * 'success') — NOT the dedupe ledger, which also holds reservations. A DB
 * failure degrades to 0 (line omitted) and is recorded in `errors`, exactly
 * like the other local reads here.
 */
export function countTrialExpirySends24h(db: Database, errors?: string[]): number {
  try {
    const row = db
      .query(
        `SELECT COUNT(*) AS n FROM send_logs
          WHERE type = ? AND status = 'success'
            AND datetime(created_at) >= datetime('now', '-1 day')`
      )
      .get(TRIAL_EXPIRY_LOG_TYPE) as { n: number } | null;
    return Number(row?.n ?? 0);
  } catch (err) {
    const msg = `/send_logs (trial_expiry 24h) → ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[owner-digest] ${msg}`);
    if (errors) errors.push(msg);
    return 0;
  }
}

// ── The digest payload ──

export interface OwnerDigestData {
  /** YYYY-MM-DD (UTC) of the run — the subject date. */
  date: string;
  /** ISO timestamp the 24h window ends at. */
  windowEnd: string;
  availableCents: number | null;
  pendingCents: number | null;
  /** payments − refunds − fees over the window; null when history failed. */
  netCents: number | null;
  paymentsCents: number | null;
  refundsCents: number | null;
  feesCents: number | null;
  /** Active live-mode subscriptions; null when the call failed. */
  activeSubscribers: number | null;
  /** Monthly-normalized active-subscription revenue; null when the call failed. */
  mrrCents: number | null;
  /** One short line per subscription/payment event in the window. */
  events: string[];
  /** Merchants inside the 30-day free trial (never dev/test). Always present —
   *  an explicit empty list renders as "Merchants in free trial (0):". */
  trialMerchants: TrialMerchant[];
  /** Free-trial expiry emails that actually went out in the last 24h. Rendered
   *  as its own line ONLY when > 0 (the engine ships flag-off, so a typical
   *  digest is byte-identical to the pre-feature one). */
  trialExpirySends: number;
  /** True when the 24h window hit the balance-history page limit. */
  historyTruncated: boolean;
  /** Per-call failures, e.g. "/balance → HTTP 500" — rendered in the body. */
  errors: string[];
}

export interface OwnerDigestEmail {
  subject: string;
  body: string;
}

/**
 * Format the digest email (plain text, compact). Kept pure so the wording can
 * be asserted without a network or a database.
 */
export function buildOwnerDigestEmail(data: OwnerDigestData): OwnerDigestEmail {
  const subject = `Daily revenue — ${data.date}`;
  const lines: string[] = [
    "Collections Copilot — daily revenue digest",
    `Period: last 24h ending ${data.windowEnd}`,
    "",
    `Balance available:   ${money(data.availableCents)}`,
    `Balance pending:     ${money(data.pendingCents)}`,
    `Revenue last 24h:    ${money(data.netCents)}`,
    `Active subscribers:  ${data.activeSubscribers === null ? "unavailable" : String(data.activeSubscribers)}`,
    `MRR:                 ${data.mrrCents === null ? "unavailable" : `${formatUsd(data.mrrCents)}/mo`}`,
  ];

  if (data.paymentsCents !== null && data.refundsCents !== null && data.feesCents !== null) {
    lines.push(
      `  (last 24h: ${formatUsd(data.paymentsCents)} payments − ${formatUsd(data.refundsCents)} refunds − ${formatUsd(data.feesCents)} fees)`
    );
  }
  if (data.historyTruncated) {
    lines.push("  (window read from the 100 most recent balance transactions — later activity may be missing)");
  }

  lines.push("", "Last 24h activity:");
  if (data.events.length === 0) {
    lines.push("  (no payments, refunds or new subscriptions in the last 24h)");
  } else {
    for (const event of data.events) lines.push(`  ${event}`);
  }

  // Free-trial merchants (owner request 2026-10-26): ALWAYS rendered, even at
  // zero — these merchants create no Stripe objects, so this section is the
  // only place the owner sees them, and an explicit "0" beats an omission.
  lines.push("", `Merchants in free trial (${data.trialMerchants.length}):`);
  if (data.trialMerchants.length === 0) {
    lines.push("  (none — no merchant is inside the 30-day trial right now)");
  } else {
    for (const merchant of data.trialMerchants) {
      lines.push(`  ${merchant.email} · ${merchant.daysLeft} day${merchant.daysLeft === 1 ? "" : "s"} left`);
    }
  }

  // Free-trial expiry emails sent in the last 24h — a single line, and ONLY
  // when something actually went out (the engine is flag-off by default, so
  // the common digest is byte-identical to the pre-feature one).
  if (data.trialExpirySends > 0) {
    lines.push("", `Trial-expiry emails sent (24h): ${data.trialExpirySends}`);
  }

  if (data.errors.length > 0) {
    lines.push("", `Unavailable this run: ${data.errors.join("; ")}`);
  }

  lines.push(
    "",
    "Source: this app's own Stripe account (live mode) — read-only. Internal owner alert; never sent to a customer."
  );

  return { subject, body: lines.join("\n").trimEnd() + "\n" };
}

// ── The pass ──

export interface OwnerDigestDeps {
  /** Injectable clock — tests drive the window with a fixed date. */
  now?: () => Date;
  /** Injectable logger (structured [scheduler] lines). Defaults to console.log. */
  log?: (msg: string) => void;
  /** Injectable Stripe GET — tests stub it instead of hitting the network. */
  stripeGet?: StripeGet;
}

export interface OwnerDigestResult {
  success: boolean;
  message: string;
  /** True when no digest was attempted (owner email unset / no Stripe key / every call failed). */
  skipped?: boolean;
  /** Present when a digest was formatted and a send was attempted. */
  data?: OwnerDigestData;
}

/** Default reader: plain Bearer GET, the same HTTP pattern routes/billing.ts uses. */
function defaultStripeGet(key: string): StripeGet {
  return async (path: string): Promise<StripeGetResult> => {
    const res = await fetch(`${STRIPE_API}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  };
}

/**
 * The daily pass: read the app's own Stripe account and email the owner a
 * compact revenue digest. Registered by scheduler.ts on a 24h interval,
 * first tick at SCHEDULER_START_DELAY_MS. Never throws and never rejects —
 * every failure is logged (and recorded in send_logs when a send was
 * attempted) so the scheduler loop stays alive.
 *
 * Log line (same shape as the other passes, so it parses the same way):
 *   [scheduler] owner-digest pass: <N> subscriber(s), MRR $X.XX/mo, net 24h $X.XX, <M> event(s), <T> in trial — <sent|failed|skipped>
 * plus singleFlightPass's own `[scheduler] owner-digest pass done (Xms)`.
 */
export async function runDailyOwnerDigest(db: Database, deps: OwnerDigestDeps = {}): Promise<OwnerDigestResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();

  // Internal owner alert only — without the owner address there is nothing to
  // do (and no Stripe call is worth making). Same switch as owner-notify.ts.
  const to = getOwnerNotifyEmail();
  if (!to) {
    log("[scheduler] owner-digest pass: skipped — OWNER_NOTIFY_EMAIL not set");
    return { success: false, skipped: true, message: "OWNER_NOTIFY_EMAIL not set — owner digest disabled" };
  }

  // The app's own platform account = the key the app already bills with.
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  const stripeGet = deps.stripeGet ?? (key ? defaultStripeGet(key) : null);
  if (!stripeGet) {
    log("[scheduler] owner-digest pass: skipped — STRIPE_SECRET_KEY not set");
    return { success: false, skipped: true, message: "STRIPE_SECRET_KEY not set — cannot read the revenue account" };
  }

  const errors: string[] = [];
  /** One guarded GET: a failure is recorded and reported as `null`, never thrown. */
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await stripeGet(path);
      if (!res.ok) {
        // Stripe's documented route (/v1/…), so a failure in the body/log is
        // directly usable in a curl or the Stripe dashboard.
        errors.push(`/v1${path} → HTTP ${res.status}`);
        return null;
      }
      return res.data;
    } catch (err) {
      errors.push(`/v1${path} → ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const windowEndMs = now.getTime();
  const sinceSeconds = Math.floor((windowEndMs - WINDOW_MS) / 1000);

  let data: OwnerDigestData | null = null;
  try {
    const balance = (await get("/balance")) as StripeBalance | null;
    const history = await get(`/balance/history?limit=${HISTORY_LIMIT}`);
    const subs = await get("/subscriptions?status=active&limit=100");

    if (!balance && !history && !subs) {
      const msg = `all Stripe calls failed (${errors.join("; ")})`;
      log(`[scheduler] owner-digest pass: no digest sent — ${msg}`);
      try {
        logSend(db, 0, "failed", `Owner digest skipped: ${msg}`, LOG_TYPE);
      } catch {
        // Logging failed too — nothing more we can do; never throw to caller.
      }
      return { success: false, skipped: true, message: msg };
    }

    // ── Balance (usd buckets only) ──
    const availableCents = balance ? usdSum(balance.available) : null;
    const pendingCents = balance ? usdSum(balance.pending) : null;

    // ── Last 24h window from balance history ──
    // Only earnings-shaped transactions count as revenue: charges/payments add,
    // refunds subtract, and the Stripe fees charged on those transactions are
    // subtracted too (payouts, transfers, adjustments and reserves are money
    // movements, not revenue, and are skipped). livemode only — test-mode
    // objects never enter the owner's numbers.
    let paymentsCents: number | null = null;
    let refundsCents: number | null = null;
    let feesCents: number | null = null;
    let historyTruncated = false;
    const events: string[] = [];
    if (history) {
      const rows = (Array.isArray(history.data) ? history.data : []) as StripeBalanceTransaction[];
      const inWindow = rows.filter((row) => row.livemode !== false && typeof row.created === "number" && row.created >= sinceSeconds);
      // The page covered less time than the window → more activity exists than
      // we can see; say so in the body rather than reporting a silently low net.
      if (rows.length >= HISTORY_LIMIT) {
        const oldest = Math.min(...rows.map((r) => (typeof r.created === "number" ? r.created : Number.MAX_SAFE_INTEGER)));
        historyTruncated = Number.isFinite(oldest) && oldest > sinceSeconds;
      }
      paymentsCents = 0;
      refundsCents = 0;
      feesCents = 0;
      for (const row of inWindow) {
        const amount = typeof row.amount === "number" ? row.amount : 0;
        const fee = typeof row.fee === "number" ? row.fee : 0;
        const kind = (row.type || "").toLowerCase();
        const isRefund = kind === "refund" || kind === "payment_refund";
        const isPayment = kind === "charge" || kind === "payment";
        if (!isRefund && !isPayment) continue;
        if (isRefund) {
          refundsCents += Math.abs(amount);
          events.push(`${utcDate(row.created)} · Refund · ${formatUsd(Math.abs(amount))}`);
        } else {
          paymentsCents += Math.abs(amount);
          events.push(`${utcDate(row.created)} · Payment received · ${formatUsd(Math.abs(amount))}`);
        }
        if (fee > 0) feesCents += fee;
      }
    }
    const netCents = paymentsCents === null || refundsCents === null || feesCents === null
      ? null
      : paymentsCents - refundsCents - feesCents;

    // ── Active subscriptions + MRR (livemode only) ──
    let activeSubscribers: number | null = null;
    let mrrCents: number | null = null;
    if (subs) {
      const rows = (Array.isArray(subs.data) ? subs.data : []) as StripeSubscription[];
      const live = rows.filter((row) => row.livemode !== false && (row.status ?? "active") === "active");
      activeSubscribers = live.length;
      mrrCents = 0;
      for (const sub of live) {
        for (const item of sub.items?.data ?? []) {
          mrrCents += monthlyCentsForPrice(item.price, item.quantity ?? 1);
        }
        if (typeof sub.created === "number" && sub.created >= sinceSeconds) {
          const price = sub.items?.data?.[0]?.price;
          const amount = monthlyCentsForPrice(price, sub.items?.data?.[0]?.quantity ?? 1);
          events.push(`${utcDate(sub.created)} · ${planNameForPrice(price)} subscription created · ${formatUsd(amount)}`);
        }
      }
    }

    data = {
      date: new Date(windowEndMs).toISOString().slice(0, 10),
      windowEnd: new Date(windowEndMs).toISOString().slice(0, 16).replace("T", " ") + " UTC",
      availableCents,
      pendingCents,
      netCents,
      paymentsCents,
      refundsCents,
      feesCents,
      activeSubscribers,
      mrrCents,
      events,
      // Local DB read (no network): the trial merchants the revenue numbers
      // can never show. Errors are folded into the same "Unavailable this run"
      // line as the Stripe failures.
      trialMerchants: collectTrialMerchants(db, errors),
      // Free-trial notification arc: how many trial-expiry emails actually went
      // out in the last 24h (0 → the line is omitted entirely).
      trialExpirySends: countTrialExpirySends24h(db, errors),
      historyTruncated,
      errors,
    };
  } catch (err) {
    // Defensive: the readers above are guarded, but the pass must never throw.
    const msg = `owner-digest build error: ${err instanceof Error ? err.message : String(err)}`;
    log(`[scheduler] owner-digest pass: ${msg}`);
    try {
      logSend(db, 0, "failed", msg, LOG_TYPE);
    } catch {
      // ignore
    }
    return { success: false, message: msg };
  }

  const email = buildOwnerDigestEmail(data);
  const summary = `${data.activeSubscribers ?? "?"} subscriber(s), MRR ${money(data.mrrCents)}/mo, net 24h ${money(data.netCents)}, ${data.events.length} event(s), ${data.trialMerchants.length} in trial`;

  const draft: EmailDraft = { subject: email.subject, body: email.body };
  try {
    const sendResult = await sendEmailForReal(db, null, draft, to, undefined, { skipCanspam: true });
    const status = sendResult.success ? "success" : "failed";
    logSend(
      db,
      0,
      status,
      `Owner digest ${sendResult.success ? "sent" : "failed"}: ${email.subject} (${sendResult.message})`,
      LOG_TYPE
    );
    log(`[scheduler] owner-digest pass: ${summary} — ${sendResult.success ? "sent" : `send failed (${sendResult.message})`}`);
    return { success: sendResult.success, message: sendResult.message, data };
  } catch (err: unknown) {
    const msg = `Owner digest send error: ${err instanceof Error ? err.message : String(err)}`;
    log(`[scheduler] owner-digest pass: ${msg}`);
    try {
      logSend(db, 0, "failed", msg, LOG_TYPE);
    } catch {
      // ignore
    }
    return { success: false, message: msg, data };
  }
}
