/**
 * "The customer cannot pay this invoice" signal (2026-11-09).
 *
 * THE DEFECT (verified in production): two of the three live Stripe accounts we
 * would chase render an invoice page with NO payment panel at all. Opened
 * signed out in a real browser — same session, same `hosted_invoice_url`
 * mechanism — the paying merchant's $1.00 invoice shows "Choose how you'd like
 * to pay" and the trial merchants' pages end at "Powered by / Terms / Privacy"
 * with no card field, no "Save payment details", nothing to click. The cause is
 * account-level (that account cannot accept charges yet) and it is INVISIBLE to
 * us through the API: `/v1/account`, `/v1/accounts/{acct}`, `/v1/charges`,
 * `/v1/payment_intents` and `/v1/balance` all answer 403
 * `more_permissions_required_for_application` on our OAuth scope. Only
 * `/v1/invoices/{id}` works, and it does not carry this.
 *
 * So the hosted page itself is the only in-scope evidence, and this module is
 * the one thing that reads it: a server-side GET of the customer-facing invoice
 * URL, classified into
 *
 *   payable     — the payment panel is PRESENT (positively detected);
 *   not_payable — the page rendered fully and the panel is ABSENT;
 *   unknown     — anything we are not sure about. ALWAYS the fallback.
 *
 * CONSERVATIVE BY CONSTRUCTION. A false "your customer cannot pay" warning is
 * worse than no warning: it would send a merchant hunting for a problem that
 * does not exist. Non-200, timeout, network error, a short/unexpected body, a
 * page that does not look like a fully-rendered Stripe invoice page, or a page
 * that looks like a Stripe error/expired page all return `unknown`. Only a page
 * that is demonstrably Stripe's invoice page, rendered, with no payment panel
 * anywhere in it, is `not_payable`.
 *
 * THIS MODULE SENDS NOTHING AND BLOCKS NOTHING. It writes one nullable column
 * pair on `invoices` (migration 036), it runs from the existing 15-minute
 * invoice-sync pass at most once per invoice per 24 h, and it is surfaced
 * read-only on the approval screen. No send path, no reviewer rule, no Stripe
 * write is touched by it.
 */
import type { Database } from "bun:sqlite";

export type Payability = "payable" | "not_payable" | "unknown";

/** What the approval screen shows. `unknown` covers "never checked". */
export type CustomerCanPay = "yes" | "no" | "unknown";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default network budget for one hosted page. */
export const PAYABILITY_TIMEOUT_MS = 10_000;

/**
 * At most this many invoices are fetched per merchant per mode per pass. The
 * 24 h cache already stops this from becoming a hot loop; the cap keeps one
 * pathological merchant (100 overdue invoices, all slow) from stretching a
 * 15-minute sync tick. Anything not reached is simply picked up next tick.
 */
export const PAYABILITY_MAX_PER_PASS = 20;

/**
 * A real Stripe invoice page is ~18 KB at its SMALLEST (the live no-payment-
 * panel page measured 18,429 B; the control with the payment panel 37,902 B).
 * Anything under this is a stub, a redirect body, or an error page.
 */
const MIN_PAGE_BYTES = 2_000;

/** Markers of the payment panel itself — the positive signal. */
const PAYMENT_PANEL_MARKERS = [
  "choose how you'd like to pay",
  "save payment details",
  "card number",
];

/** Markers that this is Stripe's hosted invoice page at all (both the live
 *  control page and the live no-panel page carry all three). */
const INVOICE_PAGE_MARKERS = ["powered by", "terms", "privacy"];

/** Markers of a Stripe error / expired / dead page — never `not_payable`. */
const ERROR_PAGE_MARKERS = [
  "no longer available",
  "no longer exists",
  "has already been paid",
  "invoice has been paid",
  "link has expired",
  "page not found",
  "something went wrong",
  "not a valid",
  "cannot be found",
  "could not be found",
];

/**
 * Normalize HTML for marker matching: decode the apostrophe entities Stripe
 * emits and fold typographic quotes, then lowercase. Keeps the marker table
 * above readable ("choose how you'd like to pay").
 */
