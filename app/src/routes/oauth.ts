import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { ensureDefaultMerchant, resolveMerchant } from "../db";
import { saveStripeConnection, getStripeConnection } from "../middleware/auth";
import { readCookie } from "../middleware/session";
import { notifyOwnerStripeConnect } from "../pipeline/owner-notify";
import Stripe from "stripe";

// ── Cross-host session handoff ──
// The session cookie is host-only (no Domain attribute): the OAuth callback
// runs on the Railway host (BASE_URL) and sets a cookie scoped to that host
// only. The web dashboard lives on www.getcollectionscopilot.com — a different
// registrable domain — so the browser never sends the Railway cookie there and
// the dashboard 401s on every API call for merchants who connected through the
// Stripe App. Fix: after the callback mints the session, bounce the merchant
// through GET /oauth/session on the www host (a first-party navigation, so it
// works under third-party cookie blocking), which validates the token and sets
// the SAME host-only cookie for www. The final hop is the success page, still
// served from the Railway host so the oauth-complete postMessage keeps its
// current origin. Dashboard JS needs no changes — its relative fetches on www
// now carry the www cookie.
const WWW_BASE = "https://www.getcollectionscopilot.com";
const WWW_DASHBOARD_URL = `${WWW_BASE}/dashboard`;
export { WWW_BASE, WWW_DASHBOARD_URL };

// Allow-listed destinations for the ?next= handoff parameter (open-redirect
// guard): only our own hosts + Stripe's dashboard. Anything else falls back to
// the www dashboard. http://localhost:3002 keeps local dev and tests working
// (BASE_URL's localhost default).
const ALLOWED_NEXT_ORIGINS = new Set([
  "https://stripe-cc-production.up.railway.app",
  "https://www.getcollectionscopilot.com",
  "https://dashboard.stripe.com",
  "http://localhost:3002",
]);

/**
 * Session cookie string — MUST mirror the callback's exactly. Host-only (no
 * Domain attribute): the /oauth/session handoff sets it for the www host while
 * the callback sets it for the Railway host, giving the merchant a cookie on
 * both hosts with the same token.
 */
export function sessionCookieFor(token: string): string {
  return `session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=2592000`;
}

