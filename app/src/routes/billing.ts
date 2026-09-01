import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ensureDefaultMerchant,
  createSubscription,
  updateSubscriptionStatus,
  getSubscriptionByStripeId,
  getSubscriptionByMerchantId,
  enforceTierTrustMode,
  recordSubscriptionEvent,
  isDevPro,
  scheduleMerchantDeletion,
  clearMerchantDeletion,
  isLifetimeMember,
  countLifetimeMembers,
  recordLifetimeMember,
  LIFETIME_MEMBER_QUOTA,
} from "../db";
import { notifyOwnerPaidSubscription, notifyOwnerCancelledSubscription } from "../pipeline/owner-notify";

// Stripe API base. STRIPE_API_BASE lets endpoint tests point the backend at a
// local stub instead of the real API; production keeps the default.
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, "");
// LIVE-mode prices from the app's platform Stripe account (created 2026-08,
// product prod_V4UTPE3ZeaxodT / prod_V4UT21Dzrdzg9d). Checkout is ALWAYS
// authenticated with STRIPE_SECRET_KEY (sk_live_… in production, see
// handleCheckout), so these constants MUST stay mode-locked to the live
// catalog: test-mode price ids 404 under the live key (verified via API), and
// the old price_1TyiJ9…/price_1TyiJA… ids exist only in TEST mode, which made
// every live Checkout Session fail. The webhook handler below also maps
// subscription items back to tiers by comparing against these ids.
//
// Four new prices created LIVE 2026-08-26 (reprice: $7/$15 monthly,
// $50/$100 yearly — replaces $15/$29 monthly and $135/$250 yearly; founding
// offer removed). Verified live-only via API (test key → 404, live key → 200).
const PRICE_IDS: Record<string, Record<string, string>> = {
  standard: {
    month: "price_1U8VZyAD4cJGS9CrReqgDCtd", // $7/mo (new 2026-08-26)
    year: "price_1U8VZyAD4cJGS9Cru85iFOEh", // $50/yr (new 2026-08-26)
  },
  pro: {
    month: "price_1U8VZyAD4cJGS9CroFf7Znpm", // $15/mo (new 2026-08-26)
    year: "price_1U8VZyAD4cJGS9CrcW0OHVVB", // $100/yr (new 2026-08-26)
  },
};
const BILLING_INTERVALS = ["month", "year"] as const;
type BillingInterval = (typeof BILLING_INTERVALS)[number];
/** Map ANY subscribed price id (monthly or yearly) back to its tier. */
function tierFromPriceId(priceId: string | undefined): string | undefined {
  if (!priceId) return undefined;
  for (const tier of Object.keys(PRICE_IDS)) {
    if (Object.values(PRICE_IDS[tier]).includes(priceId)) return tier;
  }
  return undefined;
}
/** Map a subscribed price id back to its billing interval (Phase B). */
function intervalFromPriceId(priceId: string | undefined): string | undefined {
  if (!priceId) return undefined;
  for (const interval of Object.keys(PRICE_IDS.standard)) {
    if (PRICE_IDS.standard[interval] === priceId || PRICE_IDS.pro[interval] === priceId) return interval;
  }
  return undefined;
}

// ── Stripe App review access discount ──
// The Stripe reviewer must be able to subscribe without paying. Manual coupon
// entry at Checkout FAILS in live mode on this billing account for EVERY
// promotion code ("This code is invalid" — reproduced live for 10%/50%/100%
// codes created via the dahlia-era API, while the SAME codes work in test
// mode; the live-account Checkout redemption path rejects them regardless of
// code). Server-side attach (discounts[0][promotion_code]) DOES work in live
// mode, so the reviewer discount is PRE-ATTACHED when creating the Checkout
// Session instead of relying on the customer-facing code field.
//
// Two scoped triggers, both funneling into the same attach:
//   1. explicit opt-in: the checkout URL carries promo=REVIEWER100
//      (/billing/checkout?tier=standard&promo=REVIEWER100) — the documented
//      reviewer path in the marketplace listing's Test credentials note.
//      Real customers' URLs never carry it, so the default flow is unchanged.
//   2. test-mode marketplace install: the merchant installed the app through
//      Stripe's TEST-mode install link (oauth_tokens.livemode=0). That link is
//      only reachable by Stripe's review harness / the app developer's test
//      tab — the PUBLIC marketplace listing installs live — so a test-mode
//      install is a strong reviewer signal, and it makes the reviewer's
//      actual Settings → Subscribe flow produce a $0 checkout with zero extra
//      steps. Real customers (live installs) never match.
// Only these two conditions attach; any other checkout keeps
// allow_promotion_codes=true and no pre-attached discount.
const REVIEWER_PROMO_CODE = "REVIEWER100";
const REVIEWER_PROMO_CODE_ID = "promo_1U5PYjAD4cJGS9Cro4A2TdbI";
// ── Owner-controlled: 10 lifetime free Pro accounts giveaway ──
// The owner hands out ONE special checkout link that carries promo=LIFETIME10
// (/billing/checkout?tier=pro&interval=month&promo=LIFETIME10). Completing it
// grants a REAL Pro subscription at $0 forever (100%-off, duration=forever
// coupon, live id EiubBz3c, nickname "Lifetime 100% (10 giveaway)"). At most
// 10 grants EVER — enforced atomically in DB by recordLifetimeMember.
// LIFETIME_PROMO_CODE is owner-controlled: it is the exact private string on
// the link the owner distributes, and is never shown anywhere in-app or on
// the site. No other code path attaches this coupon.
const LIFETIME_PROMO_CODE = "LIFETIME10";
const LIFETIME_COUPON_ID = "EiubBz3c";

