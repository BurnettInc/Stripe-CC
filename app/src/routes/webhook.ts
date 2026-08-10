import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleWebhookEvent } from "../pipeline/watcher";
import { getStripeKey } from "../middleware/auth";

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Stripe sends a header: stripe-signature: t=<timestamp>,v1=<signature>
 * We compute: HMAC-SHA256(webhook_secret, timestamp + "." + payload)
 * Returns true if valid, false if invalid.
 */
function verifyStripeSignature(payload: string, signatureHeader: string, secret: string): boolean {
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(",")) {
    const [key, ...valParts] = part.split("=");
    parts[key.trim()] = valParts.join("=").trim();
  }

  const timestamp = parts["t"];
  const expectedSig = parts["v1"];

  if (!timestamp || !expectedSig) {
    console.error("[webhook] Invalid signature header format");
    return false;
  }

  // Reject signatures older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  const sigTime = parseInt(timestamp, 10);
  if (Math.abs(now - sigTime) > 300) {
    console.error(`[webhook] Signature timestamp outside allowed window: ${sigTime} vs now ${now}`);
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;
  const computedSig = createHmac("sha256", secret)
    .update(signedPayload)
    .digest();
  const expectedBuf = Buffer.from(expectedSig, "hex");

  // Constant-time comparison — plain string comparison leaks timing
  // information and is a known timing-attack vector.
  if (computedSig.length !== expectedBuf.length || !timingSafeEqual(computedSig, expectedBuf)) {
    console.error(`[webhook] Signature mismatch: computed ${computedSig.toString("hex").substring(0, 12)}... vs expected ${expectedSig.substring(0, 12)}...`);
    return false;
  }

  return true;
}

export async function handleWebhook(db: Database, req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read raw body for signature verification
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Webhook signature verification ──
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sigHeader = req.headers.get("stripe-signature");
    if (!sigHeader) {
      console.error("[webhook] STRIPE_WEBHOOK_SECRET is set but no stripe-signature header present");
      return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!verifyStripeSignature(rawBody, sigHeader, webhookSecret)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    // Skipping verification is only reachable on localhost: index.ts refuses
    // to boot without STRIPE_WEBHOOK_SECRET when not running on localhost.
    console.log("[webhook] No STRIPE_WEBHOOK_SECRET set — skipping signature verification (test mode)");
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = body as { type?: string; account?: string; data?: { object?: Record<string, unknown> } };
  if (!event.type || !event.data?.object) {
    return new Response(JSON.stringify({ error: "Invalid webhook payload: missing type or data.object" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Pass the top-level `account` (connected Stripe account ID) through so
    // the pipeline can attribute the event to the correct merchant.
    const result = await handleWebhookEvent(db, event as Parameters<typeof handleWebhookEvent>[1]);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
