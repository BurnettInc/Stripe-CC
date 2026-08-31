import type { Database } from "bun:sqlite";
import { recordPageVisit, markPageVisitVerified } from "../db";
import { maskIp } from "../visitor-signals";
/**
 * POST /api/track (also /track — the dev site proxy strips the /api prefix
 * before forwarding) — first-party, privacy-minimal landing-page visit
 * tracking for the internal admin dashboard.
 *
 * Payload (JSON, all optional except visitor_id + page):
 *   { visitor_id, page, referrer?, utm_source?, utm_medium?, utm_campaign?, utm_content?, ts?, ua? }
 *
 * Privacy-by-default (owner approved 2026-08-26 — own-site, first-party,
 * token-gated, internal-only analytics; never touches merchant data or the
 * Stripe App):
 *   * ip        — read SERVER-side from a trusted proxy header (CF-Connecting-IP
 *                 or X-Forwarded-For's first hop, else X-Real-IP), then MASKED
 *                 via maskIp() (IPv4 last octet dropped → /24; IPv6 host half
 *                 masked → /64). The raw IP is never stored. A client-supplied
 *                 ip is never trusted/accepted from the body.
 *   * user_agent — read from the request's User-Agent header (a real browser
 *                 always sends it), with the beacon's `ua` field used only as a
 *                 fallback when the header is absent (e.g. some proxies strip it).
 *   * country    — derived server-side from a proxy country header
 *                 (CF-IPCountry) when the platform forwards one; NO external
 *                 geo service is ever called. "" when unavailable.
 *
 * The purpose is bot / uniq-device / geo classification so query-less or
 * no-referrer visits are no longer an unclassifiable "direct" blob — not
 * individual identification.
 *
 * Storing is idempotent-ish: the UNIQUE(visitor_id, page, ts) index turns a
 * retried beacon with an identical payload into a no-op.
 *
 * Returns 200 {ok:true} on success, 400 on a malformed payload. The endpoint
 * is intentionally public (no token): it exists to collect visits, and the
 * data it stores is non-identifying (a random per-browser UUID + masked IP).
 */

/** Client IP for classification: Cloudflare's CN header, else first
 *  X-Forwarded-For hop, else X-Real-IP, else localhost. Follows the existing
 *  clientIpFor convention in waitlist.ts / accounts.ts but prefer CF (the site
 *  is Cloudflare-proxied and CF-Connecting-IP is the most trustworthy). */
function clientIpFor(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "";
}

export async function handleTrack(db: Database, req: Request): Promise<Response> {
  const headers = { "Content-Type": "application/json" };
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
  }
  const visitorId = typeof body.visitor_id === "string" ? body.visitor_id.trim() : "";
  const page = typeof body.page === "string" ? body.page.trim() : "";
  if (!visitorId || visitorId.length > 128) {
    return new Response(JSON.stringify({ error: "visitor_id (string) is required" }), { status: 400, headers });
  }
  if (!page || page.length > 512) {
    return new Response(JSON.stringify({ error: "page (string) is required" }), { status: 400, headers });
  }
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.trim().slice(0, max) : "";
  const tsRaw = str(body.ts, 64);
  const ts = tsRaw && !Number.isNaN(Date.parse(tsRaw)) ? tsRaw : new Date().toISOString();

  // Server-derived signals (not trusted from the client body).
  const rawIp = clientIpFor(req);
  const ip = maskIp(rawIp);
  const uaHeader = (req.headers.get("user-agent") || "").trim().slice(0, 512);
  const ua = uaHeader || str(body.ua, 512); // beacon fallback when header stripped
  const country = (req.headers.get("cf-ipcountry") || "").trim().toUpperCase().slice(0, 8);
  // Request headers captured for the absent-header bot heuristic (see
  // visitor-signals.ts botStatusForFull). Always written EXPLICITLY — the empty
  // string means "present on the request but absent" vs NULL (historical).
  const acceptLanguage = (req.headers.get("accept-language") || "").trim().slice(0, 512);
  const acceptEncoding = (req.headers.get("accept-encoding") || "").trim().slice(0, 512);

  // VERIFIED beacon (Part 2b): the post-render <head> beacon fires a second
  // request with verified:true after the page actually executes JS. Bots that
  // only fetched the HTML never round-trip it. Here we mark the matching visit
  // row as verified instead of inserting a duplicate touch.
  if (body.verified === true) {
    const didMark = markPageVisitVerified(db, visitorId, page.slice(0, 512));
    if (!didMark) {
      // No matching visit row (rare — e.g. the head beacon was suppressed) —
      // still record a standalone verified touch so the signal isn't lost.
      recordPageVisit(db, {
        visitor_id: visitorId,
        page: page.slice(0, 512),
        referrer: str(body.referrer, 500),
        utm_source: str(body.utm_source, 200),
        utm_medium: str(body.utm_medium, 200),
        utm_campaign: str(body.utm_campaign, 200),
        utm_content: str(body.utm_content, 200),
        ts,
        ip,
        user_agent: ua,
        country,
        accept_language: acceptLanguage,
        accept_encoding: acceptEncoding,
        verified: true,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  recordPageVisit(db, {
    visitor_id: visitorId,
    page: page.slice(0, 512),
    referrer: str(body.referrer, 500),
    utm_source: str(body.utm_source, 200),
    utm_medium: str(body.utm_medium, 200),
    utm_campaign: str(body.utm_campaign, 200),
    utm_content: str(body.utm_content, 200),
    ts,
    ip,
    user_agent: ua,
    country,
    accept_language: acceptLanguage,
    accept_encoding: acceptEncoding,
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
