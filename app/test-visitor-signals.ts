/**
 * Bot-vs-human classification unit tests — src/visitor-signals.ts (pure, no
 * server). Run:  bun run test-visitor-signals.ts
 *
 * Covers the bot-false-flag fix (owner finding 2026-08): an empty User-Agent
 * must NOT be treated as a bot. A real, non-search referrer (e.g.
 * indiehackers.com, t.co) leans human even when the UA is missing — a missing
 * UA is an absence of signal, not proof of a crawler. Only a UA that matches a
 * known crawler substring is a bot, and the PR #145 bare-search-homepage
 * reclassification (search_homepage_no_query → likely_bot) must keep working.
 */
import { botStatusFor, isBotUa } from "./src/visitor-signals";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

// ── Empty UA → unknown / human, NEVER bot ──
check("empty UA + no referrer → unknown", botStatusFor("", "") === "unknown", botStatusFor("", ""));
check("blank UA (whitespace) + no referrer → unknown", botStatusFor("   ", "") === "unknown", botStatusFor("   ", ""));
check("empty UA + empty-ish referrer → unknown", botStatusFor("", "   ") === "unknown", botStatusFor("", "   "));

// ── Empty UA + a real non-search referrer → human (the IndieHackers case) ──
check("empty UA + indiehackers referrer → human (not bot)", botStatusFor("", "https://www.indiehackers.com/post/x") === "human", botStatusFor("", "https://www.indiehackers.com/post/x"));
check("empty UA + t.co referrer → human", botStatusFor("", "https://t.co/abc123") === "human", botStatusFor("", "https://t.co/abc123"));
check("empty UA + product-page referrer → human", botStatusFor("", "https://www.example-product.com/landing") === "human", botStatusFor("", "https://www.example-product.com/landing"));
check("empty UA + bare site host referrer → human", botStatusFor("", "indiehackers.com") === "human", botStatusFor("", "indiehackers.com"));

// ── Known-bot UA → bot, even with (or without) a real referrer ──
check("Googlebot UA + no referrer → bot", botStatusFor("Mozilla/5.0 (compatible; Googlebot/2.1)", "") === "bot", botStatusFor("Mozilla/5.0 (compatible; Googlebot/2.1)", ""));
check("known-bot UA + real referrer → bot", botStatusFor("Googlebot/2.1", "https://www.indiehackers.com/post/x") === "bot", botStatusFor("Googlebot/2.1", "https://www.indiehackers.com/post/x"));
check("Expanse/curl UA → bot", botStatusFor("curl/7.68.0", "") === "bot", botStatusFor("curl/7.68.0", ""));
check("isBotUa('') false", isBotUa("") === false, String(isBotUa("")));

// ── search_homepage_no_query (PR #145) must keep mapping to likely_bot ──
check("empty UA + bare google homepage → likely_bot", botStatusFor("", "https://www.google.com/") === "likely_bot", botStatusFor("", "https://www.google.com/"));
check("empty UA + bare bing → likely_bot", botStatusFor("", "https://www.bing.com") === "likely_bot", botStatusFor("", "https://www.bing.com"));
check("empty UA + bare duckduckgo → likely_bot", botStatusFor("", "https://duckduckgo.com/") === "likely_bot", botStatusFor("", "https://duckduckgo.com/"));
check("human UA + bare google homepage → likely_bot", botStatusFor("Mozilla/5.0 Chrome/120.0", "https://www.google.com/") === "likely_bot", botStatusFor("Mozilla/5.0 Chrome/120.0", "https://www.google.com/"));
check("real search WITH query stays human (not likely_bot)", botStatusFor("", "https://www.google.com/search?q=collectionscopilot") === "human", botStatusFor("", "https://www.google.com/search?q=collectionscopilot"));

// ── Present human UA → human ──
check("human UA + no referrer → human", botStatusFor("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0", "") === "human", botStatusFor("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0", ""));
check("human UA + real referrer → human", botStatusFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "https://t.co/abc") === "human", botStatusFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "https://t.co/abc"));

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nAll visitor-signal classification checks passed.");
