import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countWaitlistSignups, listWaitlistEntries, type WaitlistEntry } from "../db";
import { aggregateUtmCampaigns, aggregateVisitsBySource, bucketVisit, displayBucketName, referrerHost, type VisitForAttribution } from "../visit-sources";

/**
 * Admin-only internal customer tracking dashboard (owner request 2026-08-12).
 *
 *   GET /admin      → self-contained HTML admin page (token-gated)
 *   GET /admin/data → JSON funnel/merchant/visits/events data (token-gated)
 *
 * Authenticated with the ADMIN_TOKEN env var, accepted as either
 * `?token=<ADMIN_TOKEN>` (query param — how the admin page's JS calls
 * /admin/data and how a browser opens the page) or `Authorization: Bearer
 * <ADMIN_TOKEN>` (curl / scripts). When ADMIN_TOKEN is unset every request
 * returns 403 — the admin surface is effectively disabled (same pattern as
 * /support/* with SUPPORT_API_TOKEN).
 *
 * Deliberately NEVER linked from the public UI: no dashboard link, no site
 * footer link, no robots/sitemap exposure. /admin is a backend route that
 * exists only for the owner (token in /home/team/shared/ADMIN_TOKEN).
 */

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Loaded at startup (same pattern as the dashboard page in src/index.ts).
const adminHtml = readFileSync(join(import.meta.dirname, "..", "ui", "admin.html"), "utf-8");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Shared token gate for every /admin endpoint (query ?token= or Bearer header). */
export function requireAdminToken(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token") ?? "";
  const fromHeader = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const candidate = fromQuery || fromHeader;
  if (!candidate) return false;
  const a = Buffer.from(ADMIN_TOKEN);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /admin — the admin page. Token-gated like the JSON endpoint; when
 * authorized, serves the self-contained HTML page with the __CC_ADMIN_TOKEN__
 * placeholder replaced by the actual token (the page's JS needs it to fetch
 * /admin/data — same serve-time-injection pattern as dashboard.html's
 * __CC_HANDOFF_URL__).
 */
export function handleAdminPage(db: Database, req: Request): Response {
  if (!requireAdminToken(req)) {
    return json({ error: "Unauthorized — missing or invalid ADMIN_TOKEN" }, 403);
  }
  const served = adminHtml.replaceAll("__CC_ADMIN_TOKEN__", ADMIN_TOKEN ?? "");
  return new Response(served, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" },
  });
}

// ── Funnel data ──

/** ISO-8601 (UTC) cutoff for windowed counts, e.g. "last 24h". */
function isoCutoff(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
}

