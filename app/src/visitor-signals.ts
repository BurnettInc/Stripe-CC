/**
 * Visitor-signal helpers for the internal admin dashboard's visit attribution
 * (owner approved 2026-08-26: capture IP + User-Agent on our own site's
 * first-party, token-gated, internal-only analytics).
 *
 * Pure + deterministic (no DB, no IO, no external services) — fully
 * unit-testable. Consumed by app/src/routes/track.ts (maskIp on capture) and
 * app/src/routes/admin.ts (device/OS/browser/bot/country classification for the
 * /admin/data payload).
 *
 * Goal is bot / uniq-device classification, NOT personal identity — see
 * maskIp() below for the privacy-by-default masking scheme.
 */
import { isBareSearchHomepage } from "./visit-sources";

export interface DeviceClass {
  /** "desktop" | "mobile" | "tablet" | "unknown" */
  device: string;
  os: string;
  browser: string;
}

/** UA substrings that unambiguously identify a bot/crawler/spider/automation.
 *  Case-insensitive match on the lowercased UA. Kept deliberately broad — a
 *  false "bot" on an internal dashboard is harmless; a false "human" hides the
 *  exact noise the owner wants to see (query-less crawler bursts). */
const BOT_UA_RE =
  /bot|crawler|spider|slurp|scan|fetch|curl|wget|python-requests|python-urllib|python\/|go-http-client|node-fetch|node\.js|axios|okhttp|httpclient|headless|phantom|playwright|puppeteer|selenium|screaming|monitor|uptime|pingdom|statuscake|preview|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|slackbot|discordbot|bingbot|googlebot|duckduckbot|baiduspider|yandex|softbank|petalbot|semrush|ahrefs|dotbot|mj12|rogerbot|exabot|bytespider|archive\.org|mediapartners|gptbot|ccbot|anthropic|claude|perplexity|oai-search|amazonbot|applebot|gpt-crawler/i;

/** True when the User-Agent is a known bot/crawler/automation client. */
export function isBotUa(ua: string): boolean {
  const u = (ua || "").trim();
  if (!u) return false;
  return BOT_UA_RE.test(u.toLowerCase());
}

/** Classify device type, OS and browser from a User-Agent string using basic
 *  substring heuristics (no external device-detection library). Each returns
 *  "unknown" when the UA is empty/absent. */
