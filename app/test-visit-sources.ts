/**
 * Channel-attribution unit tests — src/visit-sources.ts (pure, no server).
 *
 * Proves:
 *   (a) bucketVisit: utm_source wins over referrer; lowercased + trimmed
 *   (b) bucketVisit: referrer-host mapping (twitter.com/x.com → "x",
 *       reddit → "reddit", news.ycombinator.com → "hackernews",
 *       indiehackers → "indiehackers", google.* → "google", bing.* → "bing",
 *       duckduckgo → "duckduckgo", linkedin → "linkedin", else
 *       "referral:" + host)
 *   (c) bucketVisit: direct fallback (no utm, no referrer / empty referrer)
 *   (d) referrerHost: full URLs, bare hosts, port stripping, garbage → ""
 *   (e) aggregateVisitsBySource: per-bucket all-time + 7d counts
 *   (f) aggregateVisitsBySource: first-touch attribution (earliest visit per
 *       visitor wins, ts then id tiebreak) + unique visitors per bucket
 *   (g) aggregateVisitsBySource: deterministic sort (visits_total desc,
 *       bucket asc)
 *
 * Run:  bun run test-visit-sources.ts
 */
import {
  aggregateVisitsBySource,
  bucketVisit,
  referrerHost,
  type VisitForAttribution,
} from "./src/visit-sources";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

// ── (a) utm wins over referrer, lowercased + trimmed ──
check("utm x wins over a referrer", bucketVisit({ utm_source: "X", referrer: "https://news.ycombinator.com/item?id=1" }) === "x", bucketVisit({ utm_source: "X", referrer: "https://news.ycombinator.com/item?id=1" }));
check("utm trimmed + lowercased", bucketVisit({ utm_source: "  Reddit  ", referrer: "" }) === "reddit", bucketVisit({ utm_source: "  Reddit  ", referrer: "" }));
check("utm bing wins over google referrer", bucketVisit({ utm_source: "bing", referrer: "https://www.google.com/" }) === "bing", bucketVisit({ utm_source: "bing", referrer: "https://www.google.com/" }));
check("utm empty string treated as absent", bucketVisit({ utm_source: "   ", referrer: "https://twitter.com/u/1" }) === "x", bucketVisit({ utm_source: "   ", referrer: "https://twitter.com/u/1" }));

// ── (b) referrer host mapping ──
check("twitter.com → x", bucketVisit({ referrer: "https://twitter.com/some/status/1" }) === "x", bucketVisit({ referrer: "https://twitter.com/some/status/1" }));
check("x.com → x", bucketVisit({ referrer: "https://x.com/me/status/2" }) === "x", bucketVisit({ referrer: "https://x.com/me/status/2" }));
check("mobile twitter → x", bucketVisit({ referrer: "https://mobile.twitter.com/u" }) === "x", bucketVisit({ referrer: "https://mobile.twitter.com/u" }));
check("reddit.com → reddit", bucketVisit({ referrer: "https://www.reddit.com/r/saas/comments/1/" }) === "reddit", bucketVisit({ referrer: "https://www.reddit.com/r/saas/comments/1/" }));
check("old.reddit.com → reddit", bucketVisit({ referrer: "https://old.reddit.com/r/sideproject/" }) === "reddit", bucketVisit({ referrer: "https://old.reddit.com/r/sideproject/" }));
check("news.ycombinator.com → hackernews", bucketVisit({ referrer: "https://news.ycombinator.com/item?id=42" }) === "hackernews", bucketVisit({ referrer: "https://news.ycombinator.com/item?id=42" }));
check("indiehackers.com → indiehackers", bucketVisit({ referrer: "https://www.indiehackers.com/post/x" }) === "indiehackers", bucketVisit({ referrer: "https://www.indiehackers.com/post/x" }));
check("google.com → google", bucketVisit({ referrer: "https://www.google.com/search?q=x" }) === "google", bucketVisit({ referrer: "https://www.google.com/search?q=x" }));
check("google.co.uk → google", bucketVisit({ referrer: "https://www.google.co.uk/search" }) === "google", bucketVisit({ referrer: "https://www.google.co.uk/search" }));
check("bing.com → bing", bucketVisit({ referrer: "https://www.bing.com/search?q=x" }) === "bing", bucketVisit({ referrer: "https://www.bing.com/search?q=x" }));
check("duckduckgo.com → duckduckgo", bucketVisit({ referrer: "https://duckduckgo.com/?q=x" }) === "duckduckgo", bucketVisit({ referrer: "https://duckduckgo.com/?q=x" }));
check("linkedin.com → linkedin", bucketVisit({ referrer: "https://www.linkedin.com/feed/" }) === "linkedin", bucketVisit({ referrer: "https://www.linkedin.com/feed/" }));
check("unknown host → referral:<host>", bucketVisit({ referrer: "https://example.com/page" }) === "referral:example.com", bucketVisit({ referrer: "https://example.com/page" }));
check("unknown host keeps subdomain in referral bucket", bucketVisit({ referrer: "https://sub.example.org/x" }) === "referral:sub.example.org", bucketVisit({ referrer: "https://sub.example.org/x" }));

// ── (c) direct fallback ──
check("no utm, no referrer → direct", bucketVisit({}) === "direct", bucketVisit({}));
check("empty referrer string → direct", bucketVisit({ referrer: "" }) === "direct", bucketVisit({ referrer: "" }));
check("garbage referrer → direct (falls back to empty host)", bucketVisit({ referrer: "not a url at all" }) === "direct", bucketVisit({ referrer: "not a url at all" }));

