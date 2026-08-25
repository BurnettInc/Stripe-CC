/**
 * Channel attribution for the internal admin dashboard — visit bucketing
 * (owner request 2026-08-13: "I'd like to be able to track where they came
 * from.").
 *
 * Pure, deterministic, fully unit-testable (no DB, no IO). Consumed by
 * routes/admin.ts to build the /admin/data `visits_by_source` breakdown (each
 * bucket carries a friendly `display` name and the raw `hosts` that landed in
 * it) plus the `utm_campaigns` rollup, and by test-visit-sources.ts for the
 * unit tests.
 *
 * Bucketing rule (deterministic):
 *   1. If utm_source is present (non-empty after trim) → the bucket is that
 *      value, lowercased + whitespace-trimmed (e.g. "x", "reddit",
 *      "indiehackers", "betalist", "viberank", "google", "bing", ...).
 *   2. Else if referrer is non-empty → map the referrer's host:
 *        twitter.com / x.com / t.co / x.co → "x"
 *        facebook.com / fb.com             → "facebook"
 *        reddit.com                        → "reddit"
 *        news.ycombinator.com              → "hackernews"
 *        indiehackers.com                  → "indiehackers"
 *        producthunt.com                   → "producthunt"
 *        betalist.com                      → "betalist"
 *        viberank.dev                      → "viberank"
 *        stripe.com                        → "stripe"
 *        google.*                          → "google"
 *        bing.*                            → "bing"
 *        duckduckgo.com                    → "duckduckgo"
 *        linkedin.com / lnkd.in            → "linkedin"
 *        anything else                     → "referral:" + host
 *   3. Else → "direct".
 *
 * A search-engine referrer that is merely the engine's bare homepage — root
 * path ("/" or empty) and no query string, e.g. "https://www.google.com/" or
 * "http://bing.com/" — carries no search query, so it cannot be verified as a
 * real search. It is therefore bucketed into its OWN explicit bucket
 * "search_homepage_no_query" ("Search homepage (no query) — likely bot"),
 * NOT "direct" (owner-approved 8/19 filtered bots out of organic Google; this
 * follow-up 2026-08-26 stops them polluting the "direct" bucket so "direct"
 * stays a true no-referrer signal). Real search URLs ("/search?q=x",
 * "duckduckgo.com/?q=x") still bucket to their engine. utm_source still wins
 * regardless (an explicit utm_source=google with a bare google referrer → "google").
 */

export interface VisitForAttribution {
  id: number | bigint;
  visitor_id: string;
  referrer: string;
  utm_source: string;
  utm_medium?: string;
  utm_campaign?: string;
  ts: string;
}

export interface SourceBucket {
  bucket: string;
  /** Friendly channel name for the admin UI (see displayBucketName). */
  display: string;
  /** Unique lowercase referrer hosts (order of first appearance) that landed
   *  in this bucket; empty for direct (and for buckets whose rows had no
   *  parseable referrer). Includes the referrer host even for utm_source-driven
   *  buckets when a referrer exists. */
  hosts: string[];
  visits_total: number;
  visits_7d: number;
  first_touch_visitors: number;
}

export interface CampaignBucket {
  campaign: string;
  /** utm_medium of the first row seen for that campaign (else ""). */
  medium: string;
  visits_total: number;
  visits_7d: number;
  first_touch_visitors: number;
}

/** Friendly display name for a source bucket (pure, deterministic).
 *  Known channels map to human names; "referral:<host>" renders the host
 *  itself; anything else (a raw utm_source value) is title-cased. */