/** True when the merchant installed the app through a TEST-mode marketplace
 * install link (oauth_tokens.livemode=0). Web-connect merchants and live
 * marketplace installs have no such row (or livemode=1) and return false. */
function isTestModeMarketplaceInstall(db: Database, merchantId: number): boolean {
  const row = db
    .query("SELECT livemode FROM oauth_tokens WHERE merchant_id=? ORDER BY updated_at DESC LIMIT 1")
    .get(merchantId) as { livemode: number } | null;
  return !!row && row.livemode === 0;
}

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
 * Branded "sign in required" page for anonymous GET navigations to
 * /billing/checkout and /billing/portal (reviewer blocker 2026-08-15: the
 * bare checkout URL returned a blank page because the session-required bounce
 * silently redirected to /dashboard?billing=error, which renders as an empty
 * shell for a user with no session).
 *
 * A Checkout/Portal session can only be created for an authenticated merchant
 * (subscriptions must attach to a merchant id), so an anonymous GET cannot
 * proceed to Stripe — but it must NEVER land on a blank page or a silent
 * redirect. This page states exactly that, explains why, and points at the
 * two real entry points (install/connect → dashboard, or the dashboard
 * directly). Callers log a warning on every render so the anonymous-hit path
 * stays visible in Railway logs.
 */
