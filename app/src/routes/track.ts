import type { Database } from "bun:sqlite";
import { recordPageVisit } from "../db";

/**
 * POST /api/track (also /track — the dev site proxy strips the /api prefix
 * before forwarding) — first-party, privacy-minimal landing-page visit
 * tracking for the internal admin dashboard.
 *
 * Payload (JSON, all optional except visitor_id + page):
 *   { visitor_id, page, referrer?, utm_source?, utm_medium?, utm_campaign?, ts? }
 *
 * No IP, no User-Agent, no cookies are read, logged or stored: the snippet
 * sends exactly these fields and nothing else. ts is the client's ISO
 * timestamp (new Date().toISOString()); when absent/invalid the server stamps
 * the row instead. Storing is idempotent-ish: the UNIQUE(visitor_id, page, ts)
 * index turns a retried beacon with an identical payload into a no-op.
 *
 * Returns 200 {ok:true} on success, 400 on a malformed payload. The endpoint
 * is intentionally public (no token): it exists to collect visits, and the
 * data it stores is non-identifying (a random per-browser UUID).
 */
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

  recordPageVisit(db, {
    visitor_id: visitorId,
    page: page.slice(0, 512),
    referrer: str(body.referrer, 500),
    utm_source: str(body.utm_source, 200),
    utm_medium: str(body.utm_medium, 200),
    utm_campaign: str(body.utm_campaign, 200),
    ts,
  });

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
