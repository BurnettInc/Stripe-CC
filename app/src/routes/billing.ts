import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ensureDefaultMerchant,
  createSubscription,
  updateSubscriptionStatus,
  getSubscriptionByStripeId,
  getSubscriptionByMerchantId,
  enforceTierTrustMode,
} from "../db";

const STRIPE_API = "https://api.stripe.com/v1";
const PRICE_IDS: Record<string, string> = {
  standard: "price_1TyiJ9AD4cJGS9CrgoI4TzX4",
  pro: "price_1TyiJAAD4cJGS9CrBUJ8XjwN",
};

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
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
    console.error("[billing] Invalid signature header format");
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const sigTime = parseInt(timestamp, 10);
  if (Math.abs(now - sigTime) > 300) {
    console.error(`[billing] Signature timestamp outside allowed window: ${sigTime} vs now ${now}`);
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
    console.error(`[billing] Signature mismatch`);
    return false;
  }

  return true;
}

/**
 * Handle billing routes:
 *   "checkout" → POST /billing/checkout — create a Stripe Checkout Session
 *   "portal"   → POST /billing/portal   — create a Stripe Customer Portal session
 *   "webhook"  → POST /billing          — Stripe Billing webhook events
 */
export async function handleBilling(
  db: Database,
  req: Request,
  action: "checkout" | "portal" | "webhook",
  sessionMerchantId?: number,
): Promise<Response> {
  let response: Response;
  if (action === "checkout") {
    response = await handleCheckout(db, req, sessionMerchantId);
  } else if (action === "portal") {
    response = await handlePortal(db, sessionMerchantId);
  } else {
    return handleBillingWebhook(db, req);
  }
  // Real-link entry (GET): the dashboard stat cards navigate with a plain
  // <a href>, so turn the JSON {url} response into a 302 redirect the
  // browser follows straight to Stripe (checkout session / customer portal).
  // POST callers (subscribe(), the site, OnboardingView) keep the JSON.
  //
  // A GET navigation must NEVER land on a raw JSON error screen. Any outcome
  // other than a usable 302 — missing STRIPE_SECRET_KEY (503), no
  // subscription / not active (400), unresolvable customer, Stripe session
  // failure (502), or a 200 without a usable url — redirects back to the
  // dashboard with ?billing=error, which the dashboard surfaces as a notice.
  if (req.method === "GET") {
    if (response.status === 200) {
      try {
        const data = (await response.clone().json()) as { url?: unknown };
        if (typeof data.url === "string" && (data.url.startsWith("https://") || data.url.startsWith("http://"))) {
          return new Response(null, { status: 302, headers: { Location: data.url } });
        }
      } catch {
        // Not a JSON {url} body — fall through to the graceful redirect below.
      }
    } else {
      const body = await response.clone().text();
      console.error(`[billing] GET ${req.url} failed with ${response.status}: ${body.slice(0, 300)}`);
    }
    // Relative redirect: the browser resolves it against its current origin
    // (works on Railway, www domain, and local dev).
    return new Response(null, { status: 302, headers: { Location: "/dashboard?billing=error" } });
  }
  return response;
}

// ── Checkout Session creation ──

