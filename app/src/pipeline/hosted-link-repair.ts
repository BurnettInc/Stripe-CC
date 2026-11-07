/**
 * Rotated hosted payment link self-heal (2026-11-07).
 *
 * THE DEFECT (found in production minutes after PR #249 shipped): the reviewer
 * requires a draft body to contain the invoice's `hosted_invoice_url` EXACTLY —
 * "Missing hosted payment link: expected "<url>" … not found in draft". Stripe
 * ROTATES that hosted page, and the 15-minute sync refreshes
 * invoices.hosted_invoice_url (COALESCE, so it never wipes), so the invoice row
 * moves on while the stored draft keeps the older token. The reviewer then
 * rejects a perfectly good draft, and PR #249's readiness flag reports it to
 * the merchant as "Needs attention". Live case: reminder_task 72 (merchant 11,
 * $27.00 overdue) was `reviewed` with a good — but previous — hosted link.
 *
 * THE FIX: when a stored draft carries an `https://invoice.stripe.com/...` URL
 * that is not the invoice's current hosted link, rewrite that URL in place to
 * the current one. Only the URL token changes: every other byte of the draft
 * body (and subject) is left exactly as the merchant wrote it. The reviewer's
 * gate is NOT loosened — it still demands THIS invoice's current link, and the
 * drafts are repaired so that gate is satisfiable.
 *
 * WHAT IS NEVER REPAIRED
 *   - a draft that carries no hosted link at all (that is the C5 case: the
 *     reviewer must keep rejecting it, so nothing here invents a link);
 *   - a link belonging to a DIFFERENT Stripe account (see `accountOf`) — a
 *     foreign link is never adopted;
 *   - a `dashboard.stripe.com` URL (hard-rejected at review and at approve;
 *     untouched here so that guard keeps firing);
 *   - tasks that are already sent / paused / cancelled.
 *
 * WHERE IT RUNS: the periodic invoice-sync pass (scheduler, every 15 min —
 * the same pass that refreshes invoices.hosted_invoice_url), and the send path
 * (POST /tasks/:id/approve, a write endpoint) so a merchant who clicks Send on
 * a stale-but-fine draft is not blocked while waiting for the next tick. It is
 * deliberately NOT run from any read endpoint: GET /tasks stays read-only.
 *
 * No new DB column: the repair is derived from the two rows that already
 * exist (the draft text and the invoice's current link).
 */
import type { Database } from "bun:sqlite";

