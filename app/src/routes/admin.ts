import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countWaitlistSignups, listWaitlistEntries, type WaitlistEntry } from "../db";
import { aggregateUtmCampaigns, aggregateVisitsBySource, bucketVisit, displayBucketName, referrerHost, type VisitForAttribution } from "../visit-sources";
import { botStatusFor, classifyDevice, isBotUa } from "../visitor-signals";

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
      visitor_id: typeof r.visitor_id === "string" && r.visitor_id ? r.visitor_id : "",
    };
  });
}

/**
 * Visitor → merchant conversion map (owner admin ask #8, 2026-08-25): which
 * landing-page visitor_id later became which merchant, so the "Recent visits"
 * table isn't a dead-end list of UUIDs. Returns an object keyed by visitor_id,
 * each value being a list of {merchant_id, email} for every merchant that
 * visitor became (one visitor can connect multiple Stripe accounts — one per
 * merchant row).
 *
 * Sources, in order:
 *   1. Direct: merchants.visitor_id (migration 028) — populated going forward
 *      by connect-time capture. Populated only for future connects today.
 *   2. Historical bridge: the waitlist table carries both visitor_id and email,
 *      and merchants carry email — join on normalized email so a visitor who
 *      also signed the (since-removed) waitlist with the same address they
 *      later connected with can be traced back. Honest limitation: historical
 *      rows can only be traced for visitors who both signed the waitlist AND
 *      connected with the same email; everyone else's prior visits have no
 *      direct link until connect-time capture is live.
 */