/** SQLite-format (datetime('now', '-N day')) cutoff for columns stored in SQLite format. */
function sqliteCutoff(daysAgo: number): string {
  // Compute in JS so it is deterministic and UTC: SQLite datetime('now') is
  // "YYYY-MM-DD HH:MM:SS" (UTC, no timezone marker).
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Parse a stored timestamp to epoch ms — handles both ISO (page_visits, stripe_connections) and SQLite "YYYY-MM-DD HH:MM:SS" (UTC) formats. */
function epochMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(ts)) {
    const ms = Date.parse(ts.replace(" ", "T") + "Z");
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function funnel(db: Database) {
  const iso24 = isoCutoff(24);
  const iso7d = isoCutoff(24 * 7);
  const sq24 = sqliteCutoff(1);
  const sq7d = sqliteCutoff(7);

  const count = (sql: string, ...args: (string | number | null)[]): number =>
    (db.query(sql).get(...(args as never[])) as { n: number }).n;

  const visitsTotal = count("SELECT COUNT(*) AS n FROM page_visits");
  const visits24h = count("SELECT COUNT(*) AS n FROM page_visits WHERE ts >= ?", iso24);
  const visits7d = count("SELECT COUNT(*) AS n FROM page_visits WHERE ts >= ?", iso7d);

  const connectsTotal = count("SELECT COUNT(*) AS n FROM stripe_connections");
  const connects24h = count("SELECT COUNT(*) AS n FROM stripe_connections WHERE created_at >= ?", iso24);
  const connects7d = count("SELECT COUNT(*) AS n FROM stripe_connections WHERE created_at >= ?", iso7d);

  const draftsTotal = count(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id WHERE rt.draft_body != ''"
  );
  const drafts7d = count(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id WHERE rt.draft_body != '' AND rt.created_at >= ?",
    sq7d
  );

  const merchantsTotal = count("SELECT COUNT(*) AS n FROM merchants");

  const paidActive = db.query(
    "SELECT tier, COUNT(*) AS n FROM subscriptions WHERE status = 'active' GROUP BY tier"
  ).all() as Array<{ tier: string; n: number }>;
  const paid = { standard: 0, pro: 0 };
  for (const row of paidActive) {
    if (row.tier === "standard") paid.standard = row.n;
    if (row.tier === "pro") paid.pro = row.n;
  }
  const devProCount = count("SELECT COUNT(*) AS n FROM merchants WHERE dev_pro = 1");
  const subsCancelled = count("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'cancelled'");
  const subsPastDue = count("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'past_due'");

  const firstVisit = (db.query("SELECT ts FROM page_visits ORDER BY ts ASC, id ASC LIMIT 1").get() as { ts: string } | null)?.ts ?? null;
  const firstConnect = (db.query("SELECT created_at FROM stripe_connections ORDER BY created_at ASC, id ASC LIMIT 1").get() as { created_at: string } | null)?.created_at ?? null;
  const firstDraft = (db.query(
    "SELECT rt.created_at FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id WHERE rt.draft_body != '' ORDER BY rt.created_at ASC, rt.id ASC LIMIT 1"
  ).get() as { created_at: string } | null)?.created_at ?? null;

  return {
    visits_total: visitsTotal,
    visits_24h: visits24h,
    visits_7d: visits7d,
    connects_total: connectsTotal,
    connects_24h: connects24h,
    connects_7d: connects7d,
    drafts_created_total: draftsTotal,
    drafts_created_7d: drafts7d,
    merchants_total: merchantsTotal,
    paid_active: paid,
    dev_pro: devProCount,
    subs_cancelled: subsCancelled,
    subs_past_due: subsPastDue,
    first_visit_at: firstVisit,
    first_connect_at: firstConnect,
    first_draft_at: firstDraft,
  };
}

function merchantsList(db: Database) {
  const rows = db.query(`
    SELECT m.*,
      (SELECT COUNT(*) FROM invoices i WHERE i.merchant_id = m.id) AS invoice_count,
      (SELECT COUNT(*) FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id
         WHERE i.merchant_id = m.id AND rt.draft_body != '') AS draft_count,
      (SELECT MIN(rt.created_at) FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id
         WHERE i.merchant_id = m.id AND rt.draft_body != '') AS first_draft_at,
      (SELECT sub.tier FROM subscriptions sub WHERE sub.merchant_id = m.id
         ORDER BY sub.created_at DESC, sub.id DESC LIMIT 1) AS sub_tier,
      (SELECT sub.status FROM subscriptions sub WHERE sub.merchant_id = m.id
         ORDER BY sub.created_at DESC, sub.id DESC LIMIT 1) AS sub_status,
      (SELECT sub.created_at FROM subscriptions sub WHERE sub.merchant_id = m.id
         ORDER BY sub.created_at DESC, sub.id DESC LIMIT 1) AS sub_created_at,
      (SELECT se.created_at FROM subscription_events se
         WHERE se.merchant_id = m.id AND se.event = 'cancelled'
         ORDER BY se.id DESC LIMIT 1) AS sub_cancelled_at,
      (SELECT MAX(conn.updated_at) FROM stripe_connections conn WHERE conn.merchant_id = m.id) AS conn_updated_at,
      (SELECT MAX(i.created_at) FROM invoices i WHERE i.merchant_id = m.id) AS invoice_last_at
    FROM merchants m
    ORDER BY m.id ASC
  `).all() as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const devPro = Number(r.dev_pro ?? 0) === 1;
    const placeholder =
      r.stripe_account_id === "acct_default" ||
      (typeof r.email === "string" && r.email.endsWith(".local"));
    const subTier = typeof r.sub_tier === "string" ? r.sub_tier : null;
    const subStatus = typeof r.sub_status === "string" ? r.sub_status : null;

    const candidates = [r.created_at, r.first_draft_at, r.sub_created_at, r.sub_cancelled_at, r.conn_updated_at, r.invoice_last_at]
      .map((t) => epochMs(typeof t === "string" ? t : null))
      .filter((t): t is number => t !== null);
    const lastActivity = candidates.length ? new Date(Math.max(...candidates)).toISOString() : null;

    return {
      id: r.id,
      email: r.email,
      stripe_account_id: r.stripe_account_id,
      trust_mode: r.trust_mode,
      dev_pro: devPro,
      placeholder,
      created_at: r.created_at,
      plan: devPro ? "pro" : (subTier ?? "free"),
      sub_status: devPro ? "active" : (subStatus ?? "none"),
      sub_created_at: r.sub_created_at ?? null,
      sub_cancelled_at: r.sub_cancelled_at ?? null,
      first_draft_at: r.first_draft_at ?? null,
      draft_count: Number(r.draft_count ?? 0),
      invoice_count: Number(r.invoice_count ?? 0),
      last_activity: lastActivity,
    };
  });
}