export function billingSignInRequiredPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in required — Collections Copilot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F3F4F6; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 36px 40px; max-width: 440px; width: 100%; box-sizing: border-box; text-align: center; }
    .logo { font-size: 20px; font-weight: 700; color: #1F2937; margin-bottom: 10px; }
    .logo span { color: #635BFF; }
    h1 { font-size: 20px; margin: 0 0 12px; color: #111827; }
    p { font-size: 14px; line-height: 1.6; color: #4B5563; margin: 0 0 18px; }
    a.btn { display: inline-block; background: #635BFF; color: #fff; text-decoration: none; font-weight: 600; padding: 11px 22px; border-radius: 8px; font-size: 14px; margin: 0 4px 8px; }
    a.alt { display: inline-block; color: #635BFF; text-decoration: none; font-weight: 600; padding: 11px 22px; border-radius: 8px; font-size: 14px; margin: 0 4px 8px; }
    .small { color: #9CA3AF; font-size: 12px; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Collections<span>Copilot</span></div>
    <h1>Sign in to continue</h1>
    <p>Plans and billing are tied to your Collections Copilot account, so you need to be signed in to subscribe or manage your plan. If you haven't connected your Stripe account yet, the dashboard will walk you through it — it only takes a minute.</p>
    <a class="btn" href="/oauth/install">Install &amp; connect Stripe</a><br>
    <a class="alt" href="/dashboard">Open the dashboard</a>
    <p class="small">Questions? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Billing-Fallback": "sign-in-required" },
  });
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
  let interval: string | undefined;
  let successUrlOpt: string | undefined;
  let cancelUrlOpt: string | undefined;
  let promoOpt: string | undefined;
  if (req.method === "GET") {
    const url = new URL(req.url);
    tier = url.searchParams.get("tier") ?? undefined;
    interval = url.searchParams.get("interval") ?? undefined;
    successUrlOpt = url.searchParams.get("success_url") ?? undefined;
    cancelUrlOpt = url.searchParams.get("cancel_url") ?? undefined;
    promoOpt = url.searchParams.get("promo") ?? undefined;
  } else {
    let body: { tier?: string; interval?: string; merchantId?: number; successUrl?: string; cancelUrl?: string; promo?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }
    tier = body.tier;
    interval = body.interval;
    successUrlOpt = body.successUrl;
    cancelUrlOpt = body.cancelUrl;
    promoOpt = body.promo;
  }
  const merchantId = sessionMerchantId;
  if (!tier || !["standard", "pro"].includes(tier)) {
    return new Response(
      JSON.stringify({ error: "tier must be 'standard' or 'pro'" }),
      { status: 400, headers }
    );
  }
  // Billing interval: "month" (default, unchanged behavior) or "year" (the
  // yearly prices added in Phase A). Anything else is rejected before any
  // Stripe call — the price lookup below is keyed on this value.
  const billingInterval = (interval ?? "month") as BillingInterval;
  if (!BILLING_INTERVALS.includes(billingInterval)) {
    return new Response(
      JSON.stringify({ error: "interval must be 'month' or 'year'" }),
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
  const priceId = PRICE_IDS[tier][billingInterval];
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

  // Reviewer-discount pre-attach (see the REVIEWER_* constants above). Only
  // two scoped triggers attach the 100%-off promo:
  //   1. the explicit promo=REVIEWER100 opt-in param (the documented reviewer
  //      path — real customers' URLs never carry it);
  //   2. a TEST-mode marketplace install (oauth_tokens.livemode=0) — only the
  //      Stripe review harness / the developer test tab can produce those.
  // When attached, allow_promotion_codes is turned OFF: the discount is
  // already applied server-side and the manual code field (which live Checkout
  // rejects for every code on this account) would only confuse the reviewer.
  const explicitReviewerPromo = (promoOpt ?? "").trim().toUpperCase() === REVIEWER_PROMO_CODE;
  const reviewerPromoAttach = explicitReviewerPromo || isTestModeMarketplaceInstall(db, merchantId);
  if (reviewerPromoAttach) {
    console.log(`[billing] Reviewer discount pre-attached for merchant ${merchantId} tier=${tier} (${explicitReviewerPromo ? "explicit promo param" : "test-mode install"})`);
  }
  // Lifetime free-Pro giveaway: attach the 100%-forever coupon server-side ONLY
  // when the checkout URL carries promo=LIFETIME10 AND the merchant is eligible
  // (quota open OR already a lifetime member — mirrors the old founding
  // isFoundingEligible). The promo param is owner-controlled and never shown
  // in-app. If the param is present but the merchant is NOT eligible (all 10
  // slots taken), treat it like the reviewer path: secure — do NOT attach, do
  // NOT error the checkout for a real customer, just log a warning (the 11th
  // merchant would pay normally). Eligibility is re-verified ATOMICALLY at
  // completion (recordLifetimeMember) and the subscription discount is
  // stripped if the quota filled up under a concurrent checkout, so a coupon
  // is never left on an 11th subscription.
  const explicitLifetimePromo = (promoOpt ?? "").trim().toUpperCase() === LIFETIME_PROMO_CODE;
  let lifetimePromoAttach = false;
  if (explicitLifetimePromo) {
    if (isLifetimeMember(db, merchantId) || countLifetimeMembers(db) < LIFETIME_MEMBER_QUOTA) {
      lifetimePromoAttach = true;
      console.log(`[billing] Lifetime promo pre-attached for merchant ${merchantId} tier=${tier} interval=${billingInterval}`);
    } else {
      console.warn(`[billing] Lifetime promo requested but quota full / merchant ${merchantId} not eligible — no coupon attached (checkout proceeds normally)`);
    }
  }

  const params = new URLSearchParams({
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    mode: "subscription",
    // Reviewers/merchants with a coupon code (e.g. REVIEWER100 — 100% off,
    // created on the live billing account for Stripe app review) must be able
    // to apply it at Checkout; without this flag the code field never renders
    // and the discount is unusable.
    allow_promotion_codes: "true",
    "metadata[merchant_id]": String(merchantId),
    "metadata[tier]": tier,
    // Billing interval on the session (Phase B) so the completion webhook can
    // record it on the subscription row (the dashboard's plan card then shows
    // the honest "$100/yr" for yearly subscribers). Default month, unchanged.
    "metadata[interval]": billingInterval,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  if (reviewerPromoAttach) {
    // Server-side attach is the ONLY promotion path that works in live mode on
    // this account (manual entry rejects every code with "This code is
    // invalid" — dahlia-era behavior, reproduced live; test mode works).
    // Stripe REJECTS a session that sets BOTH allow_promotion_codes and
    // discounts ("You may only specify one of these parameters: allow_promotion_codes,
    // discounts." — reproduced live 2026-08-17 E2E), so when the reviewer
    // discount is pre-attached we DROP allow_promotion_codes entirely: the
    // discount is already applied server-side and the manual code field (which
    // live Checkout rejects for every code on this account) would only confuse
    // the reviewer. Real customers (no attach) keep allow_promotion_codes=true.
    params.delete("allow_promotion_codes");
    params.set("discounts[0][promotion_code]", REVIEWER_PROMO_CODE_ID);
  }
  if (lifetimePromoAttach) {
    // Same constraint as the reviewer/founding attaches: Stripe rejects a
    // session with BOTH allow_promotion_codes and discounts, so drop the
    // manual code field when the coupon is pre-attached.
    params.delete("allow_promotion_codes");
    params.set("discounts[0][coupon]", LIFETIME_COUPON_ID);
  }

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
 * internals are NEVER included. An optional `copy` override produces the
 * dev-preview flavor (dev_pro=1 merchants) — same shape/status/header, clearer
 * wording (see devPreviewResponse).
 */
function noActiveSubscriptionResponse(
  req: Request,
  copy?: { jsonError: string; title: string; message: string }
): Response {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({
        error: copy?.jsonError ?? "No active subscription found. Subscribe to a plan to manage billing.",
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
  <title>No active subscription — Collections Copilot</title>
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
    <h1>${copy?.title ?? "No active subscription"}</h1>
    <p>${copy?.message ?? "We couldn't find an active subscription for your account. Subscribe to a plan to manage billing and keep your reminders running."}</p>
    <a class="button" href="/billing/checkout?tier=pro">Subscribe to Collections Copilot</a><br>
    <a class="secondary" href="/dashboard">Back to dashboard</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Billing-Fallback": "no-subscription" },
  });
}

/**
 * Dev-preview flavor of the no-subscription fallback for dev_pro=1 merchants:
 * same shape/status/X-Billing-Fallback header as noActiveSubscriptionResponse,
 * but the copy says they're on the Pro developer preview (no real subscription
 * exists to manage), so a direct /billing/portal hit stays honest.
 */
function devPreviewResponse(req: Request): Response {
  return noActiveSubscriptionResponse(req, {
    jsonError: "You're on the Pro developer preview — subscribe to a plan to manage billing.",
    title: "Pro developer preview",
    message: "You're on the Pro developer preview. Subscribe to a plan to manage billing and keep your reminders running.",
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
  // Dev-only Pro preview (dev_pro=1) merchants have no real subscription row:
  // the portal has nothing to manage, so any fallback below uses the
  // dev-preview flavor of the no-subscription response (honest copy on a
  // direct /billing/portal hit). Real merchants keep noActiveSubscriptionResponse.
  const devPro = isDevPro(db, merchantId);
  // No stored subscription — or one that is not an active paid plan — means
  // there is nothing to manage in the portal. Degrade to a clean "no active
  // subscription" page/JSON (with a checkout link) instead of a confusing
  // Stripe error. (The dashboard's "Manage plan" card only links here for
  // active paid subscribers, so this is mostly stale pages + API callers.)
  if (!sub || sub.status !== "active" || (sub.tier !== "standard" && sub.tier !== "pro")) {
    return devPro ? devPreviewResponse(req) : noActiveSubscriptionResponse(req);
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
  return devPro ? devPreviewResponse(req) : noActiveSubscriptionResponse(req);
}
// ── Lifetime free Pro giveaway — webhook slot recording ──
/**
 * True when a completed checkout session / subscription carries the lifetime
 * coupon in its `discounts`. The coupon is ONLY ever attached server-side by
 * handleCheckout when promo=LIFETIME10 and the merchant is eligible — never
 * via the manual code field (which is disabled for attached sessions anyway).
 */
function objectHasLifetimeCoupon(obj: Record<string, unknown>): boolean {
  const discounts = obj.discounts;
  if (!Array.isArray(discounts)) return false;
  return discounts.some((d) => {
    if (!d || typeof d !== "object") return false;
    const coupon = (d as { coupon?: { id?: unknown } }).coupon;
    return !!coupon && typeof coupon === "object" && (coupon as { id?: unknown }).id === LIFETIME_COUPON_ID;
  });
}
/**
 * Record a lifetime free-Pro slot from a completed checkout session / created
 * subscription that carries the lifetime coupon. Handles the quota race: when
 * recordLifetimeMember reports "full" (all 10 slots taken by the time this
 * completion landed, and the merchant is not a lifetime member), the coupon
 * must NOT stay on the subscription — best-effort DELETE the subscription's
 * discount so no 11th subscription ever keeps the free-Pro discount. Never
 * throws into the webhook; failures are logged and absorbed (a leftover coupon
 * on a stray 11th subscription is a billing anomaly the owner-notification/ops
 * can see, not a reason to fail the event).
 */
async function recordLifetimeFromObject(
  db: Database,
  obj: {
    subscription?: string;
    id?: string;
    customer_details?: { email?: string | null };
  },
  kind: "checkout" | "subscription",
): Promise<void> {
  if (!objectHasLifetimeCoupon(obj as Record<string, unknown>)) return;
  const merchantId = (obj as { metadata?: { merchant_id?: string } }).metadata?.merchant_id
    ? parseInt((obj as { metadata?: { merchant_id?: string } }).metadata!.merchant_id!, 10)
    : null;
  if (!merchantId) {
    console.warn(`[billing] ${kind} carries the lifetime coupon but no metadata.merchant_id — skipping slot recording`);
    return;
  }
  const subscriptionId = obj.subscription ?? obj.id;
  if (!subscriptionId) {
    console.warn(`[billing] ${kind} carries the lifetime coupon but no subscription id — skipping slot recording`);
    return;
  }
  // Account email comes from the completing party's checkout details (the
  // person/merchant who checked out). Nullable — the coupon id is the source
  // of truth for eligibility; the email is an audit convenience.
  const accountEmail = obj.customer_details?.email ?? null;
  const outcome = recordLifetimeMember(db, merchantId, subscriptionId, accountEmail);
  if (outcome === "inserted") {
    console.log(`[billing] Lifetime member slot earned: merchant=${merchantId} sub=${subscriptionId} (${kind})`);
    return;
  }
  if (outcome === "already") {
    console.log(`[billing] Merchant ${merchantId} is already a lifetime member — coupon on ${subscriptionId} is their benefit (${kind})`);
    return;
  }
  // "full": quota exhausted and this merchant is not a lifetime member — the
  // coupon must not survive. Strip the subscription's discount (idempotent: a
  // replay or already-stripped subscription yields a 4xx we treat as done).
  console.warn(`[billing] Lifetime quota exhausted — removing coupon from subscription ${subscriptionId} (merchant ${merchantId})`);
  try {
    const res = await stripeFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}/discount`, process.env.STRIPE_SECRET_KEY!, { method: "DELETE" });
    if (!res.ok) {
      console.warn(`[billing] Discount removal for ${subscriptionId} returned ${res.status}: ${JSON.stringify(res.data).slice(0, 200)} (likely already removed)`);
    } else {
      console.log(`[billing] Lifetime coupon removed from subscription ${subscriptionId}`);
    }
  } catch (err) {
    console.error(`[billing] Discount removal for ${subscriptionId} failed: ${err instanceof Error ? err.message : String(err)}`);
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
          metadata?: { merchant_id?: string; tier?: string; interval?: string };
        };
        const stripeSubscriptionId = session.subscription;
        const stripeCustomerId = session.customer;
        const merchantId = session.metadata?.merchant_id
          ? parseInt(session.metadata.merchant_id, 10)
          : null;
        const tier = session.metadata?.tier || "standard";
        // Billing interval recorded at checkout (Phase B): metadata[interval]
        // is set by handleCheckout; absent/unknown falls back to month, which
        // is also what every pre-Phase-B subscription actually was.
        const interval = session.metadata?.interval === "year" ? "year" : "month";

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
          createSubscription(db, { merchant_id: merchantId, stripe_subscription_id: stripeSubscriptionId, stripe_customer_id: stripeCustomerId, tier, interval });
          recordSubscriptionEvent(db, { merchant_id: merchantId, stripe_subscription_id: stripeSubscriptionId, event: "created", tier, status: "active" });
          console.log(`[billing] Subscription created: merchant=${merchantId} tier=${tier} sub=${stripeSubscriptionId} customer=${stripeCustomerId || "n/a"}`);
          // Owner notification: "💳 Paid subscription — ..." for real
          // (non-dev/test) merchants. Inside the else so idempotent replays
          // of an already-created subscription do not re-notify. Never
          // throws into the webhook — failures are caught by the module.
          try {
            await notifyOwnerPaidSubscription(db, merchantId, tier, stripeCustomerId ?? null);
          } catch (err: unknown) {
            console.error(`[billing] owner paid-subscription notification error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Data-rights (PROMISES_AUDIT #42): a merchant who subscribes is not
        // cancelling — clear any pending 30-day deletion clock from an earlier
        // cancellation (an active subscriber must never be purged by the
        // scheduler). Runs for both new and replayed sessions (idempotent).
        clearMerchantDeletion(db, merchantId);

        // Lifetime free-Pro giveaway: when this completed session carried the
        // lifetime coupon, atomically record the slot (guarded INSERT — at
        // most 10 ever). Runs for both new and replayed sessions; idempotent
        // (merchant_id PK). See recordLifetimeFromObject for the quota-race
        // strip.
        await recordLifetimeFromObject(
          db,
          session as unknown as { subscription?: string; id?: string; customer_details?: { email?: string | null } },
          "checkout",
        );

        return new Response(JSON.stringify({ received: true, action: "subscription_created" }), { status: 200, headers });
      }

      case "customer.subscription.created": {
        const sub = obj as { id?: string };
        // Lifetime free-Pro giveaway fallback path: if the
        // checkout.session.completed event was ever missed, the created
        // subscription itself carries the coupon in `discounts` — record the
        // slot here instead. Idempotent with the checkout path (merchant_id PK
        // + subscription_id UNIQUE).
        if (sub.id) {
          await recordLifetimeFromObject(
            db,
            { id: sub.id, metadata: (obj as { metadata?: { merchant_id?: string } }).metadata } as unknown as { subscription?: string; id?: string; customer_details?: { email?: string | null } },
            "subscription",
          );
        }
        return new Response(JSON.stringify({ received: true, event_type: eventType }), { status: 200, headers });
      }

      case "customer.subscription.deleted": {
        const sub = obj as { id?: string };
        if (!sub.id) {
          return new Response(JSON.stringify({ error: "Missing subscription id" }), { status: 400, headers });
        }

        const existing = getSubscriptionByStripeId(db, sub.id);
        if (existing) {
          updateSubscriptionStatus(db, sub.id, "cancelled");
          recordSubscriptionEvent(db, { merchant_id: existing.merchant_id, stripe_subscription_id: sub.id, event: "cancelled", tier: existing.tier, status: "cancelled" });
          console.log(`[billing] Subscription ${sub.id} marked cancelled`);
          // Owner notification: "❌ <email> canceled <Plan>" for real
          // (non-dev/test) merchants. Never throws into the webhook.
          try {
            await notifyOwnerCancelledSubscription(db, existing.merchant_id, existing.tier);
          } catch (err: unknown) {
            console.error(`[billing] owner cancellation notification error: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Full Auto is Pro-only: demote trust_mode if this merchant lost Pro.
          enforceTierTrustMode(db, existing.merchant_id);
          // Data-rights (PROMISES_AUDIT #42): cancelling starts the 30-day
          // deletion clock — the privacy page promises data is deleted within
          // 30 days of cancellation. Set only when not already set (idempotent
          // replays / a second subscription keep the earliest deadline); the
          // daily purge scheduler (separate build) runs purgeMerchantData on
          // merchants whose deletion_scheduled_at has passed.
          scheduleMerchantDeletion(db, existing.merchant_id);
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
          let interval: string | undefined;
          const priceId = sub.items?.data?.[0]?.price?.id;
          if (priceId) {
            tier = tierFromPriceId(priceId);
            interval = intervalFromPriceId(priceId);
          }

          updateSubscriptionStatus(db, sub.id, status, tier, interval);
          recordSubscriptionEvent(db, { merchant_id: existing.merchant_id, stripe_subscription_id: sub.id, event: "updated", tier, status });
          console.log(`[billing] Subscription ${sub.id} updated: status=${status} tier=${tier || "unchanged"}`);
          // Full Auto is Pro-only: demote trust_mode if this merchant lost Pro
          // (downgrade to Standard, lapse to past_due, etc.).
          enforceTierTrustMode(db, existing.merchant_id);
          // Data-rights: a subscription returning to active (reactivation,
          // payment recovered) cancels any pending deletion clock — an active
          // subscriber is never scheduled for deletion.
          if (status === "active") clearMerchantDeletion(db, existing.merchant_id);
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
