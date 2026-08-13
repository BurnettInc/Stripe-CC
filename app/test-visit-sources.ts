/**
 * Channel-attribution unit tests — src/visit-sources.ts (pure, no server).
 *
 * Proves:
 *   (a) bucketVisit: utm_source wins over referrer; lowercased + trimmed
 *   (b) bucketVisit: referrer-host mapping (twitter.com/x.com/t.co/x.co → "x",
 *       facebook.com/fb.com → "facebook", reddit → "reddit",
 *       news.ycombinator.com → "hackernews", indiehackers → "indiehackers",
 *       producthunt → "producthunt", betalist → "betalist",
 *       viberank → "viberank", stripe/dashboard.stripe.com → "stripe",
 *       google.* → "google", bing.* → "bing", duckduckgo → "duckduckgo",
 *       linkedin/lnkd.in → "linkedin", else "referral:" + host)
 *   (c) bucketVisit: direct fallback (no utm, no referrer / empty referrer)
 *   (d) referrerHost: full URLs, bare hosts, port stripping, garbage → ""
 *   (e) aggregateVisitsBySource: per-bucket all-time + 7d counts
 *   (f) aggregateVisitsBySource: first-touch attribution (earliest visit per
 *       visitor wins, ts then id tiebreak) + unique visitors per bucket
 *   (g) aggregateVisitsBySource: deterministic sort (visits_total desc,
 *       bucket asc)
 *   (h) displayBucketName: friendly names (known channels, referral:host,
 *       title-cased utm values)
 *   (i) aggregateVisitsBySource: per-bucket `hosts` (raw referrer hosts, incl.
 *       utm+referrer combos; dedupe + first-appearance order; direct → []) and
 *       server-provided `display` on buckets
 *   (j) aggregateUtmCampaigns: utm_campaign rollup (counts, medium of first
 *       row, first-touch semantics, sort, exclusions)
 *
 * Run:  bun run test-visit-sources.ts
 */
