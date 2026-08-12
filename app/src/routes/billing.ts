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

// Stripe API base. STRIPE_API_BASE lets endpoint tests point the backend at a
// local stub instead of the real API; production keeps the default.
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, "");
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
    response = await handlePortal(db, req, sessionMerchantId);
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
  // The one exception: graceful fallback responses (the portal's "no active
  // subscription" HTML page) are marked with X-Billing-Fallback and pass
  // straight through — they are complete user-facing pages, not errors.
  if (req.method === "GET") {
    if (response.headers.get("X-Billing-Fallback")) return response;
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

/**
 * True when a Stripe error response means a stored customer/subscription id no
 * longer RESOLVES in Stripe: the canonical `resource_missing` code ("No such
 * customer: 'cus_...'"), or a test-mode/live-mode key mismatch ("a similar
 * object exists in test mode, but a live mode key was used" — the production
 * incident that motivated this hardening: the DB held test-mode ids while the
 * app used a live key). Message checks are belt-and-braces for responses that
 * omit the code. These ids are worth falling back from; everything else is a
 * transient Stripe failure and should still never leak into the UI.
 */
function isUnresolvableStripeError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const err = (data as { error?: Record<string, unknown> }).error;
  if (!err || typeof err !== "object") return false;
  const code = typeof err.code === "string" ? err.code : "";
  const msg = typeof err.message === "string" ? err.message : "";
  if (code === "resource_missing") return true;
  return (
    /no such customer|no such subscription/i.test(msg) ||
    /similar object exists in (test|live) mode/i.test(msg) ||
    /(test|live) mode key was used/i.test(msg)
  );
}

interface StripeResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

/** Authenticated Stripe API call (form-encoded body for POST, none for GET). */
async function stripeFetch(path: string, stripeKey: string, init?: { method?: string; body?: string }): Promise<StripeResult> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.body,
  });
  const data = await res.json() as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

interface PortalCandidate {
  customerId: string | null;
  subId: string | null;
}

/**
 * Ordered list of (customer id, subscription id) pairs to try when creating a
 * portal session, most-recent-first:
 *   1. the latest subscription row's stored pair as-is;
 *   2. the latest subscription id ALONE — derive the customer from Stripe's
 *      copy of the subscription (survives a stale stored customer id);
 *   3. every older subscription row for the merchant (same two shapes) — a
 *      superseded row may still carry the customer id that resolves.
 * Deduplicated by customer id so the same portal session call is never made
 * twice.
 */
function portalCandidates(db: Database, merchantId: number): PortalCandidate[] {
  const rows = db.query(
    "SELECT stripe_subscription_id, stripe_customer_id FROM subscriptions WHERE merchant_id=? ORDER BY created_at DESC, id DESC"
  ).all(merchantId) as Array<{ stripe_subscription_id: string; stripe_customer_id: string | null }>;
  const candidates: PortalCandidate[] = [];
  const seenCustomers = new Set<string>();
  const push = (customerId: string | null, subId: string | null) => {
    if (!customerId && !subId) return;
    if (customerId) {
      if (seenCustomers.has(customerId)) return;
      seenCustomers.add(customerId);
    }
    candidates.push({ customerId, subId });
  };
  for (const row of rows) {
    push(row.stripe_customer_id ?? null, row.stripe_subscription_id);
    push(null, row.stripe_subscription_id);
  }
  return candidates;
}

/**
 * Clean user-facing "no active subscription" response — the terminal fallback
 * of the portal handler when no stored Stripe id resolves. GET callers get a
 * small HTML page linking to checkout (marked X-Billing-Fallback so the GET
 * wrapper in handleBilling lets it through instead of bouncing to
 * /dashboard?billing=error); API callers get JSON with a checkout_url. Stripe
 * internals are NEVER included.
 */