function conversions(db: Database): Record<string, Array<{ merchant_id: number; email: string }>> {
  const byVisitor: Record<string, Array<{ merchant_id: number; email: string }>> = {};
  const add = (vid: string, merchantId: number, email: string) => {
    if (!vid) return;
    (byVisitor[vid] = byVisitor[vid] || []).push({ merchant_id: merchantId, email });
  };
  // 1. Direct (going-forward) capture.
  const direct = db
    .query("SELECT id, email, visitor_id FROM merchants WHERE visitor_id IS NOT NULL AND visitor_id != ''")
    .all() as Array<{ id: number; email: string; visitor_id: string }>;
  for (const m of direct) add(m.visitor_id, m.id, m.email);
  // 2. Historical waitlist-email bridge.
  const viaWaitlist = db
    .query(
      `SELECT m.id AS merchant_id, m.email AS email, w.visitor_id AS visitor_id
       FROM merchants m
       JOIN waitlist w ON lower(trim(w.email)) = lower(trim(m.email))
       WHERE w.visitor_id IS NOT NULL AND w.visitor_id != ''`
    )
    .all() as Array<{ merchant_id: number; email: string; visitor_id: string }>;
  for (const r of viaWaitlist) add(r.visitor_id, r.merchant_id, r.email);
  return byVisitor;
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
 * Attach per-visit device/bot/geo signals to one raw page_visits row (owner
 * follow-up 2026-08-26: capture IP+UA so query-less / no-referrer visits are no
 * longer an unclassifiable "direct" blob). Keeps every existing field intact
 * and ADDS: ip (already masked at capture), user_agent (raw), country, plus the
 * derived {device, os, browser, bot_status, is_bot}. Pure + deterministic.
 */
function decorateVisit(v: Record<string, unknown>): Record<string, unknown> {
  const ua = typeof v.user_agent === "string" ? v.user_agent : "";
  const referrer = typeof v.referrer === "string" ? v.referrer : "";
  const dc = classifyDevice(ua);
  const botStatus = botStatusFor(ua, referrer);
  return {
    ...v,
    device: dc.device,
    os: dc.os,
    browser: dc.browser,
    bot_status: botStatus,
    is_bot: botStatus === "bot" || botStatus === "likely_bot" || isBotUa(ua),
  };
}

/** Sort a Record<string,number> by count desc, then key asc (deterministic). */
function sortCounts(map: Record<string, number>): Array<{ key: string; count: number }> {
  return Object.entries(map)
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Aggregated visitor-signal breakdown over ALL page_visits (device / OS /
 * browser / bot-vs-human / country), for the admin "Visitor signals" panel
 * (owner 2026-08-26). Pure — reads every row once, counts by classification.
 */
function visitorSignals(db: Database) {
  const rows = db.query("SELECT user_agent, referrer, ip, country FROM page_visits").all() as Array<{
    user_agent: string;
    referrer: string;
    ip: string;
    country: string;
  }>;
  const device: Record<string, number> = {};
  const os: Record<string, number> = {};
  const browser: Record<string, number> = {};
  const bot: Record<string, number> = { bot: 0, likely_bot: 0, human: 0, unknown: 0 };
  const country: Record<string, number> = {};
  let withIp = 0;
  for (const r of rows) {
    const dc = classifyDevice(r.user_agent ?? "");
    device[dc.device] = (device[dc.device] ?? 0) + 1;
    os[dc.os] = (os[dc.os] ?? 0) + 1;
    browser[dc.browser] = (browser[dc.browser] ?? 0) + 1;
    const bs = botStatusFor(r.user_agent ?? "", r.referrer ?? "");
    bot[bs] = (bot[bs] ?? 0) + 1;
    const co = (r.country ?? "").toUpperCase().trim();
    if (co) country[co] = (country[co] ?? 0) + 1;
    if (r.ip) withIp += 1;
  }
  return {
    total: rows.length,
    with_ip: withIp,
    device: sortCounts(device),
    os: sortCounts(os),
    browser: sortCounts(browser),
    bot,
    country: sortCounts(country),
  };
}

/**
 * Recovery + response-rate outcomes for the admin dashboard (owner direction
 * 2026-08-17: measure real outcomes from the first real user — admin-side
 * telemetry only, no merchant-facing UI reads it).
 *
 *   recovery   — all-time aggregates over recovery_events (one row per
 *                invoice that was EVER overdue and later became PAID,
 *                recorded by the webhook invoice.paid handler and the
 *                scheduler's invoice-sync reconciliation; see migration 020):
 *                count, dollars recovered (by currency — sums are per-currency
 *                because we never assume an FX rate), avg/median
 *                days-to-payment, how many had a reminder sent, stage
 *                breakdown, webhook-vs-sync source breakdown.
 *   response   — response rate from the existing send_logs ↔ inbound_replies
 *                join: reminders_sent = successful reminder emails
 *                (send_logs type 'reminder' status 'success'); replies =
 *                inbound_replies rows for invoices that had ≥1 sent reminder
 *                (a customer answer to a reminder we actually sent, not a
 *                stray inbound message); response_rate = replies/sends.
 *   per_merchant — top 10 merchants by recovered amount (cents summed per
 *                merchant — a merchant's invoices are typically one currency).
 */
function outcomes(db: Database) {
  // ── Recovery (recovery_events) ──
  const recovered = db
    .query("SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM recovery_events")
    .get() as { n: number; cents: number | null };
  const byCurrency = db
    .query(
      "SELECT currency, COUNT(*) AS n, SUM(amount_cents) AS cents FROM recovery_events GROUP BY currency ORDER BY cents DESC"
    )
    .all() as Array<{ currency: string; n: number; cents: number }>;
  const daysRows = db
    .query("SELECT days_to_payment FROM recovery_events WHERE days_to_payment IS NOT NULL ORDER BY days_to_payment ASC")
    .all() as Array<{ days_to_payment: number }>;
  const days = daysRows.map(r => r.days_to_payment);
  const sumDays = days.reduce((a, b) => a + b, 0);
  const avgDays = days.length ? sumDays / days.length : null;
  const medianDays = days.length ? days[Math.floor(days.length / 2)] : null;
  const reminderSent = (db.query("SELECT COUNT(*) AS n FROM recovery_events WHERE reminder_sent = 1").get() as { n: number }).n;
  const stageReached = db
    .query("SELECT stage_reached AS s, COUNT(*) AS n FROM recovery_events GROUP BY stage_reached ORDER BY s ASC")
    .all() as Array<{ s: number; n: number }>;
  const bySource = db
    .query("SELECT source, COUNT(*) AS n FROM recovery_events GROUP BY source ORDER BY source ASC")
    .all() as Array<{ source: string; n: number }>;

  // ── Response rate (send_logs ↔ inbound_replies) ──
  const sends = (db
    .query(
      "SELECT COUNT(*) AS n FROM send_logs sl WHERE sl.type = 'reminder' AND sl.status = 'success' AND sl.reminder_task_id IS NOT NULL"
    )
    .get() as { n: number }).n;
  const replies = (db
    .query(
      `SELECT COUNT(*) AS n FROM inbound_replies r
       WHERE EXISTS (
         SELECT 1 FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
         WHERE rt.invoice_id = r.invoice_id AND sl.type = 'reminder' AND sl.status = 'success'
       )`
    )
    .get() as { n: number }).n;
  const responseRate = sends > 0 ? replies / sends : null;

  // ── Per-merchant top 10 by recovered amount ──
  const perMerchant = db
    .query(
      `SELECT r.merchant_id AS merchant_id, m.email AS email, m.stripe_account_id AS stripe_account_id,
              COUNT(*) AS recovered_count, SUM(r.amount_cents) AS recovered_cents,
              AVG(r.days_to_payment) AS avg_days,
              (SELECT r2.currency FROM recovery_events r2
               WHERE r2.merchant_id = r.merchant_id
               GROUP BY r2.currency ORDER BY SUM(r2.amount_cents) DESC LIMIT 1) AS currency
       FROM recovery_events r JOIN merchants m ON m.id = r.merchant_id
       GROUP BY r.merchant_id
       ORDER BY recovered_cents DESC
       LIMIT 10`
    )
    .all() as Array<{
      merchant_id: number;
      email: string;
      stripe_account_id: string;
      recovered_count: number;
      recovered_cents: number;
      avg_days: number | null;
      currency: string;
    }>;

  return {
    recovery: {
      invoices_recovered: recovered.n,
      total_recovered_cents: recovered.cents ?? 0,
      by_currency: byCurrency,
      avg_days_to_payment: avgDays === null ? null : Math.round(avgDays * 10) / 10,
      median_days_to_payment: medianDays,
      reminder_sent_count: reminderSent,
      reminder_sent_rate: recovered.n > 0 ? Math.round((reminderSent / recovered.n) * 1000) / 1000 : null,
      stage_reached: stageReached,
      by_source: bySource,
    },
    response: {
      reminders_sent: sends,
      replies: replies,
      response_rate: responseRate === null ? null : Math.round(responseRate * 1000) / 1000,
      response_rate_pct: responseRate === null ? null : Math.round(responseRate * 10000) / 100,
    },
    per_merchant: perMerchant,
  };
}

/**
 * Daily-visit counts for the admin dashboard bar chart (owner direction):
 * reuse the existing page_visits table — no new tracking, no schema change.
 * Counts HUMAN visits only: a visit is excluded when botStatusFor() is
 * anything other than "human" — known-bot User-Agents ("bot") and bare
 * search-engine homepage referrers with no query ("likely_bot", the classic
 * query-less crawler burst the owner approved excluding on 8/19) are both
 * left out, as is "unknown" (no positive human signal). Logging is untouched —
 * every visit is still stored for auditing; only the chart totals filter.
 * Buckets by CALENDAR DAY IN UTC (page_visits.ts is the client ISO timestamp,
 * and the rest of the dashboard + SQLite datetimes are UTC, so UTC keeps the
 * chart aligned with what "today" means elsewhere; local-time variance would
 * make day boundaries shift per viewer). Zero-fills every day in the trailing
 * 30 days (oldest → newest) so gaps render as flat, not skipped — an empty
 * stretch reads as a zero-height bar rather than disappearing.
 */
function visitsByDay(db: Database): { days: number; tz: string; data: Array<{ date: string; count: number }> } {
  const rows = db.query("SELECT ts, user_agent, referrer FROM page_visits").all() as
    Array<{ ts: string | null; user_agent: string | null; referrer: string | null }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const ms = epochMs(r.ts);
    if (ms == null) continue;
    if (botStatusFor(r.user_agent ?? "", r.referrer ?? "") !== "human") continue; // bot + likely_bot + unknown excluded
    const day = new Date(ms).toISOString().slice(0, 10); // UTC "YYYY-MM-DD"
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  // Trailing 30 days as of today (UTC), oldest first.
  const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const data: Array<{ date: string; count: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(todayMs - i * 86400000).toISOString().slice(0, 10);
    data.push({ date: day, count: counts.get(day) ?? 0 });
  }
  return { days: 30, tz: "UTC", data };
}
/**
 * GET /admin/data — the funnel + merchant + visit + subscription-event data
 * behind the admin page. Token-gated identically to GET /admin.
 */
export function handleAdminData(db: Database, req: Request): Response {
  if (!requireAdminToken(req)) {
    return json({ error: "Unauthorized — missing or invalid ADMIN_TOKEN" }, 403);
  }
  const visits = (db.query(
    "SELECT id, visitor_id, page, referrer, utm_source, utm_medium, utm_campaign, utm_content, ts, ip, user_agent, country FROM page_visits ORDER BY id DESC LIMIT 50"
  ).all() as Array<Record<string, unknown>>).map(decorateVisit);
  const subscriptionEvents = db.query(
    "SELECT * FROM subscription_events ORDER BY id DESC LIMIT 50"
  ).all();
  return json({
    generated_at: new Date().toISOString(),
    funnel: funnel(db),
    merchants: merchantsList(db),
    visits,
    visits_by_source: visitsBySource(db),
    visits_by_day: visitsByDay(db),
    utm_campaigns: utmCampaigns(db),
    visitor_signals: visitorSignals(db),
    subscription_events: subscriptionEvents,
    outcomes: outcomes(db),
    conversions: conversions(db),
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