export function classifyDevice(ua: string): DeviceClass {
  const u = (ua || "").toLowerCase();
  const out: DeviceClass = { device: "unknown", os: "unknown", browser: "unknown" };
  if (!u) return out;

  // Device type — check tablet before generic mobile (iPads carry "mobile" too).
  if (/ipad|tablet|playbook|silk|kindle|nook|sm-t|sm-p|sm-x|gt-p|kf/i.test(u)) out.device = "tablet";
  else if (/mobi|iphone|android|windows phone|opera mini|fennec|blackberry/i.test(u)) out.device = "mobile";
  else out.device = "desktop";

  // OS
  if (/windows nt 10|windows nt 6\.|windows phone/i.test(u)) out.os = "Windows";
  else if (/android/i.test(u)) out.os = "Android";
  else if (/iphone|ipad|ipod|cfnetwork|darwin/i.test(u)) out.os = "iOS";
  else if (/mac os x|macintosh/i.test(u)) out.os = "macOS";
  else if (/cros/i.test(u)) out.os = "Chrome OS";
  else if (/linux/i.test(u)) out.os = "Linux";
  else if (/x11/i.test(u)) out.os = "Unix";

  // Browser — Chrome-family order matters (Edge/Opera/Chromium all contain "Chrome").
  if (/edg(e|aio)?\//i.test(u)) out.browser = "Edge";
  else if (/opr\/|opera/i.test(u)) out.browser = "Opera";
  else if (/chrome\//i.test(u) && !/chromium/i.test(u)) out.browser = "Chrome";
  else if (/chromium/i.test(u)) out.browser = "Chromium";
  else if (/firefox\/|seamonkey/i.test(u)) out.browser = "Firefox";
  // By this point no Chrome-family marker fired, so a "safari" substring
  // (or a bare "mobile/…" token) reliably means Safari — lenient on the
  // slash (some engines emit "Safari ").
  else if (/safari/i.test(u) || /mobile\/\d/i.test(u)) out.browser = "Safari";

  return out;
}

/**
 * Determine a visit's bot-vs-human estimate from its User-Agent and referrer:
 *   "bot"        — UA matches a known bot/crawler substring. ONLY a matching UA
 *                  proves a bot (owner finding 2026-08: a real referral click
 *                  from a curated directory like Indie Hackers was flagged bot
 *                  solely because its stored UA was '' — the server header
 *                  simply wasn't captured for many early visits).
 *   "likely_bot" — referrer is a search engine's BARE homepage (root path, no
 *                  query → cannot be a real search; the classic crawler burst
 *                  pattern, see isBareSearchHomepage in visit-sources.ts). This
 *                  is checked even when the UA is empty: the bare homepage is
 *                  itself bot evidence (kept from PR #145).
 *   "human"      — positive human evidence: a present, non-bot UA, OR a real
 *                  non-search referrer (a person following a link from a real
 *                  site — indiehackers.com, t.co, a product page, etc.). An
 *                  absent UA is NOT treated as bot evidence; a credible
 *                  referrer leans human even when the UA is missing/empty.
 *   "unknown"    — no signal at all (no UA AND no real referrer to reason from).
 */
export function botStatusFor(ua: string, referrer: string): string {
  if (isBotUa(ua)) return "bot";
  const ref = (referrer || "").trim();
  if (ref && isBareSearchHomepage(ref)) return "likely_bot";
  // Positive human evidence = a present UA, OR any non-empty referrer that is
  // not a bare search homepage.
  const hasUa = !!(ua || "").trim();
  const nonSearchReferrer = ref !== "" && !isBareSearchHomepage(ref);
  if (hasUa || nonSearchReferrer) return "human";
  return "unknown";
}

/**
 * Privacy-by-default IP masking (documented scheme):
 *   * IPv4             → last octet dropped, kept as the /24 network:
 *                        "203.0.113.42" → "203.0.113.x". Identifies the
 *                        /24 subnet (fine for uniq-device / geo / bot
 *                        classification), not the individual host.
 *   * IPv4-in-IPv6     → "::ffff:203.0.113.42" → "::ffff:203.0.113.x".
 *   * IPv6             → host half masked, kept as the /64 network prefix:
 *                        "2001:db8::1:2:3:4" → "2001:db8::". A /64 is the
 *                        standard network-addressed host boundary.
 *   * loopback/private → "127.0.0.1" / "::1" pass through (local dev traffic,
 *                        not a routable identity).
 *   * unparseable      → a stable coarse label ("ipv4" / "ipv6" / "") rather
 *                        than echoing an arbitrary string.
 *
 * The raw IP is never persisted; only this masked form is stored in
 * page_visits.ip.
 */
export function maskIp(raw: string): string {
  const ip = (raw || "").trim().split("%")[0]; // strip IPv6 scope zone
  if (!ip) return "";
  if (ip === "::1" || ip === "127.0.0.1" || ip === "0.0.0.0") return ip;
  const v4 = ip.match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (v4) return ip.replace(/^((?:\d{1,3}\.){3})\d{1,3}$/, "$1x");
  const v4in6 = ip.match(/^(.+?:(?:ffff:)?)(\d{1,3}\.\d{1,3}\.\d{1,3}\.)\d{1,3}$/i);
  if (v4in6) return `${v4in6[1]}${v4in6[2]}x`;
  if (ip.includes(":")) return maskV6(ip);
  return "ipv4";
}

/** Mask an IPv6 address to its /64 network prefix (first 4 hextets), handling
 *  "::" compression. e.g. "2001:db8::1:2:3:4" → "2001:db8::" and
 *  "2001:db8:1:2:1:2:3:4" → "2001:db8:1:2::". Unparseable → coarse "ipv6". */
function maskV6(ip: string): string {
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return "ipv6";
  let parts: string[];
  if (ip.includes("::")) {
    const [left, right] = ip.split("::");
    const l = left ? left.split(":") : [];
    const r = right ? right.split(":") : [];
    const fill = 8 - l.length - r.length;
    if (fill < 0) return "ipv6";
    parts = [...l, ...new Array(fill).fill("0"), ...r];
  } else {
    parts = ip.split(":");
    if (parts.length !== 8) return "ipv6";
  }
  return formatV6Prefix(parts.slice(0, 4));
}

/** Join 4 hextets into a /64 prefix string with conventional compression:
 *  strip leading zeros per hextet, drop trailing zero-hextets, add "::". */
function formatV6Prefix(hextets: string[]): string {
  const stripped = hextets.map((h) => h.replace(/^0+(?=[0-9a-fA-F])/, "") || "0");
  let end = stripped.length;
  while (end > 0 && stripped[end - 1] === "0") end--;
  return (end === 0 ? "::" : stripped.slice(0, end).join(":") + "::");
}