function noActiveSubscriptionResponse(req: Request): Response {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({
        error: "No active subscription found. Subscribe to a plan to manage billing.",
        checkout_url: "/billing/checkout?tier=pro",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>No active subscription — CollectionsCopilot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f8fa; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 40px 48px; max-width: 460px; margin: 24px; text-align: center; }
    h1 { font-size: 20px; margin: 0 0 12px; color: #1a1a2e; }
    p { font-size: 15px; line-height: 1.6; color: #4a4a68; margin: 0 0 20px; }
    a.button { display: inline-block; background: #635bff; color: #fff; text-decoration: none; font-weight: 600; padding: 10px 18px; border-radius: 8px; margin: 0 4px 8px; }
    a.secondary { display: inline-block; color: #635bff; text-decoration: none; font-weight: 500; padding: 10px 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>No active subscription</h1>
    <p>We couldn't find an active subscription for your account. Subscribe to a plan to manage billing and keep your reminders running.</p>
    <a class="button" href="/billing/checkout?tier=pro">Subscribe to CollectionsCopilot</a><br>
    <a class="secondary" href="/dashboard">Back to dashboard</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Billing-Fallback": "no-subscription" },
  });
}

async function handlePortal(db: Database, req: Request, merchantId?: number): Promise<Response> {
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
  // No stored subscription — or one that is not an active paid plan — means
  // there is nothing to manage in the portal. Degrade to a clean "no active
  // subscription" page/JSON (with a checkout link) instead of a confusing
  // Stripe error. (The dashboard's "Manage plan" card only links here for
  // active paid subscribers, so this is mostly stale pages + API callers.)
  if (!sub || sub.status !== "active" || (sub.tier !== "standard" && sub.tier !== "pro")) {
    return noActiveSubscriptionResponse(req);
  }

  // Portal sessions are created for a Stripe CUSTOMER. Stored ids can go stale
  // (leftover fake E2E rows, test-mode ids under a live key, deleted
  // customers/subscriptions): never propagate Stripe's raw error to the user —
  // walk the fallback chain instead and only degrade to the clean page when
  // nothing resolves.
  const baseUrl = process.env.BASE_URL || `http://localhost:3001`;
  for (const candidate of portalCandidates(db, merchantId)) {
    let customerId = candidate.customerId;
    if (!customerId) {
      if (!candidate.subId) continue;
      // (a) No usable stored customer — derive it from the stored subscription
      // id via Stripe's copy of the subscription.
      let fetched: StripeResult;
      try {
        fetched = await stripeFetch(`/subscriptions/${encodeURIComponent(candidate.subId)}`, stripeKey);
      } catch (err) {
        console.error(`[billing] Subscription lookup request failed (${candidate.subId}):`, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!fetched.ok) {
        console.error(`[billing] Stripe subscription lookup failed (${candidate.subId}):`, JSON.stringify(fetched.data));
        continue; // stale or unavailable — try the next candidate
      }
      customerId = typeof fetched.data.customer === "string" ? fetched.data.customer : null;
      if (!customerId) continue;
    }

    const params = new URLSearchParams({
      customer: customerId,
      return_url: `${baseUrl}/dashboard?portal=return`,
    });
    let res: Response;
    try {
      res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
    } catch (err) {
      console.error("[billing] Billing portal request failed:", err instanceof Error ? err.message : String(err));
      continue;
    }
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && typeof data.url === "string") {
      // Happy path — identical to the pre-hardening behavior.
      return new Response(JSON.stringify({ url: data.url }), { status: 200, headers });
    }
    console.error(`[billing] Stripe billing portal error (customer ${customerId}):`, JSON.stringify(data));
    if (isUnresolvableStripeError(data)) continue; // stale id — try the next candidate
    // Any other Stripe failure also moves on: the remaining candidates are
    // free to try, and if none resolve the graceful page below still shows
    // without leaking internals.
  }

  // (c) Nothing resolved. Never surface the raw Stripe error: return a clean
  // user-facing page (GET) or JSON (POST) pointing at checkout.
  console.error(`[billing] No resolvable Stripe customer/subscription for merchant ${merchantId} — returning graceful no-subscription response`);
  return noActiveSubscriptionResponse(req);
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