export function displayBucketName(bucket: string): string {
  const b = bucket.trim();
  const known: Record<string, string> = {
    x: "X / Twitter",
    reddit: "Reddit",
    hackernews: "Hacker News",
    indiehackers: "Indie Hackers",
    producthunt: "Product Hunt",
    betalist: "BetaList",
    viberank: "VibeRank",
    stripe: "Stripe",
    google: "Google",
    bing: "Bing",
    duckduckgo: "DuckDuckGo",
    linkedin: "LinkedIn",
    facebook: "Facebook",
    direct: "Direct",
    search_homepage_no_query: "Search homepage (no query) — likely bot",
  };
  if (known[b]) return known[b];
  if (b.startsWith("referral:")) return b.slice("referral:".length);
  return b
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Extract the lowercase hostname from a referrer; "" when unparseable. */
export function referrerHost(referrer: string): string {
  const r = referrer.trim();
  if (!r) return "";
  try {
    return new URL(r).hostname.toLowerCase();
  } catch {
    // Bare hosts ("google.com", "www.reddit.com") have no scheme — retry with
    // one so `document.referrer`-style full URLs AND bare host strings both work.
    try {
      return new URL(`http://${r}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
}

/**
 * True when `referrer` is a search engine's bare homepage: the host matches the
 * google.* / bing.* / duckduckgo.com patterns AND the URL has no path beyond
 * "/" and no query string (e.g. "https://www.google.com/",
 * "https://www.google.com", "http://bing.com/" — but NOT
 * "https://www.google.com/search?q=x" or "https://duckduckgo.com/?q=x", which
 * are real searches). A bare homepage carries no search query, so the visit
 * cannot be verified as organic search; the caller attributes it to the
 * explicit "search_homepage_no_query" bucket (likely bot) rather than a real
 * engine or "direct".
 * Pure + deterministic (no DB/IO); parses exactly like referrerHost so bare
 * host strings work too.
 */
export function isBareSearchHomepage(referrer: string): boolean {
  const r = referrer.trim();
  if (!r) return false;
  let url: URL;
  try {
    url = new URL(r);
  } catch {
    try {
      url = new URL(`http://${r}`);
    } catch {
      return false;
    }
  }
  const host = url.hostname.toLowerCase();
  const isSearchHost =
    /(^|\.)google\.([a-z]{2,3}|com)(\.[a-z]{2})?$/.test(host) ||
    /(^|\.)bing\.([a-z]{2,3}|com)(\.[a-z]{2})?$/.test(host) ||
    /(^|\.)duckduckgo\.com$/.test(host);
  if (!isSearchHost) return false;
  const path = url.pathname;
  return (path === "" || path === "/") && url.search === "";
}

/** Deterministic channel bucket for one visit row. */
export function bucketVisit(v: { utm_source?: string; referrer?: string }): string {
  const utm = (v.utm_source ?? "").trim().toLowerCase();
  if (utm) return utm;

  const host = referrerHost(v.referrer ?? "");
  if (!host) return "direct";

  // X/Twitter proper hosts PLUS X's link shorteners: t.co wraps every link
  // shared on X (the referrer a visitor lands with is https://t.co/...), and
  // x.co is X's companion short domain. Without these a shared-link visitor
  // lands in a useless "referral:t.co" bucket instead of "x".
  if (
    host === "twitter.com" || host.endsWith(".twitter.com") ||
    host === "x.com" || host.endsWith(".x.com") ||
    host === "t.co" || host.endsWith(".t.co") ||
    host === "x.co" || host.endsWith(".x.co")
  ) {
    return "x";
  }
  // Facebook proper hosts plus its link shorthands: fb.com is the bare short
  // domain, and m.facebook.com / l.facebook.com (mobile + link-tracking
  // hosts) are subdomains of facebook.com, so the endsWith covers them.
  if (
    host === "facebook.com" || host.endsWith(".facebook.com") ||
    host === "fb.com" || host.endsWith(".fb.com")
  ) {
    return "facebook";
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    return "reddit";
  }
  if (host === "news.ycombinator.com") {
    return "hackernews";
  }
  if (host === "indiehackers.com" || host.endsWith(".indiehackers.com")) {
    return "indiehackers";
  }
  if (host === "producthunt.com" || host.endsWith(".producthunt.com")) {
    return "producthunt";
  }
  if (host === "betalist.com" || host.endsWith(".betalist.com")) {
    return "betalist";
  }
  if (host === "viberank.dev" || host.endsWith(".viberank.dev")) {
    return "viberank";
  }
  // Stripe — covers stripe.com and dashboard.stripe.com (visitors arrive from
  // the Stripe Dashboard/app/marketplace and Connect flows).
  if (host === "stripe.com" || host.endsWith(".stripe.com")) {
    return "stripe";
  }
  // google.* / bing.* / duckduckgo.com — matches the bare TLD and the
  // www./m./<country> variants (google.com, www.google.com, google.co.uk,
  // www.google.co.uk, bing.com.au, ...). A bare homepage (root path, no query,
  // e.g. "https://www.google.com/") proves no search happened — a likely-bot
  // burst. It gets its OWN explicit bucket (search_homepage_no_query) so it
  // stops drowning the "direct" bucket (owner follow-up 2026-08-26): a search
  // engine's bare homepage is NOT a "direct" visit, and "direct" should mean
  // true no-referrer traffic. Real search URLs still bucket to their engine.
  if (isBareSearchHomepage(v.referrer ?? "")) return "search_homepage_no_query";
  if (/(^|\.)google\.([a-z]{2,3}|com)(\.[a-z]{2})?$/.test(host)) return "google";
  if (/(^|\.)bing\.([a-z]{2,3}|com)(\.[a-z]{2})?$/.test(host)) return "bing";
  if (/(^|\.)duckduckgo\.com$/.test(host)) return "duckduckgo";
  // linkedin.com (incl. www./m. subdomains) plus lnkd.in, LinkedIn's link shortener.
  if (/(^|\.)linkedin\.com$/.test(host) || host === "lnkd.in" || host.endsWith(".lnkd.in")) return "linkedin";

  return `referral:${host}`;
}

function epochMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * Aggregate visit rows into per-source buckets.
 *
 *   visits_total          — every visit attributed to the bucket
 *   visits_7d             — visits with ts >= cutoff7dIso (ISO compare)
 *   first_touch_visitors  — distinct visitors whose FIRST visit row (earliest
 *                           ts, id tiebreak) attributes to this bucket
 *   hosts                 — unique lowercase referrer hosts (order of first
 *                           appearance) among rows in this bucket; empty for
 *                           direct / referrer-less rows
 *   display               — friendly name (displayBucketName)
 *
 * Buckets are sorted visits_total desc, then bucket name asc (deterministic).
 * Rows with an unparseable ts count toward visits_total but never toward
 * visits_7d (they are not "recent").
 */
export function aggregateVisitsBySource(rows: VisitForAttribution[], cutoff7dIso: string): SourceBucket[] {
  const cutoffMs = epochMs(cutoff7dIso);
  const totals = new Map<string, number>();
  const recent = new Map<string, number>();
  const hostsByBucket = new Map<string, string[]>();
  // visitor_id → info about its earliest visit (ts epoch, row id, bucket)
  const first = new Map<string, { ts: number; id: number; bucket: string }>();

  for (const row of rows) {
    const bucket = bucketVisit(row);
    totals.set(bucket, (totals.get(bucket) ?? 0) + 1);

    const host = referrerHost(row.referrer ?? "");
    if (host) {
      let list = hostsByBucket.get(bucket);
      if (!list) {
        list = [];
        hostsByBucket.set(bucket, list);
      }
      if (!list.includes(host)) list.push(host);
    }

    const ts = epochMs(row.ts);
    if (!Number.isNaN(ts) && !Number.isNaN(cutoffMs) && ts >= cutoffMs) {
      recent.set(bucket, (recent.get(bucket) ?? 0) + 1);
    }

    if (!Number.isNaN(ts)) {
      const id = Number(row.id);
      const prev = first.get(row.visitor_id);
      if (!prev || ts < prev.ts || (ts === prev.ts && id < prev.id)) {
        first.set(row.visitor_id, { ts, id, bucket });
      }
    }
  }

  const buckets = new Map<string, SourceBucket>();
  for (const row of rows) {
    const b = bucketVisit(row);
    if (!buckets.has(b)) {
      buckets.set(b, {
        bucket: b,
        display: displayBucketName(b),
        hosts: hostsByBucket.get(b) ?? [],
        visits_total: totals.get(b) ?? 0,
        visits_7d: recent.get(b) ?? 0,
        first_touch_visitors: 0,
      });
    }
  }
  for (const info of first.values()) {
    const b = buckets.get(info.bucket);
    if (b) b.first_touch_visitors += 1;
  }

  return [...buckets.values()].sort(
    (a, b) => b.visits_total - a.visits_total || a.bucket.localeCompare(b.bucket)
  );
}

/**
 * Aggregate visit rows into per-campaign buckets (utm_campaign rollup).
 *
 * Only rows with a non-empty utm_campaign are considered; the campaign key is
 * the trimmed utm_campaign value (case-sensitive — as tagged). Counts mirror
 * aggregateVisitsBySource: visits_total / visits_7d / first_touch_visitors
 * (each visitor attributed to the campaign of their FIRST visit row). `medium`
 * is the utm_medium of the first row seen for that campaign (else "").
 *
 * Sorted visits_total desc, then campaign asc (deterministic).
 */
export function aggregateUtmCampaigns(rows: VisitForAttribution[], cutoff7dIso: string): CampaignBucket[] {
  const cutoffMs = epochMs(cutoff7dIso);
  const totals = new Map<string, number>();
  const recent = new Map<string, number>();
  const medium = new Map<string, string>();
  // visitor_id → info about its EARLIEST visit row (ts epoch, id, campaign —
  // "" when that earliest visit carried no utm_campaign). A visitor is
  // attributed to the campaign of their very first visit row; if that row had
  // no campaign they are not counted under any campaign's first-touch.
  const first = new Map<string, { ts: number; id: number; campaign: string }>();

  for (const row of rows) {
    const campaign = (row.utm_campaign ?? "").trim();

    const ts = epochMs(row.ts);
    if (!Number.isNaN(ts)) {
      const id = Number(row.id);
      const prev = first.get(row.visitor_id);
      if (!prev || ts < prev.ts || (ts === prev.ts && id < prev.id)) {
        first.set(row.visitor_id, { ts, id, campaign });
      }
    }

    if (!campaign) continue;
    totals.set(campaign, (totals.get(campaign) ?? 0) + 1);
    if (!medium.has(campaign)) medium.set(campaign, (row.utm_medium ?? "").trim());
    if (!Number.isNaN(ts) && !Number.isNaN(cutoffMs) && ts >= cutoffMs) {
      recent.set(campaign, (recent.get(campaign) ?? 0) + 1);
    }
  }

  return [...totals.keys()]
    .map((campaign) => ({
      campaign,
      medium: medium.get(campaign) ?? "",
      visits_total: totals.get(campaign) ?? 0,
      visits_7d: recent.get(campaign) ?? 0,
      first_touch_visitors: [...first.values()].filter((f) => f.campaign === campaign).length,
    }))
    .sort((a, b) => b.visits_total - a.visits_total || a.campaign.localeCompare(b.campaign));
}