/** Stripe's customer-facing hosted invoice page. */
const HOSTED_LINK_RE = /https:\/\/invoice\.stripe\.com\/[^\s<>"'`]+/g;
/**
 * `https://invoice.stripe.com/i/<stripe account id>/<page token>` — the only
 * part of the URL that is stable across a rotation. Stripe's hosted URL
 * contains no invoice id, so the account prefix is the widest claim we can
 * make about a link's provenance.
 */
const ACCOUNT_RE = /^https:\/\/invoice\.stripe\.com\/i\/([^/?#]+)\//;
/** Punctuation a URL can pick up from the sentence around it. */
const TRAILING_PUNCT = ".,;:!?)]}>";

/** Task statuses the repair may touch. `sent`, `paused` and `cancelled` are
 *  never rewritten — a sent reminder is history, and the others are not
 *  drafts the merchant is about to send. */
const REPAIRABLE_STATUSES = ["pending", "drafted", "reviewed"] as const;

export interface HostedLinkRewrite {
  text: string;
  changed: boolean;
  /** How many URL occurrences were swapped. */
  replaced: number;
}

/** The Stripe account id a hosted invoice link belongs to, or null. */
export function hostedLinkAccount(url: string): string | null {
  const m = ACCOUNT_RE.exec(url);
  return m ? m[1] : null;
}

/** Split a regex match into its URL core and any trailing punctuation. */
function splitTrailing(match: string): { core: string; suffix: string } {
  let end = match.length;
  while (end > 0 && TRAILING_PUNCT.includes(match[end - 1])) end--;
  return { core: match.slice(0, end), suffix: match.slice(end) };
}

/**
 * Rewrite every Stripe-hosted invoice URL in `text` to `currentUrl`.
 *
 * Only links that belong to the SAME Stripe account as `currentUrl` are
 * touched: a rotation keeps the account prefix and changes the page token, so
 * a same-account link is the rotation this function exists for. A link from
 * another account (another merchant's invoice, or anything else) is left
 * alone — the reviewer then rejects it, exactly as before.
 *
 * Everything that is not the URL itself is preserved byte for byte, including
 * surrounding punctuation and the link's position in the sentence.
 */
export function refreshHostedLinkText(text: string, currentUrl: string | null): HostedLinkRewrite {
  if (!text || !currentUrl) return { text, changed: false, replaced: 0 };
  const currentAccount = hostedLinkAccount(currentUrl);
  if (!currentAccount) return { text, changed: false, replaced: 0 };

  let replaced = 0;
  const out = text.replace(HOSTED_LINK_RE, (match) => {
    const { core, suffix } = splitTrailing(match);
    if (core === currentUrl) return match;
    if (hostedLinkAccount(core) !== currentAccount) return match;
    replaced++;
    return `${currentUrl}${suffix}`;
  });
  return { text: out, changed: replaced > 0, replaced };
}

/**
 * Repair one task row in place. Returns true when the stored draft changed.
 * Never throws: any failure is logged and reported as "no change", so a
 * caller in a sync pass or a send path can never be broken by this.
 */
export function repairTaskHostedLink(
  db: Database,
  taskId: number,
  currentUrl: string | null,
  log: (msg: string) => void = console.log,
): boolean {
  try {
    if (!currentUrl) return false;
    const row = db
      .query("SELECT id, status, draft_subject, draft_body FROM reminder_tasks WHERE id = ?")
      .get(taskId) as { id: number; status: string; draft_subject: string | null; draft_body: string | null } | null;
    if (!row) return false;
    if (!(REPAIRABLE_STATUSES as readonly string[]).includes(row.status)) return false;

    const subject = refreshHostedLinkText(row.draft_subject ?? "", currentUrl);
    const body = refreshHostedLinkText(row.draft_body ?? "", currentUrl);
    if (!subject.changed && !body.changed) return false;

    db.run("UPDATE reminder_tasks SET draft_subject=?, draft_body=? WHERE id=? AND status IN ('pending','drafted','reviewed')", [
      subject.text,
      body.text,
      taskId,
    ]);
    log(`[drafts] refreshed hosted link for task ${taskId}`);
    return true;
  } catch (err) {
    log(
      `[drafts] hosted-link refresh failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Repair every open draft of one merchant in one Stripe mode. This is what the
 * periodic invoice-sync pass calls, right after the pass has refreshed
 * invoices.hosted_invoice_url — the invoice row and its drafts move together.
 *
 * Returns the number of tasks repaired. Never throws.
 */
export function repairStaleHostedLinks(
  db: Database,
  merchantId: number,
  livemode = 1,
  log: (msg: string) => void = console.log,
): number {
  let repaired = 0;
  try {
    const rows = db
      .query(
        `SELECT rt.id, i.hosted_invoice_url
           FROM reminder_tasks rt
           JOIN invoices i ON rt.invoice_id = i.id
          WHERE i.merchant_id = ? AND i.livemode = ?
            AND rt.status IN ('pending','drafted','reviewed')
            AND i.hosted_invoice_url IS NOT NULL AND i.hosted_invoice_url <> ''
            AND (rt.draft_body LIKE '%invoice.stripe.com%' OR rt.draft_subject LIKE '%invoice.stripe.com%')`,
      )
      .all(merchantId, livemode === 0 ? 0 : 1) as Array<{ id: number; hosted_invoice_url: string }>;

    for (const row of rows) {
      if (repairTaskHostedLink(db, row.id, row.hosted_invoice_url, log)) repaired++;
    }
  } catch (err) {
    log(
      `[drafts] hosted-link sweep failed for merchant ${merchantId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return repaired;
}
