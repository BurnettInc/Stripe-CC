import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend engagement webhook — POST /webhook/resend-events.
 *
 * Resend posts delivery/engagement events here (email.opened, email.clicked,
 * …). This handler records open/click tracking on the matching send_logs row
 * (the new dashboard "Not opened / Opened / Opened & clicked" status). It
 * follows the same conventions as the Stripe webhook (routes/webhook.ts):
 * raw body read first, HMAC signature verified against a configured secret,
 * 400 on bad signatures, 500 on processing failures so Resend retries,
 * 200-fast on success.
 *
 * ── Signature verification ──
 * Resend uses the Svix webhook scheme: three headers
 *   svix-id, svix-timestamp, svix-signature
 * where svix-signature is a whitespace-separated list of `v1,<base64-hmac>`
 * entries, and the HMAC is HMAC-SHA256 over `"{svix-id}.{svix-timestamp}.{raw body}"`
 * using the signing secret: the `whsec_…` prefix is stripped and the remainder
 * base64-decoded to get the raw key bytes. Implemented here with node:crypto
 * (the app has no svix dependency, and a ~40-line constant-time implementation
 * avoids adding one). Mirrors the Stripe webhook's 5-minute replay window and
 * constant-time comparison.
 *
 * ── Env / fail-safe ──
 * When RESEND_WEBHOOK_SECRET is unset the endpoint returns 503 and processes
 * NOTHING (any payload, any signature) — fail-safe, mirroring how
 * /inbound/reply and /support/* disable themselves when their token is unset.
 * Set it on deploy alongside RESEND_API_KEY (root Dockerfile).
 *
 * ── Matching & idempotency ──
 * Resend event payloads carry `data.email_id` (the API email id — the `id`
 * Resend returned from POST /emails, which sender.ts now persists on the
 * send_logs row) and `data.message_id` (the RFC Message-ID header, e.g.
 * "<111-222-333@abc>.csv"). We match on email_id first, then fall back to a
 * normalized message_id (stripped of angle brackets / trailing ".csv") so both
 * fields Resend documents can key an event work. A matched row records:
 *   opened  — opened_at only when NULL, open_count incremented (once per event
 *             delivery; a redelivered open bumps the count but never the _at)
 *   clicked — clicked_at only when NULL, click_count incremented
 * No link URL is stored (the brief: counts/flags only — links can carry
 * customer-specific tokens we don't need to keep).
 */

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Normalize a Resend message_id (RFC Message-ID header) to something
 *  comparable against `data.email_id` and the stored id. Resend example:
 *  "<111-222-333@abc>.csv" → "111-222-333@abc". The ".csv" suffix must be
 *  stripped BEFORE the trailing ">" (the bracketed form is "<x@y>.csv"). */
function normalizeMessageId(raw: string): string {
  return raw.trim().replace(/\.csv$/i, "").replace(/^<+/, "").replace(/[>]+$/, "").trim();
}

/** Verify a Svix/Resend signature header against msgId + timestamp + raw body.
 *  Returns true when any whitespace-separated v1 entry matches. The HMAC key
 *  comes from the `whsec_…` secret (prefix stripped, base64-decoded). */
function verifySvixSignature(
  rawBody: string,
  msgId: string,
  timestamp: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const keyMaterial = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(keyMaterial, "base64");
  if (key.length === 0) {
    console.error("[resend-webhook] Signing secret is not a valid whsec_… secret (empty key)");
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    console.error(`[resend-webhook] Signature timestamp outside allowed window: ${timestamp} vs now ${now}`);
    return false;
  }
  const signedPayload = `${msgId}.${timestamp}.${rawBody}`;
  const computed = createHmac("sha256", key).update(signedPayload).digest();
  for (const entry of signatureHeader.trim().split(/\s+/)) {
    if (!entry.startsWith("v1,")) continue;
    const expected = Buffer.from(entry.slice(3), "base64");
    if (expected.length === computed.length && timingSafeEqual(computed, expected)) {
      return true;
    }
  }
  console.error("[resend-webhook] Signature mismatch (no v1 entry matched)");
  return false;
}

const SUPPORTED_EVENTS = new Set(["email.opened", "email.clicked"]);

export async function handleResendWebhook(db: Database, req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-safe: without the shared secret we cannot verify a single event, so
    // reject everything rather than process unverified payloads. Resend will
    // retry; this endpoint only goes live once the env var is deployed.
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET is unset — refusing to process (503). Deploy the secret to enable engagement tracking.");
    return json({ error: "Not configured" }, 503);
  }

  // Read raw body first (the signature covers the exact bytes).
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json({ error: "Failed to read request body" }, 400);
  }

  // ── Signature verification ──
  const msgId = req.headers.get("svix-id") ?? "";
  const timestamp = req.headers.get("svix-timestamp") ?? "";
  const signature = req.headers.get("svix-signature") ?? "";
  if (!msgId || !timestamp || !signature) {
    console.error("[resend-webhook] Missing svix-id/svix-timestamp/svix-signature headers");
    return json({ error: "Missing svix signature headers" }, 400);
  }
  if (!verifySvixSignature(rawBody, msgId, timestamp, signature, secret)) {
    return json({ error: "Invalid signature" }, 400);
  }

  // ── Parse payload ──
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const event = body as { type?: unknown; data?: { email_id?: unknown; message_id?: unknown } };
  if (typeof event.type !== "string" || !SUPPORTED_EVENTS.has(event.type)) {
    console.log(`[resend-webhook] Unsupported event type — ignoring (${typeof event.type === "string" ? event.type : "missing"})`);
    return json({ ok: true, ignored: true }, 200);
  }
  const rawEmailId = typeof event.data?.email_id === "string" ? event.data.email_id.trim() : "";
  const rawMessageId = typeof event.data?.message_id === "string" ? event.data.message_id.trim() : "";
  if (!rawEmailId && !rawMessageId) {
    console.error(`[resend-webhook] ${event.type} event has neither email_id nor message_id — nothing to match`);
    return json({ error: "Missing data.email_id / data.message_id" }, 400);
  }
  const emailId = rawEmailId || "";
  const messageKey = emailId || normalizeMessageId(rawMessageId);

  // ── Match & record (idempotent) ──
  try {
    const match = db.query(
      `SELECT id FROM send_logs
       WHERE resend_message_id = ? OR resend_message_id = ?
       ORDER BY id DESC LIMIT 1`
    ).get(emailId, messageKey) as { id: number } | null;
    if (!match) {
      console.log(`[resend-webhook] ${event.type} for unknown resend id ${messageKey} — no send_logs row (ignored)`);
      return json({ ok: true, matched: false }, 200);
    }
    const now = new Date().toISOString();
    if (event.type === "email.opened") {
      // Guard on _at (never double-set), count may legitimately tick per event.
      db.run(
        `UPDATE send_logs
         SET open_count = open_count + 1,
             opened_at = COALESCE(opened_at, ?)
         WHERE id = ?`,
        [now, match.id]
      );
    } else {
      db.run(
        `UPDATE send_logs
         SET click_count = click_count + 1,
             clicked_at = COALESCE(clicked_at, ?)
         WHERE id = ?`,
        [now, match.id]
      );
    }
    console.log(`[resend-webhook] Recorded ${event.type} for send_logs id ${match.id} (${messageKey})`);
    return json({ ok: true, matched: true }, 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[resend-webhook] Processing failed: ${message}`);
    return json({ error: message }, 500);
  }
}