/** True when `next` is an absolute URL on an allow-listed origin. */
export function isAllowedNextUrl(next: string): boolean {
  try {
    const url = new URL(next);
    if (url.username || url.password) return false;
    return ALLOWED_NEXT_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

/**
 * GET /oauth/session — cross-host session handoff.
 * Validates the token minted by the OAuth callback (query param — the token is
 * carried in the URL because the browser won't send the Railway cookie to www)
 * and sets the same host-only session cookie for the www host, then 302s to the
 * allow-listed ?next= URL. Unknown/expired tokens get NO cookie and fall back
 * to the www dashboard; a non-allow-listed next is ignored (dashboard fallback)
 * so the endpoint can never be an open redirect. Served on any host — the same
 * Railway service answers both www.getcollectionscopilot.com and the Railway
 * host, so no host-specific routing is needed.
 */
export function handleOAuthSession(db: Database, req: Request): Response {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const next = url.searchParams.get("next") || "";

  const row = token
    ? (db
        .query("SELECT merchant_id FROM sessions WHERE token = ? AND expires_at > datetime('now')")
        .get(token) as { merchant_id: number } | null)
    : null;

  if (!row) {
    return new Response(null, { status: 302, headers: { Location: WWW_DASHBOARD_URL } });
  }

  const dest = isAllowedNextUrl(next) ? next : WWW_DASHBOARD_URL;
  return new Response(null, {
    status: 302,
    headers: { Location: dest, "Set-Cookie": sessionCookieFor(token) },
  });
}

/**
 * GET /oauth/handoff — the dashboard's self-healing session handoff.
 * The web dashboard's JS bounces here (a top-level navigation to the Railway
 * host) when a relative API fetch returns 401 — the browser has a Railway-host
 * session cookie but no www-host cookie, which is exactly the state of any
 * merchant who connected before the /oauth/session handoff shipped (their
 * OAuth callback minted a session and set the cookie for the Railway host
 * only). The session cookie is read from the request exactly like
 * requireSession does (same token lookup, same cookie parsing), because this
 * request IS a normal first-party navigation to the Railway host — the
 * browser sends the cookie. With a valid session the response 302s through
 * the www-host /oauth/session endpoint (token + next = the www dashboard),
 * which sets the www-host cookie and returns the browser to the dashboard —
 * self-healed, no manual reconnect needed. No/invalid session → 302 straight
 * to the www dashboard: that user has no session anywhere, and the
 * dashboard's one-shot sessionStorage guard (cc_handoff) prevents any
 * redirect loop.
 */
export function handleOAuthHandoff(db: Database, req: Request): Response {
  const token = readCookie(req, "session") ?? "";

  const row = token
    ? (db
        .query("SELECT merchant_id FROM sessions WHERE token = ? AND expires_at > datetime('now')")
        .get(token) as { merchant_id: number } | null)
    : null;

  if (!row) {
    return new Response(null, { status: 302, headers: { Location: WWW_DASHBOARD_URL } });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${WWW_BASE}/oauth/session?token=${encodeURIComponent(token)}&next=${encodeURIComponent(WWW_DASHBOARD_URL)}`,
    },
  });
}

/** The "Stripe account connected" success page (both return modes). */
function successPageHtml(baseUrl: string, wantsStripe: boolean): string {
  return wantsStripe
    ? `<!DOCTYPE html>
    <html><head><title>Connected — CollectionsCopilot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family:system-ui,sans-serif;text-align:center;padding-top:80px;background:#F9FAFB;">
    <div style="background:white;max-width:420px;margin:0 auto;padding:40px 30px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <div style="font-size:48px;margin-bottom:16px;">✅</div>
      <h2 style="margin:0 0 8px;color:#111827;">Stripe account connected!</h2>
      <p style="color:#6B7280;margin:0 0 24px;">Your CollectionsCopilot app is set up. Taking you back to Stripe…</p>
      <a href="https://dashboard.stripe.com" style="display:inline-block;background:#635BFF;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">Return to Stripe dashboard</a>
      <p style="color:#9CA3AF;margin:20px 0 0;font-size:13px;">or open your <a href="${baseUrl}/dashboard" style="color:#6B7280;">CollectionsCopilot dashboard</a></p>
    </div>
    <script>
      try { window.opener?.postMessage('oauth-complete', '*'); } catch(_) {}
      setTimeout(function(){ window.location.href = 'https://dashboard.stripe.com'; }, 3000);
    </script>
    </body></html>`
    : `<!DOCTYPE html>
    <html><head><title>Connected — CollectionsCopilot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family:system-ui,sans-serif;text-align:center;padding-top:80px;background:#F9FAFB;">
    <div style="background:white;max-width:420px;margin:0 auto;padding:40px 30px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <div style="font-size:48px;margin-bottom:16px;">✅</div>
      <h2 style="margin:0 0 8px;color:#111827;">Stripe account connected!</h2>
      <p style="color:#6B7280;margin:0 0 20px;">Redirecting to your dashboard…</p>
    </div>
    <script>
      try { window.opener?.postMessage('oauth-complete', '*'); } catch(_) {}
      setTimeout(function(){ window.location.href = '${baseUrl}/dashboard?connected=true'; }, 2000);
    </script>
    </body></html>`;
}

/**
 * GET /oauth/success — the final page of the cross-host handoff chain
 * (callback → www /oauth/session → here). Always served from the Railway host
 * (baseUrl) so the oauth-complete postMessage keeps its current origin and the
 * auto-redirects behave exactly as before. The return param is passed through
 * so the page renders identically to the pre-handoff callback success page.
 */
export function handleOAuthSuccess(req: Request): Response {
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const wantsStripe = new URL(req.url).searchParams.get("return") === "stripe";
  return new Response(successPageHtml(baseUrl, wantsStripe), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /stripe/connect — Create (or resume) a Stripe Express connected account
 * and redirect the merchant into Stripe's hosted onboarding flow.
 * Replaces the deprecated Express OAuth flow.
 */
export async function handleStripeConnect(db: Database, req: Request): Promise<Response> {
  ensureDefaultMerchant(db);

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";

  // Optional ?return=stripe (the Stripe App drawer's Connect buttons pass it):
  // when set, both the onboarding refresh_url and the return_url keep the
  // param so the OAuth callback lands the merchant back in Stripe's dashboard
  // instead of the web dashboard. The web dashboard's own connect link has no
  // return param → default behavior (web dashboard) stays unchanged.
  const wantsStripe = new URL(req.url).searchParams.get("return") === "stripe";
  const withReturn = (u: string) =>
    wantsStripe ? `${u}${u.includes("?") ? "&" : "?"}return=stripe` : u;

  if (!secretKey) {
    console.error("[oauth] STRIPE_SECRET_KEY not set — cannot start onboarding");
    return new Response(null, { status: 302, headers: { Location: `${baseUrl}/dashboard?error=no_secret_key` } });
  }

  const stripe = new Stripe(secretKey);
  const merchant = resolveMerchant(db);
  const merchantId = merchant?.id ?? 1;

  try {
    let accountId = getStripeConnection(db, merchantId)?.id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        metadata: { merchant_id: String(merchantId) },
      });
      accountId = account.id;

      saveStripeConnection(db, {
        stripe_account_id: accountId,
        merchant_id: merchantId,
        access_token: "", // Account Links: no OAuth token — platform uses its own
        refresh_token: null, // secret key with the Stripe-Account header instead.
        stripe_publishable_key: "",
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      // NOTE: /api/stripe/connect, not /api/oauth/connect — the site/platform proxy
      // strips the /api prefix, and the backend only routes /stripe/connect (there
      // is no /oauth/connect route). This URL resumes onboarding via handleStripeConnect.
      refresh_url: withReturn(`${baseUrl}/api/stripe/connect`),
      return_url: withReturn(`${baseUrl}/api/oauth/callback?account=${accountId}`),
      type: "account_onboarding",
    });

    return new Response(null, { status: 302, headers: { Location: accountLink.url } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[oauth] Failed to create account/account link: ${message}`);
    return new Response(null, {
      status: 302,
      headers: { Location: `${baseUrl}/dashboard?error=account_link_failed&detail=${encodeURIComponent(message)}` },
    });
  }
}

/**
 * GET /stripe/oauth/callback — Stripe sends the merchant back here after
 * onboarding. Account Links doesn't return an auth code — we just check
 * whether the account actually finished onboarding.
 */
export async function handleStripeOAuthCallback(db: Database, req: Request): Promise<Response> {
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const url = new URL(req.url);
  const accountId = url.searchParams.get("account");
  // Optional ?return=stripe (the Stripe App drawer's Connect buttons pass it):
  // when set, the success page offers a "Return to Stripe dashboard" link and
  // auto-redirects to https://dashboard.stripe.com after ~3s instead of the
  // web dashboard. Default (no return param) behavior is UNCHANGED.
  const wantsStripe = url.searchParams.get("return") === "stripe";

  if (!accountId || !secretKey) {
    return new Response(null, { status: 302, headers: { Location: `${baseUrl}/dashboard?error=missing_account` } });
  }

  try {
    const stripe = new Stripe(secretKey);
    const account = await stripe.accounts.retrieve(accountId);

    if (!account.details_submitted || !account.charges_enabled) {
      // Account exists but onboarding isn't complete — send the merchant back
      // through the connect endpoint, which issues a fresh account link. Keep
      // the return param so a drawer-initiated flow stays in Stripe.
      return new Response(null, {
        status: 302,
        headers: { Location: `${baseUrl}/api/stripe/connect${wantsStripe ? "?return=stripe" : ""}` },
      });
    }

    // ── Session creation (ported from the old Express OAuth callback) ──
    // Attribute the session to the merchant owning this connected account
    // (the connection row was created in handleStripeConnect), falling back to
    // the most-recent/default merchant.
    const merchantId = resolveMerchant(db, accountId)?.id ?? 1;
    const sessionToken = randomBytes(32).toString("hex");
    db.run(
      "INSERT INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
      [sessionToken, merchantId],
    );

    console.log(`[oauth] Stripe account connected: ${accountId} (merchant ${merchantId})`);

    // Owner signup notification: email the owner (OWNER_NOTIFY_EMAIL) when a
    // real merchant finishes connecting. Dev/test merchants are excluded
    // inside (dev_pro / acct_default / .local). Never throws into the
    // callback — failures are caught and logged by the module.
    try {
      const accountEmail = typeof account.email === "string" && account.email ? account.email : null;
      await notifyOwnerStripeConnect(db, merchantId, accountId, accountEmail);
    } catch (err: unknown) {
      console.error(`[oauth] owner connect notification error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Cross-host session handoff: set the Railway-host session cookie here
    // (first-party, as today) AND redirect the merchant through
    // https://www.getcollectionscopilot.com/oauth/session?token=...&next=...
    // so the web dashboard's host (a different registrable domain) gets the
    // same host-only cookie. The handoff is a first-party top-level
    // navigation — it works under third-party cookie blocking. The final hop
    // (the `next` URL) is the success page on THIS host (baseUrl), so the
    // oauth-complete postMessage keeps its current origin and the success
    // page renders identically to before (the return param is passed through
    // via the query). The handoff's allow-list covers the Railway host, so
    // the success URL always passes.
    const successUrl = `${baseUrl}/oauth/success${wantsStripe ? "?return=stripe" : ""}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${WWW_BASE}/oauth/session?token=${encodeURIComponent(sessionToken)}&next=${encodeURIComponent(successUrl)}`,
        "Set-Cookie": sessionCookieFor(sessionToken),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(null, {
      status: 302,
      headers: { Location: `${baseUrl}/dashboard?error=verify_failed&detail=${encodeURIComponent(message)}` },
    });
  }
}

/**
 * GET /stripe/connection — Return the current Stripe connection status for the dashboard.
 */
export async function handleStripeConnectionStatus(db: Database): Promise<Response> {
  ensureDefaultMerchant(db);

  // Resolve the merchant without assuming "row 1": the connected merchant
  // (most recent connection) wins, default merchant is the fallback.
  const merchant = resolveMerchant(db);
  const conn = merchant ? getStripeConnection(db, merchant.id) : null;

  return new Response(
    JSON.stringify(conn
      ? {
          connected: true,
          account_name: conn.id,
        }
      : { connected: false }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