import {
  aggregateUtmCampaigns,
  aggregateVisitsBySource,
  bucketVisit,
  displayBucketName,
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
check("t.co shortener → x", bucketVisit({ referrer: "https://t.co/WAHrqBU17H" }) === "x", bucketVisit({ referrer: "https://t.co/WAHrqBU17H" }));
check("x.co shortener → x", bucketVisit({ referrer: "https://x.co/abc123" }) === "x", bucketVisit({ referrer: "https://x.co/abc123" }));
check("reddit.com → reddit", bucketVisit({ referrer: "https://www.reddit.com/r/saas/comments/1/" }) === "reddit", bucketVisit({ referrer: "https://www.reddit.com/r/saas/comments/1/" }));
check("old.reddit.com → reddit", bucketVisit({ referrer: "https://old.reddit.com/r/sideproject/" }) === "reddit", bucketVisit({ referrer: "https://old.reddit.com/r/sideproject/" }));
check("news.ycombinator.com → hackernews", bucketVisit({ referrer: "https://news.ycombinator.com/item?id=42" }) === "hackernews", bucketVisit({ referrer: "https://news.ycombinator.com/item?id=42" }));
check("indiehackers.com → indiehackers", bucketVisit({ referrer: "https://www.indiehackers.com/post/x" }) === "indiehackers", bucketVisit({ referrer: "https://www.indiehackers.com/post/x" }));
check("google.com → google", bucketVisit({ referrer: "https://www.google.com/search?q=x" }) === "google", bucketVisit({ referrer: "https://www.google.com/search?q=x" }));
check("google.co.uk → google", bucketVisit({ referrer: "https://www.google.co.uk/search" }) === "google", bucketVisit({ referrer: "https://www.google.co.uk/search" }));
check("bing.com → bing", bucketVisit({ referrer: "https://www.bing.com/search?q=x" }) === "bing", bucketVisit({ referrer: "https://www.bing.com/search?q=x" }));
check("duckduckgo.com → duckduckgo", bucketVisit({ referrer: "https://duckduckgo.com/?q=x" }) === "duckduckgo", bucketVisit({ referrer: "https://duckduckgo.com/?q=x" }));
check("linkedin.com → linkedin", bucketVisit({ referrer: "https://www.linkedin.com/feed/" }) === "linkedin", bucketVisit({ referrer: "https://www.linkedin.com/feed/" }));
check("lnkd.in shortener → linkedin", bucketVisit({ referrer: "https://lnkd.in/xyz789" }) === "linkedin", bucketVisit({ referrer: "https://lnkd.in/xyz789" }));
check("producthunt.com → producthunt", bucketVisit({ referrer: "https://www.producthunt.com/posts/collectionscopilot" }) === "producthunt", bucketVisit({ referrer: "https://www.producthunt.com/posts/collectionscopilot" }));
check("producthunt subdomain → producthunt", bucketVisit({ referrer: "https://launches.producthunt.com/collectionscopilot" }) === "producthunt", bucketVisit({ referrer: "https://launches.producthunt.com/collectionscopilot" }));
check("stripe.com → stripe", bucketVisit({ referrer: "https://stripe.com/blog/collectionscopilot" }) === "stripe", bucketVisit({ referrer: "https://stripe.com/blog/collectionscopilot" }));
check("dashboard.stripe.com → stripe", bucketVisit({ referrer: "https://dashboard.stripe.com/apps/app_com.example" }) === "stripe", bucketVisit({ referrer: "https://dashboard.stripe.com/apps/app_com.example" }));
check("betalist.com → betalist", bucketVisit({ referrer: "https://betalist.com/startups/collectionscopilot" }) === "betalist", bucketVisit({ referrer: "https://betalist.com/startups/collectionscopilot" }));
check("betalist subdomain → betalist", bucketVisit({ referrer: "https://www.betalist.com/startups/collectionscopilot" }) === "betalist", bucketVisit({ referrer: "https://www.betalist.com/startups/collectionscopilot" }));
check("viberank.dev → viberank", bucketVisit({ referrer: "https://viberank.dev/product/collectionscopilot" }) === "viberank", bucketVisit({ referrer: "https://viberank.dev/product/collectionscopilot" }));
check("viberank subdomain → viberank", bucketVisit({ referrer: "https://www.viberank.dev/collectionscopilot" }) === "viberank", bucketVisit({ referrer: "https://www.viberank.dev/collectionscopilot" }));
check("facebook.com → facebook", bucketVisit({ referrer: "https://www.facebook.com/collectionscopilot/" }) === "facebook", bucketVisit({ referrer: "https://www.facebook.com/collectionscopilot/" }));
check("m.facebook.com → facebook", bucketVisit({ referrer: "https://m.facebook.com/story.php?story_fbid=1" }) === "facebook", bucketVisit({ referrer: "https://m.facebook.com/story.php?story_fbid=1" }));
check("l.facebook.com → facebook", bucketVisit({ referrer: "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.getcollectionscopilot.com" }) === "facebook", bucketVisit({ referrer: "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.getcollectionscopilot.com" }));
check("fb.com shortener → facebook", bucketVisit({ referrer: "https://fb.com/abc123" }) === "facebook", bucketVisit({ referrer: "https://fb.com/abc123" }));
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
const row = (id: number, visitor_id: string, ts: string, extra: Partial<Pick<VisitForAttribution, "referrer" | "utm_source" | "utm_medium" | "utm_campaign">> = {}): VisitForAttribution =>
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

// ── (h) displayBucketName (friendly names, pure + deterministic) ──
const displayCases: Array<[string, string]> = [
  ["x", "X / Twitter"], ["reddit", "Reddit"], ["hackernews", "Hacker News"],
  ["indiehackers", "Indie Hackers"], ["producthunt", "Product Hunt"], ["betalist", "BetaList"],
  ["viberank", "VibeRank"], ["stripe", "Stripe"], ["google", "Google"], ["bing", "Bing"],
  ["duckduckgo", "DuckDuckGo"], ["linkedin", "LinkedIn"], ["facebook", "Facebook"], ["direct", "Direct"],
  ["referral:example.com", "example.com"], ["referral:sub.example.org", "sub.example.org"],
];
for (const [bucket, want] of displayCases) {
  check(`displayBucketName("${bucket}") → "${want}"`, displayBucketName(bucket) === want, displayBucketName(bucket));
}
check("displayBucketName unknown utm value title-cased", displayBucketName("my-campaign_2") === "My Campaign 2", displayBucketName("my-campaign_2"));
check("displayBucketName unknown single word title-cased", displayBucketName("newsletter") === "Newsletter", displayBucketName("newsletter"));
check("displayBucketName empty → empty", displayBucketName("") === "", displayBucketName(""));

// ── (i) hosts per bucket (incl. utm+referrer combo) + display on buckets ──
const comboRows: VisitForAttribution[] = [
  row(30, "host-a", iso(0), { utm_source: "google", referrer: "https://t.co/abc" }),          // utm bucket, referrer host t.co
  row(31, "host-a", iso(-1000), { utm_source: "google", referrer: "https://www.google.com/search" }), // second host, first-appearance order
  row(32, "host-b", iso(-2000), { utm_source: "google", referrer: "https://t.co/def" }),      // t.co again → dedup
  row(33, "host-c", iso(-3000), { referrer: "https://www.reddit.com/r/x/" }),                 // referrer-driven bucket
  row(34, "host-d", iso(-4000), {}),                                                          // direct → no hosts
];
const comboBuckets = aggregateVisitsBySource(comboRows, cutoff7d);
const cg = comboBuckets.find((b) => b.bucket === "google");
const cr = comboBuckets.find((b) => b.bucket === "reddit");
const cd = comboBuckets.find((b) => b.bucket === "direct");
check("utm bucket hosts include the referrer host (utm+referrer combo)", !!cg && cg.hosts.includes("t.co"), JSON.stringify(cg));
check("utm bucket hosts dedupe and keep first-appearance order", !!cg && cg.hosts.join(",") === "t.co,www.google.com", JSON.stringify(cg));
check("referrer-driven bucket hosts", !!cr && cr.hosts.join(",") === "www.reddit.com", JSON.stringify(cr));
check("direct bucket hosts is an empty array", !!cd && Array.isArray(cd.hosts) && cd.hosts.length === 0, JSON.stringify(cd));
check("buckets carry server-provided display names",
  !!cg && cg.display === "Google" && cr?.display === "Reddit" && cd?.display === "Direct",
  JSON.stringify(comboBuckets.map((b) => b.display)));
// The earlier fixture's buckets also carry hosts (twitter referrer → x).
check("existing x bucket hosts twitter.com", byBucket("x")?.hosts.join(",") === "twitter.com", JSON.stringify(byBucket("x")?.hosts));

// ── (j) aggregateUtmCampaigns (utm_campaign rollup) ──
const campRows: VisitForAttribution[] = [
  row(40, "cv-a", iso(0), { utm_source: "x", utm_medium: "social", utm_campaign: "launch" }),
  row(41, "cv-a", iso(-1000), { utm_source: "x", utm_medium: "social", utm_campaign: "launch" }),
  row(42, "cv-b", iso(-2000), { utm_source: "google", utm_medium: "cpc", utm_campaign: "summer" }),
  row(43, "cv-c", iso(-9 * 86400000), { referrer: "https://reddit.com/r/x/" }),                // no campaign → excluded
  row(44, "cv-d", iso(0), { utm_source: "x", utm_medium: "", utm_campaign: "launch" }),        // medium of FIRST row wins
  row(45, "cv-e", iso(-5 * 86400000), {}),                                                     // earliest visit: no campaign
  row(46, "cv-e", iso(0), { utm_source: "x", utm_campaign: "late" }),                          // later visit: has campaign
];
const camps = aggregateUtmCampaigns(campRows, cutoff7d);
const camp = (c: string) => camps.find((x) => x.campaign === c);
check("utm_campaigns sorts visits_total desc then campaign asc",
  camps.length === 3 && camps[0].campaign === "launch" && camps[1].campaign === "late" && camps[2].campaign === "summer",
  JSON.stringify(camps));
check("launch campaign: 3 visits, 7d 3, medium from first row seen (social), 2 first-touch (cv-a + cv-d)",
  camp("launch")?.visits_total === 3 && camp("launch")?.visits_7d === 3 &&
  camp("launch")?.medium === "social" && camp("launch")?.first_touch_visitors === 2,
  JSON.stringify(camp("launch")));
check("summer campaign: 1 visit, medium cpc, 1 first-touch (cv-b)",
  camp("summer")?.visits_total === 1 && camp("summer")?.visits_7d === 1 &&
  camp("summer")?.medium === "cpc" && camp("summer")?.first_touch_visitors === 1,
  JSON.stringify(camp("summer")));
check("rows without utm_campaign are excluded from the rollup", camps.length === 3, JSON.stringify(camps));
check("visitor whose FIRST visit lacks a campaign gets NO campaign first-touch",
  camp("late")?.visits_total === 1 && camp("late")?.visits_7d === 1 && camp("late")?.first_touch_visitors === 0,
  JSON.stringify(camp("late")));
check("empty utm_campaign treated as absent (no rollup rows)", aggregateUtmCampaigns([row(50, "cv-z", iso(0), { utm_medium: "x" })], cutoff7d).length === 0);
check("empty input → empty array", aggregateUtmCampaigns([], cutoff7d).length === 0);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll visit-source checks passed");
process.exit(failures ? 1 : 0);