function normalize(html: string): string {
  return html
    .replace(/&#0*39;|&#x0*27;|&apos;|[\u2018\u2019]/gi, "'")
    .replace(/&#0*34;|&#x0*22;|&quot;|[\u201C\u201D]/gi, '"')
    .toLowerCase();
}

/**
 * Classify a fetched hosted-invoice page. Pure — the fixture test drives this
 * directly with the two live page shapes.
 *
 * Order matters: a positive payment panel wins (it is the only signal that
 * proves a customer can pay); then every "this is not a page we understand"
 * check bails to `unknown`; only then is an absent panel read as
 * `not_payable`.
 */
export function classifyHostedInvoicePage(html: string | null | undefined): Payability {
  if (typeof html !== "string" || html.length < MIN_PAGE_BYTES) return "unknown";
  const text = normalize(html);
  if (PAYMENT_PANEL_MARKERS.some((m) => text.includes(m))) return "payable";
  // Not Stripe's invoice page (a proxy page, a login wall, an empty shell).
  if (!INVOICE_PAGE_MARKERS.every((m) => text.includes(m))) return "unknown";
  // Stripe's own error / expired / already-paid page: it renders fully but
  // says nothing about whether this merchant CAN take money.
  if (ERROR_PAGE_MARKERS.some((m) => text.includes(m))) return "unknown";
  return "not_payable";
}

export interface PayabilityDeps {
  /** Injectable HTTP client (tests stub it). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request budget. Defaults to PAYABILITY_TIMEOUT_MS. */
  timeoutMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** A browser-ish UA: Stripe serves its full page to a browser, and this is a
 *  read of a public customer-facing page with no auth of any kind. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Fetch the hosted invoice page and classify it. Never throws — every failure
 * mode is `unknown`.
 */
export async function checkHostedInvoicePayable(url: string, deps: PayabilityDeps = {}): Promise<Payability> {
  const log = deps.log ?? console.log;
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PAYABILITY_TIMEOUT_MS;
  if (!url || !/^https:\/\//i.test(url)) return "unknown";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });
    // Only a 200 that rendered is evidence. 404/410 (dead or rotated link),
    // 5xx, and anything else are all "we do not know".
    if (res.status !== 200) {
      log(`[payability] fetch returned HTTP ${res.status} — unknown`);
      return "unknown";
    }
    const html = await res.text();
    return classifyHostedInvoicePage(html);
  } catch (err) {
    log(`[payability] fetch failed (${err instanceof Error ? err.message : String(err)}) — unknown`);
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC) — the format the rest of the
 *  DB writes, so string comparisons against it are correct. */
function sqliteDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Map a stored verdict onto the approval screen's three-state field. */
export function customerCanPayFrom(payability: string | null | undefined): CustomerCanPay {
  if (payability === "payable") return "yes";
  if (payability === "not_payable") return "no";
  return "unknown";
}

export interface PayabilitySweepResult {
  checked: number;
  payable: number;
  notPayable: number;
  unknown: number;
}

/**
 * The 15-minute-pass sweep for one merchant in one Stripe mode.
 *
 * Candidates: invoices that are still `open` or `overdue`, carry a hosted
 * payment link, and whose cached verdict is missing or older than 24 h. So each
 * invoice is fetched AT MOST ONCE PER 24 H — the cache is the `payability_checked_at`
 * stamp, written for every verdict including `unknown`, so a page we cannot
 * classify is not re-fetched on every tick either.
 *
 * One structured log line per verdict CHANGE only (`[payability] invoice <id>:
 * not_payable`), so the log shows when a merchant's account started (or
 * stopped) being able to take money, not a heartbeat.
 *
 * Never throws.
 */
export async function runPayabilitySweep(
  db: Database,
  merchantId: number,
  livemode = 1,
  deps: PayabilityDeps = {},
): Promise<PayabilitySweepResult> {
  const log = deps.log ?? console.log;
  const now = deps.now?.() ?? new Date();
  const cutoff = sqliteDateTime(new Date(now.getTime() - DAY_MS));
  const result: PayabilitySweepResult = { checked: 0, payable: 0, notPayable: 0, unknown: 0 };

  try {
    const rows = db
      .query(
        `SELECT id, stripe_invoice_id, hosted_invoice_url, payability, payability_checked_at
           FROM invoices
          WHERE merchant_id = ? AND livemode = ?
            AND status IN ('open', 'overdue')
            AND hosted_invoice_url IS NOT NULL AND hosted_invoice_url <> ''
            AND (payability IS NULL OR payability_checked_at IS NULL OR payability_checked_at <= ?)
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(merchantId, livemode === 0 ? 0 : 1, cutoff, PAYABILITY_MAX_PER_PASS) as Array<{
        id: number;
        stripe_invoice_id: string;
        hosted_invoice_url: string;
        payability: string | null;
        payability_checked_at: string | null;
      }>;

    for (const row of rows) {
      let verdict: Payability;
      try {
        verdict = await checkHostedInvoicePayable(row.hosted_invoice_url, deps);
      } catch {
        // checkHostedInvoicePayable never throws; defend anyway.
        verdict = "unknown";
      }
      db.run("UPDATE invoices SET payability = ?, payability_checked_at = ? WHERE id = ?", [
        verdict,
        sqliteDateTime(deps.now?.() ?? new Date()),
        row.id,
      ]);
      result.checked++;
      if (verdict === "payable") result.payable++;
      else if (verdict === "not_payable") result.notPayable++;
      else result.unknown++;

      if (verdict !== row.payability) {
        log(`[payability] invoice ${row.id}: ${verdict}`);
      }
    }
  } catch (err) {
    log(
      `[payability] sweep failed for merchant ${merchantId} (livemode=${livemode}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return result;
}