async function handleCheckout(db: Database, req: Request, sessionMerchantId?: number): Promise<Response> {
  const headers = { "Content-Type": "application/json" };
  // GET requests carry tier (and optional redirects) as query params - the
  // real-link entry used by the dashboard "Free Drafts" stat card. POST
  // requests carry them as JSON (the JS subscribe() helper / the site).
  let tier: string | undefined;
  let successUrlOpt: string | undefined;
  let cancelUrlOpt: string | undefined;
  if (req.method === "GET") {
    const url = new URL(req.url);
    tier = url.searchParams.get("tier") ?? undefined;
    successUrlOpt = url.searchParams.get("success_url") ?? undefined;
    cancelUrlOpt = url.searchParams.get("cancel_url") ?? undefined;
  } else {
    let body: { tier?: string; merchantId?: number; successUrl?: string; cancelUrl?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }
    tier = body.tier;
    successUrlOpt = body.successUrl;
    cancelUrlOpt = body.cancelUrl;
  }
  const merchantId = sessionMerchantId;
  if (!tier || !["standard", "pro"].includes(tier)) {
    return new Response(
      JSON.stringify({ error: "tier must be 'standard' or 'pro'" }),
      { status: 400, headers }
    );
  }
  if (!merchantId || typeof merchantId !== "number") {
    return new Response(
      JSON.stringify({ error: "merchantId (number) is required" }),
      { status: 400, headers }
    );
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(
      JSON.stringify({
        error: "STRIPE_SECRET_KEY is not configured",
        detail: "Set the STRIPE_SECRET_KEY environment variable (sk_test_...) to enable billing.",
      }),
      { status: 503, headers }
    );
  }
  const priceId = PRICE_IDS[tier];
  const baseUrl = process.env.BASE_URL || `http://localhost:3001`;
  // Optional redirect overrides let other surfaces (e.g. the marketing site)
  // reuse this single checkout implementation while keeping their own
  // success/cancel pages. Only http(s) URLs are accepted.
  const isHttpUrl = (u: unknown): u is string =>
    typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));
  const successUrl = isHttpUrl(successUrlOpt)
    ? successUrlOpt
    : `${baseUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = isHttpUrl(cancelUrlOpt)
    ? cancelUrlOpt
    : `${baseUrl}/dashboard?cancelled=true`;

  const params = new URLSearchParams({
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    mode: "subscription",
    "metadata[merchant_id]": String(merchantId),
    "metadata[tier]": tier,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  try {
    const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      console.error("[billing] Stripe checkout error:", data);
      return new Response(
        JSON.stringify({ error: "Stripe checkout creation failed", detail: data }),
        { status: 502, headers }
      );
    }

    return new Response(
      JSON.stringify({ url: data.url, session_id: data.id }),
      { status: 200, headers }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing] Checkout request failed:", message);
    return new Response(
      JSON.stringify({ error: "Failed to contact Stripe", detail: message }),
      { status: 502, headers }
    );
  }
}

// ── Customer Portal session ──

async function handlePortal(db: Database, merchantId?: number): Promise<Response> {
  const headers = { "Content-Type": "application/json" };

  if (!merchantId || typeof merchantId !== "number") {
    return new Response(
      JSON.stringify({ error: "merchantId (number) is required" }),
      { status: 400, headers }
    );
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(
      JSON.stringify({
        error: "STRIPE_SECRET_KEY is not configured",
        detail: "Set the STRIPE_SECRET_KEY environment variable (sk_test_...) to enable billing.",
      }),
      { status: 503, headers }
    );
  }

  const sub = getSubscriptionByMerchantId(db, merchantId);
  if (!sub) {
    return new Response(
      JSON.stringify({ error: "No subscription found. Subscribe to a plan before managing billing." }),
      { status: 400, headers }
    );
  }
  // Same gate the dashboard's Free Drafts card uses for its "Manage plan →"
  // link (isActivePaidSubscriber: active + standard/pro). If the card shows
  // "Upgrade for unlimited →" (no active paid sub), the portal must not
  // pretend there is a plan to manage — GET callers get redirected to
  // /dashboard?billing=error, POST callers get this 400.
  if (sub.status !== "active" || (sub.tier !== "standard" && sub.tier !== "pro")) {
    return new Response(
      JSON.stringify({ error: `No active paid subscription (status: ${sub.status}). Resubscribe to manage billing.` }),
      { status: 400, headers }
    );
  }

  // Resolve the Stripe customer ID. Newer subscriptions store it (captured from
  // checkout.session.completed); older ones fall back to fetching the Stripe
  // subscription, which always carries its owning customer.
  let customerId = sub.stripe_customer_id;
  if (!customerId) {
    try {
      const res = await fetch(`${STRIPE_API}/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        console.error("[billing] Stripe subscription lookup error:", data);
        return new Response(
          JSON.stringify({ error: "Could not look up subscription in Stripe", detail: data }),
          { status: 502, headers }
        );
      }
      customerId = typeof data.customer === "string" ? data.customer : null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[billing] Subscription lookup request failed:", message);
      return new Response(
        JSON.stringify({ error: "Failed to contact Stripe", detail: message }),
        { status: 502, headers }
      );
    }
  }

  if (!customerId) {
    return new Response(
      JSON.stringify({ error: "Could not determine the Stripe customer for this subscription." }),
      { status: 502, headers }
    );
  }

  const baseUrl = process.env.BASE_URL || `http://localhost:3001`;
  const params = new URLSearchParams({
    customer: customerId,
    return_url: `${baseUrl}/dashboard?portal=return`,
  });

  try {
    const res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      console.error("[billing] Stripe billing portal error:", data);
      return new Response(
        JSON.stringify({ error: "Stripe billing portal session creation failed", detail: data }),
        { status: 502, headers }
      );
    }

    return new Response(
      JSON.stringify({ url: data.url }),
      { status: 200, headers }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing] Billing portal request failed:", message);
    return new Response(
      JSON.stringify({ error: "Failed to contact Stripe", detail: message }),
      { status: 502, headers }
    );
  }
}

// ── Webhook handler with signature verification ──

