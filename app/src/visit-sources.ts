/**
 * Channel attribution for the internal admin dashboard — visit bucketing
 * (owner request 2026-08-13: "I'd like to be able to track where they came
 * from.").
 *
 * Pure, deterministic, fully unit-testable (no DB, no IO). Consumed by
 * routes/admin.ts to build the /admin/data `visits_by_source` breakdown and by
 * test-visit-sources.ts for the unit tests.
 *
 * Bucketing rule (deterministic):
 *   1. If utm_source is present (non-empty after trim) → the bucket is that
 *      value, lowercased + whitespace-trimmed (e.g. "x", "reddit",
 *      "indiehackers", "betalist", "viberank", "google", "bing", ...).
 *   2. Else if referrer is non-empty → map the referrer's host:
 *        twitter.com / x.com            → "x"
 *        reddit.com                     → "reddit"
 *        news.ycombinator.com           → "hackernews"
 *        indiehackers.com               → "indiehackers"
 *        google.*                       → "google"
 *        bing.*                         → "bing"
 *        duckduckgo.com                 → "duckduckgo"
 *        linkedin.com                   → "linkedin"
 *        anything else                  → "referral:" + host
 *   3. Else → "direct".
 */

export interface VisitForAttribution {
  id: number | bigint;
  visitor_id: string;
  referrer: string;
  utm_source: string;
  ts: string;
}

export interface SourceBucket {
  bucket: string;
  visits_total: number;
  visits_7d: number;
  first_touch_visitors: number;
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
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    return "reddit";
  }
  if (host === "news.ycombinator.com") {
    return "hackernews";
  }
  if (host === "indiehackers.com" || host.endsWith(".indiehackers.com")) {
    return "indiehackers";
  }
  // google.* / bing.* — matches the bare TLD and the www./m./<country> variants
  // (google.com, www.google.com, google.co.uk, www.google.co.uk, bing.com.au, ...).
  if (/(^|\.)google\.([a-z]{2,3}|com)(\.[a-z]{2})?$/.test(host)) return "google";
  if (/(^|\.)bing\.([a-z]{2,3}|com)(\.[a-z]{2})?$/.test(host)) return "bing";
  if (/(^|\.)duckduckgo\.com$/.test(host)) return "duckduckgo";
  if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";

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
 *
 * Buckets are sorted visits_total desc, then bucket name asc (deterministic).
 * Rows with an unparseable ts count toward visits_total but never toward
 * visits_7d (they are not "recent").
 */
export function aggregateVisitsBySource(rows: VisitForAttribution[], cutoff7dIso: string): SourceBucket[] {
  const cutoffMs = epochMs(cutoff7dIso);
  const totals = new Map<string, number>();
  const recent = new Map<string, number>();
  // visitor_id → info about its earliest visit (ts epoch, row id, bucket)
  const first = new Map<string, { ts: number; id: number; bucket: string }>();

  for (const row of rows) {
    const bucket = bucketVisit(row);
    totals.set(bucket, (totals.get(bucket) ?? 0) + 1);

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
      buckets.set(b, { bucket: b, visits_total: totals.get(b) ?? 0, visits_7d: recent.get(b) ?? 0, first_touch_visitors: 0 });
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
