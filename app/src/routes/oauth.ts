import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { ensureDefaultMerchant, resolveMerchant } from "../db";
import { saveStripeConnection, getStripeConnection } from "../middleware/auth";

const STRIPE_CONNECT_TOKEN_URL = "https://connect.stripe.com/oauth/token";
const STRIPE_CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/express/oauth/authorize";

// ── OAuth CSRF state store ──
// Single-use, in-memory, TTL 10 minutes. Binds an OAuth callback to the
// authorize request that started it and to the merchant who initiated it,
// preventing CSRF attacks where an attacker tricks a user into linking the
// attacker's Stripe account.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map<string, { merchantId: number; expiresAt: number }>();

function createOAuthState(merchantId: number): string {
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, { merchantId, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  return state;
}

/** Validate and consume a state value. Returns null when missing/unknown/expired. */
function consumeOAuthState(state: string | null): { merchantId: number } | null {
  if (!state) return null;
  const entry = oauthStates.get(state);
  oauthStates.delete(state); // single-use regardless of outcome
  if (!entry || entry.expiresAt < Date.now()) return null;
  return { merchantId: entry.merchantId };
}

/**
 * GET /stripe/connect — Redirect the merchant to Stripe's OAuth authorization page.
 */
export async function handleStripeConnect(db: Database, req: Request): Promise<Response> {
  ensureDefaultMerchant(db);

  const clientId = process.env.STRIPE_CLIENT_ID;
  const baseUrl = process.env.BASE_URL || "http://localhost:3001";

  // Capture the merchant initiating the flow so the callback can attribute
  // the connection to the right merchant (and the CSRF `state` binds the
  // callback to this initiation).
  const merchant = resolveMerchant(db);
  const state = createOAuthState(merchant?.id ?? 1);

  // Build the OAuth authorize URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId || "PLACEHOLDER_CLIENT_ID",
    scope: "read_write",
    redirect_uri: `${baseUrl}/stripe/oauth/callback`,
    state,
  });

  const authorizeUrl = `${STRIPE_CONNECT_AUTHORIZE_URL}?${params.toString()}`;

  console.log(`[oauth] Redirecting to Stripe Connect: ${authorizeUrl.substring(0, 80)}...`);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
    },
  });
}

/**
 * GET /stripe/oauth/callback — Handle the OAuth callback from Stripe.
 * Exchanges the authorization code for an access token and stores the connection.
 */
export async function handleStripeOAuthCallback(db: Database, req: Request): Promise<Response> {
  const baseUrl = process.env.BASE_URL || "http://localhost:3001";
  const url = new URL(req.url);

  // Validate the CSRF state BEFORE doing anything else — reject callbacks
  // that don't carry a state we issued (prevents login CSRF / account linking
  // attacks). Single-use, so a replayed callback also fails here.
  const stateEntry = consumeOAuthState(url.searchParams.get("state"));
  if (!stateEntry) {
    console.error("[oauth] Missing or invalid CSRF state in OAuth callback");
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/?error=invalid_state`,
      },
    });
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // If Stripe returned an error
  if (error) {
    console.error(`[oauth] Stripe OAuth error: ${error} — ${errorDescription || "no description"}`);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/?error=oauth_denied&detail=${encodeURIComponent(errorDescription || error)}`,
      },
    });
  }

  if (!code) {
    console.error("[oauth] No authorization code in callback");
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/?error=no_code`,
      },
    });
  }

  // Exchange the authorization code for an access token
  try {
    const clientSecret = process.env.STRIPE_SECRET_KEY;
    if (!clientSecret) {
      console.error("[oauth] STRIPE_SECRET_KEY not set — cannot exchange OAuth code");
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${baseUrl}/?error=no_secret_key`,
        },
      });
    }

    console.log(`[oauth] Exchanging authorization code for access token...`);

    const tokenRes = await fetch(STRIPE_CONNECT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_secret: clientSecret,
      }).toString(),
    });

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      refresh_token?: string;
      stripe_user_id?: string;
      stripe_publishable_key?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || tokenData.error) {
      console.error(`[oauth] Token exchange failed: ${tokenData.error} — ${tokenData.error_description || "no description"}`);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${baseUrl}/?error=token_exchange_failed&detail=${encodeURIComponent(tokenData.error_description || tokenData.error || "unknown")}`,
        },
      });
    }

    const stripeAccountId = tokenData.stripe_user_id;
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const publishableKey = tokenData.stripe_publishable_key;

    if (!stripeAccountId || !accessToken || !publishableKey) {
      console.error("[oauth] Missing required fields in token response", { stripeAccountId, hasAccessToken: !!accessToken, hasPublishableKey: !!publishableKey });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${baseUrl}/?error=incomplete_token_response`,
        },
      });
    }

    ensureDefaultMerchant(db);

    // Attribute the connection to the right merchant: prefer the merchant
    // that already owns this Stripe account (reconnect case), otherwise the
    // merchant who initiated this OAuth flow (captured in the CSRF state) —
    // never blindly "row 1".
    const existingConn = db
      .query("SELECT merchant_id FROM stripe_connections WHERE id = ?")
      .get(stripeAccountId) as { merchant_id: number } | null;
    const merchantId = existingConn?.merchant_id ?? stateEntry.merchantId;

    // Store the OAuth connection
    saveStripeConnection(db, {
      stripe_account_id: stripeAccountId,
      merchant_id: merchantId,
      access_token: accessToken,
      refresh_token: refreshToken,
      stripe_publishable_key: publishableKey,
    });

    // Establish the authenticated merchant session after connection succeeds.
    const sessionToken = randomBytes(32).toString("hex");
    db.run(
      "INSERT INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
      [sessionToken, merchantId],
    );

    console.log(`[oauth] Stripe Connect successful! Account: ${stripeAccountId}, Merchant: ${merchantId}`);

    // Redirect back to dashboard with a secure, 30-day session cookie.
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/?connected=true&account=${encodeURIComponent(stripeAccountId)}`,
        "Set-Cookie": `session=${encodeURIComponent(sessionToken)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=2592000`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[oauth] Token exchange error: ${message}`);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/?error=token_exchange_error&detail=${encodeURIComponent(message)}`,
      },
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