async function handleBillingWebhook(db: Database, req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const headers = { "Content-Type": "application/json" };

  // Read raw body for signature verification
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read request body" }), { status: 400, headers });
  }

  // ── Webhook signature verification ──
  // Uses STRIPE_BILLING_WEBHOOK_SECRET for the /billing endpoint, falling back
  // to the shared STRIPE_WEBHOOK_SECRET for backward compatibility.
  const webhookSecret = process.env.STRIPE_BILLING_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sigHeader = req.headers.get("stripe-signature");
    if (!sigHeader) {
      console.error("[billing] STRIPE_WEBHOOK_SECRET is set but no stripe-signature header present");
      return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
        status: 400,
        headers,
      });
    }

    if (!verifyStripeSignature(rawBody, sigHeader, webhookSecret)) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 400,
        headers,
      });
    }
  } else {
    // Skipping verification is only reachable on localhost: index.ts refuses
    // to boot without STRIPE_WEBHOOK_SECRET when not running on localhost.
    console.log("[billing] No STRIPE_WEBHOOK_SECRET set — skipping signature verification (test mode)");
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
  }

  const event = body as {
    type?: string;
    data?: {
      object?: Record<string, unknown>;
    };
  };

  ensureDefaultMerchant(db);

  const eventType = event.type || "";
  const obj = event.data?.object || {};
  console.log(`[billing] Webhook received: ${eventType}`);

  try {
    switch (eventType) {
      case "checkout.session.completed": {
        const session = obj as {
          id?: string;
          subscription?: string;
          customer?: string;
          metadata?: { merchant_id?: string; tier?: string };
        };
        const stripeSubscriptionId = session.subscription;
        const stripeCustomerId = session.customer;
        const merchantId = session.metadata?.merchant_id
          ? parseInt(session.metadata.merchant_id, 10)
          : null;
        const tier = session.metadata?.tier || "standard";

        if (!stripeSubscriptionId || !merchantId) {
          console.error("[billing] checkout.session.completed missing subscription or merchant_id");
          return new Response(
            JSON.stringify({ error: "Missing subscription or merchant_id in session" }),
            { status: 400, headers }
          );
        }

        const existing = getSubscriptionByStripeId(db, stripeSubscriptionId);
        if (existing) {
          console.log(`[billing] Subscription ${stripeSubscriptionId} already exists, skipping`);
        } else {
          createSubscription(db, { merchant_id: merchantId, stripe_subscription_id: stripeSubscriptionId, stripe_customer_id: stripeCustomerId, tier });
          console.log(`[billing] Subscription created: merchant=${merchantId} tier=${tier} sub=${stripeSubscriptionId} customer=${stripeCustomerId || "n/a"}`);
        }

        return new Response(JSON.stringify({ received: true, action: "subscription_created" }), { status: 200, headers });
      }

      case "customer.subscription.deleted": {
        const sub = obj as { id?: string };
        if (!sub.id) {
          return new Response(JSON.stringify({ error: "Missing subscription id" }), { status: 400, headers });
        }

        const existing = getSubscriptionByStripeId(db, sub.id);
        if (existing) {
          updateSubscriptionStatus(db, sub.id, "cancelled");
          console.log(`[billing] Subscription ${sub.id} marked cancelled`);
          // Full Auto is Pro-only: demote trust_mode if this merchant lost Pro.
          enforceTierTrustMode(db, existing.merchant_id);
        }

        return new Response(JSON.stringify({ received: true, action: "subscription_cancelled" }), { status: 200, headers });
      }

      case "customer.subscription.updated": {
        const sub = obj as {
          id?: string;
          status?: string;
          items?: { data?: Array<{ price?: { id?: string } }> };
        };
        if (!sub.id) {
          return new Response(JSON.stringify({ error: "Missing subscription id" }), { status: 400, headers });
        }

        const existing = getSubscriptionByStripeId(db, sub.id);
        if (existing) {
          const status = sub.status || existing.status;

          let tier: string | undefined;
          const priceId = sub.items?.data?.[0]?.price?.id;
          if (priceId) {
            if (priceId === PRICE_IDS.standard) tier = "standard";
            else if (priceId === PRICE_IDS.pro) tier = "pro";
          }

          updateSubscriptionStatus(db, sub.id, status, tier);
          console.log(`[billing] Subscription ${sub.id} updated: status=${status} tier=${tier || "unchanged"}`);
          // Full Auto is Pro-only: demote trust_mode if this merchant lost Pro
          // (downgrade to Standard, lapse to past_due, etc.).
          enforceTierTrustMode(db, existing.merchant_id);
        }

        return new Response(JSON.stringify({ received: true, action: "subscription_updated" }), { status: 200, headers });
      }

      default:
        return new Response(
          JSON.stringify({ received: true, event_type: eventType, message: "Unhandled event type" }),
          { status: 200, headers }
        );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing] Webhook processing error:", message);
    return new Response(
      JSON.stringify({ error: "Webhook processing failed", detail: message }),
      { status: 500, headers }
    );
  }
}