// ── (d) referrerHost ──
check("full URL host extracted", referrerHost("https://www.google.com/search?q=x") === "www.google.com", referrerHost("https://www.google.com/search?q=x"));
check("bare host gets a scheme", referrerHost("google.com") === "google.com", referrerHost("google.com"));
check("host lowercased", referrerHost("https://NEWS.YCOMBINATOR.COM/item") === "news.ycombinator.com", referrerHost("https://NEWS.YCOMBINATOR.COM/item"));
check("port stripped", referrerHost("https://localhost:3000/x") === "localhost", referrerHost("https://localhost:3000/x"));
check("garbage → empty host", referrerHost("!! not a url") === "", referrerHost("!! not a url"));
check("empty → empty host", referrerHost("") === "", referrerHost(""));
check("whitespace → empty host", referrerHost("   ") === "", referrerHost("   "));

// ── (e)+(f)+(g) aggregation ──
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const row = (id: number, visitor_id: string, ts: string, extra: Partial<Pick<VisitForAttribution, "referrer" | "utm_source">> = {}): VisitForAttribution =>
  ({ id, visitor_id, page: "/", referrer: "", utm_source: "", ts, ...extra } as VisitForAttribution);

const cutoff7d = iso(-6 * 86400000); // 6 days ago — recent window
const rows: VisitForAttribution[] = [
  // Visitor A: two visits, both utm google (one recent, one older than 7d).
  row(1, "visitor-a", iso(0), { utm_source: "google" }),              // recent
  row(2, "visitor-a", iso(-8 * 86400000), { utm_source: "google" }),  // old
  // Visitor B: bare (direct), recent.
  row(3, "visitor-b", iso(-1000), {}),
  // Visitor C: twitter referrer, recent.
  row(4, "visitor-c", iso(-2000), { referrer: "https://twitter.com/u/1" }),
  // Visitor D: hackernews referrer, old.
  row(5, "visitor-d", iso(-9 * 86400000), { referrer: "https://news.ycombinator.com/item?id=9" }),
  // Visitor E: first visit from reddit referrer (old), second visit utm bing (recent) — first-touch must be reddit.
  row(6, "visitor-e", iso(-10 * 86400000), { referrer: "https://www.reddit.com/r/saas/" }),
  row(7, "visitor-e", iso(-1000), { utm_source: "bing" }),
];
const buckets = aggregateVisitsBySource(rows, cutoff7d);

const byBucket = (b: string) => buckets.find((x) => x.bucket === b);

check("aggregation returns 6 buckets sorted by visits_total desc then bucket asc",
  buckets.length === 6 &&
  buckets[0].bucket === "google" && buckets[0].visits_total === 2 &&
  buckets[1].bucket === "bing" && buckets[4].bucket === "reddit" && buckets[5].bucket === "x",
  JSON.stringify(buckets.map((b) => b.bucket)));

check("google bucket: 2 visits all-time, 1 in 7d, 1 first-touch (visitor A)",
  byBucket("google")?.visits_total === 2 && byBucket("google")?.visits_7d === 1 && byBucket("google")?.first_touch_visitors === 1,
  JSON.stringify(byBucket("google")));

check("direct bucket: 1 visit, 1 in 7d, 1 first-touch (visitor B)",
  byBucket("direct")?.visits_total === 1 && byBucket("direct")?.visits_7d === 1 && byBucket("direct")?.first_touch_visitors === 1,
  JSON.stringify(byBucket("direct")));

check("x bucket: 1 visit, 1 first-touch (visitor C)",
  byBucket("x")?.visits_total === 1 && byBucket("x")?.visits_7d === 1 && byBucket("x")?.first_touch_visitors === 1,
  JSON.stringify(byBucket("x")));

check("hackernews bucket: 1 visit all-time, 0 in 7d, 1 first-touch (visitor D)",
  byBucket("hackernews")?.visits_total === 1 && byBucket("hackernews")?.visits_7d === 0 && byBucket("hackernews")?.first_touch_visitors === 1,
  JSON.stringify(byBucket("hackernews")));

check("bing bucket: 1 visit (visitor E's second), 0 first-touch (E's first was reddit)",
  byBucket("bing")?.visits_total === 1 && byBucket("bing")?.visits_7d === 1 && byBucket("bing")?.first_touch_visitors === 0,
  JSON.stringify(byBucket("bing")));

check("reddit bucket: 1 visit, 1 first-touch (visitor E's earliest visit)",
  byBucket("reddit")?.visits_total === 1 && byBucket("reddit")?.visits_7d === 0 && byBucket("reddit")?.first_touch_visitors === 1,
  JSON.stringify(byBucket("reddit")));

const firstTouchTotal = buckets.reduce((s, b) => s + b.first_touch_visitors, 0);
check("first-touch visitors sum to distinct visitors (5)", firstTouchTotal === 5, `sum=${firstTouchTotal}`);

// Tie-break: same ts, lower id wins for first-touch.
const tieRows: VisitForAttribution[] = [
  row(10, "visitor-t", iso(0), { referrer: "https://x.com/tie" }),
  row(9, "visitor-t", iso(0), {}), // same ts, LOWER id → direct wins
];
const tieBuckets = aggregateVisitsBySource(tieRows, cutoff7d);
check("first-touch tie-break: same ts, lower row id wins",
  tieBuckets.find((b) => b.bucket === "direct")?.first_touch_visitors === 1 &&
  tieBuckets.find((b) => b.bucket === "x")?.first_touch_visitors === 0,
  JSON.stringify(tieBuckets));

// Empty input → empty array.
check("empty input → empty array", Array.isArray(aggregateVisitsBySource([], cutoff7d)) && aggregateVisitsBySource([], cutoff7d).length === 0);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll visit-source checks passed");
process.exit(failures ? 1 : 0);
