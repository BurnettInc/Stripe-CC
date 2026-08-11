import type { Database } from "bun:sqlite";
import { getSubscriptionByMerchantId } from "../db";

/**
 * Support backend pack — token-gated internal APIs for the Support agent
 * (Pro priority-support operations):
 *
 *   GET  /support/lookup?email=<merchant_email>
 *   GET  /support/log?limit=<n>        (most recent first, default 50)
 *   POST /support/log
 *
 * Authenticated with `Authorization: Bearer <SUPPORT_API_TOKEN>` — NOT
 * session-authed (the Support agent has no merchant session). When
 * SUPPORT_API_TOKEN is unset every endpoint returns 403 and the API is
 * effectively disabled (see the boot-time log line in src/index.ts).
 *
 * Scope is deliberately minimal: enough context for Support to triage an
 * inbound email with the merchant's account in hand (lookup) and a log so
 * the "same-business-day first response" promise can be measured (log).
 */

const SUPPORT_API_TOKEN = process.env.SUPPORT_API_TOKEN;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Shared token gate for every /support/* endpoint. */
export function requireSupportToken(req: Request): boolean {
  if (!SUPPORT_API_TOKEN) return false;
  const auth = req.headers.get("Authorization") ?? "";
  return auth === `Bearer ${SUPPORT_API_TOKEN}`;
}

/**
 * GET /support/lookup?email=... → enough context to triage a support email:
 *   { found, merchantId?, tier, subscriptionStatus, accountEmail?, senderName? }
 *
 * tier ('standard'|'pro'|null) and subscriptionStatus ('active'|'none'|null)
 * come from the SAME source of truth as the rest of the app —
 * getSubscriptionByMerchantId (most recent subscription, ORDER BY
 * created_at DESC). subscriptionStatus is 'active' for an active sub,
 * 'none' when the merchant has never subscribed, and null when the most
 * recent sub exists but is not active (cancelled / past_due).
 */
export function handleSupportLookup(db: Database, req: Request, url: URL): Response {
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return json({ error: "Missing required query parameter: email" }, 400);
  }

  const merchant = db
    .query("SELECT id, email, sender_name FROM merchants WHERE LOWER(email) = ?")
    .get(email) as { id: number; email: string; sender_name: string | null } | null;
  if (!merchant) {
    return json({ found: false }, 200);
  }

  const sub = getSubscriptionByMerchantId(db, merchant.id);
  const tier = sub?.tier ?? null;
  const subscriptionStatus = sub ? (sub.status === "active" ? "active" : null) : "none";

  return json({
    found: true,
    merchantId: merchant.id,
    tier,
    subscriptionStatus,
    accountEmail: merchant.email,
    senderName: merchant.sender_name,
  }, 200);
}

/**
 * GET /support/log — list support-log entries, most recent first.
 *   ?limit=<n> (default 50, capped at 200)
 * POST /support/log — record one entry:
 *   { email: string, subject?: string, direction: 'in'|'out',
 *     note?: string | null }
 * responded_at semantics: an 'out' row stamps its own responded_at, and any
 * EARLIER 'in' row for the same email that hasn't been answered yet is
 * backfilled to the same timestamp — so an inbound entry's responded_at is
 * "when we first replied", which is exactly the first-response metric the
 * Pro promise is measured against. 'in' rows are inserted with NULL.
 */
export async function handleSupportLog(db: Database, req: Request, url: URL): Promise<Response> {
  if (req.method === "GET") {
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
    const entries = db
      .query("SELECT * FROM support_log ORDER BY id DESC LIMIT ?")
      .all(limit);
    return json({ entries }, 200);
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const direction = body.direction;
    const note = body.note === undefined || body.note === null
      ? null
      : (typeof body.note === "string" ? body.note.trim() : null);

    if (!email) {
      return json({ error: "email is required" }, 400);
    }
    if (direction !== "in" && direction !== "out") {
      return json({ error: "direction must be 'in' or 'out'" }, 400);
    }

    const nowIso = new Date().toISOString();
    const respondedAt = direction === "out" ? nowIso : null;

    const result = db.run(
      "INSERT INTO support_log (email, subject, direction, note, responded_at) VALUES (?, ?, ?, ?, ?)",
      [email, subject, direction, note, respondedAt]
    );
    const id = Number(result.lastInsertRowid);

    // Backfill: this outbound reply answers any unanswered inbound entries
    // for the same email — stamp their responded_at so first-response latency
    // is measurable per inbound ticket.
    if (direction === "out") {
      db.run(
        "UPDATE support_log SET responded_at = ? WHERE LOWER(email) = ? AND direction = 'in' AND responded_at IS NULL",
        [nowIso, email.toLowerCase()]
      );
    }

    return json({ ok: true, id, responded_at: respondedAt }, 201);
  }

  return json({ error: "Method not allowed" }, 405);
}

/**
 * Entry point for every /support/* route (registered in src/index.ts with
 * the path suffix after "/support"). The token gate is shared by ALL of them
 * (including unknown sub-paths, so the route surface stays unreadable
 * without the token).
 */
export async function handleSupport(db: Database, req: Request, suffix: string, url: URL): Promise<Response> {
  if (!requireSupportToken(req)) {
    return json({ error: "Unauthorized — missing or invalid SUPPORT_API_TOKEN" }, 403);
  }
  if (suffix === "/lookup" && req.method === "GET") {
    return handleSupportLookup(db, req, url);
  }
  if (suffix === "/log" && (req.method === "GET" || req.method === "POST")) {
    return handleSupportLog(db, req, url);
  }
  return json({ error: "Not found", path: `/support${suffix}`, method: req.method }, 404);
}