/**
 * Visits-by-source channel attribution: every visit bucketed by utm_source
 * (wins), else referrer host, else "direct" — plus per-bucket counts
 * (all-time + last 7d) and a first-touch line (each distinct visitor is
 * attributed to the source of their FIRST visit row; unique visitors per
 * bucket). Each bucket also carries a friendly `display` name and the raw
 * `hosts` (referrer hostnames) behind it. See src/visit-sources.ts for the
 * deterministic bucketing rules.
 */
function visitsBySource(db: Database) {
  const rows = visitRows(db);
  const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString();
  return aggregateVisitsBySource(rows, cutoff7d);
}

/**
 * utm_campaign rollup — the same page_visits rows grouped by non-empty
 * utm_campaign with the same counting/first-touch semantics (see
 * src/visit-sources.ts aggregateUtmCampaigns). Lets the owner see which
 * tracked-link campaign (e.g. a Reddit post or Product Hunt launch) each
 * visit belongs to.
 */
function utmCampaigns(db: Database) {
  const rows = visitRows(db);
  const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString();
  return aggregateUtmCampaigns(rows, cutoff7d);
}

/** All page_visits rows with every attribution-relevant column (newest first
 *  not required here — aggregation order is insertion order, which is also
 *  id order for first-appearance semantics). */
function visitRows(db: Database): VisitForAttribution[] {
  return db.query(
    "SELECT id, visitor_id, referrer, utm_source, utm_medium, utm_campaign, ts FROM page_visits"
  ).all() as VisitForAttribution[];
}

/**
 * GET /admin/data — the funnel + merchant + visit + subscription-event data
 * behind the admin page. Token-gated identically to GET /admin.
 */
export function handleAdminData(db: Database, req: Request): Response {
  if (!requireAdminToken(req)) {
    return json({ error: "Unauthorized — missing or invalid ADMIN_TOKEN" }, 403);
  }
  const visits = db.query(
    "SELECT id, visitor_id, page, referrer, utm_source, utm_medium, utm_campaign, utm_content, ts FROM page_visits ORDER BY id DESC LIMIT 50"
  ).all();
  const subscriptionEvents = db.query(
    "SELECT * FROM subscription_events ORDER BY id DESC LIMIT 50"
  ).all();
  return json({
    generated_at: new Date().toISOString(),
    funnel: funnel(db),
    merchants: merchantsList(db),
    visits,
    visits_by_source: visitsBySource(db),
    utm_campaigns: utmCampaigns(db),
    subscription_events: subscriptionEvents,
    waitlist: {
      total: countWaitlistSignups(db),
      entries: listWaitlistEntries(db).map(waitlistEntryWithSource),
    },
  }, 200);
}

/**
 * Attach channel attribution to one waitlist entry using the shared pure
 * visit-sources helpers: source_bucket + friendly display name via
 * bucketVisit/displayBucketName (bucket keyed on utm_source first, then the
 * referrer host), and `hosts` = the entry's unique referrer host(s) — a
 * single signup row has at most one referrer, so this is `[host]` when a
 * parseable referrer exists, else []. The original {id, email, created_at}
 * fields (plus the stored referrer, utm_* and visitor_id) are left intact.
 */
function waitlistEntryWithSource(e: WaitlistEntry): WaitlistEntry & {
  source_bucket: string;
  display: string;
  hosts: string[];
} {
  const sourceBucket = bucketVisit({ referrer: e.referrer, utm_source: e.utm_source });
  const host = referrerHost(e.referrer ?? "");
  return {
    ...e,
    source_bucket: sourceBucket,
    display: displayBucketName(sourceBucket),
    hosts: host ? [host] : [],
  };
}
