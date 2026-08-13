import type { Database } from "bun:sqlite";
import { countWaitlistSignups, recordWaitlistSignup } from "../db";
import { notifyOwnerWaitlistSignup } from "../pipeline/owner-notify";

/**
 * POST /api/waitlist (also /waitlist — the dev site proxy strips the /api
 * prefix before forwarding) — public landing-page email capture.
 *
 * Replaces the /stripe/connect CTAs: visitors join the waitlist instead of
 * being bounced through the owner's shared single-tenant Stripe connection.
 * When the Stripe App review approves, the landing CTA is swapped to the
 * marketplace install link — the waitlist endpoint stays as the permanent
 * capture mechanism.
 *
 * Accepts JSON {email} or form-encoded email=...; validates with a basic
 * email regex, lowercases/trims, dedupes (duplicate → 200 {ok:true,
 * duplicate:true}, never an error), and rate-limits per IP (5/hour, in-memory
 * Map — a simple abuse guard, not a security boundary). On a NEW signup the
 * OWNER is notified via OWNER_NOTIFY_EMAIL (Resend, same sender the product
 * uses); failures are caught and logged, never thrown into the response.
 *
 * No email is sent to the signup itself — joining the list IS the opt-in;
 * the owner emails the list at launch.
 *
 * Responses: 200 {ok:true} | 200 {ok:true, duplicate:true} | 400 {error} | 429 {error}.
 */
export async function handleWaitlist(db: Database, req: Request): Promise<Response> {
  const headers = { "Content-Type": "application/json" };

  // Rate limit BEFORE parsing: count every attempt (proxy-aware client IP).
  if (!rateLimit(clientIpFor(req))) {
    return new Response(
      JSON.stringify({ error: "Too many attempts from this address — please try again later." }),
      { status: 429, headers },
    );
  }

  // Parse {email} from JSON or form-encoded.
  let email = "";
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const form = await req.formData();
      const v = form.get("email");
      if (typeof v === "string") email = v;
    } catch {
      // Fall through to validation — missing email yields 400.
    }
  } else {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (typeof body.email === "string") email = body.email;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
    }
  }

  email = email.trim().toLowerCase();
  if (!email) {
    return new Response(JSON.stringify({ error: "Email is required" }), { status: 400, headers });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: "Enter a valid email address" }), { status: 400, headers });
  }

  const inserted = recordWaitlistSignup(db, email);
  if (!inserted) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200, headers });
  }

  // New signup: notify the owner (never throw into the response).
  try {
    await notifyOwnerWaitlistSignup(db, email, countWaitlistSignups(db));
  } catch (err: unknown) {
    console.error(`[waitlist] owner notification error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── In-memory per-IP rate limit (process-local, pruned on access) ──
const RATE_LIMIT_MAX = 5; // requests per IP per hour
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateBuckets = new Map<string, number[]>(); // ip -> recent request timestamps

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const stamps = (rateBuckets.get(ip) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, stamps); // keep the pruned list; no new stamp
    return false;
  }
  stamps.push(now);
  rateBuckets.set(ip, stamps);
  return true;
}

/** Client IP for rate limiting: first X-Forwarded-For hop, else X-Real-IP, else local. */
function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}
