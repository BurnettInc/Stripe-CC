import type { Database } from "bun:sqlite";
import { ensureDefaultMerchant, getMerchantById } from "../db";
import { saveStripeConnection, getStripeConnection } from "../middleware/auth";

const STRIPE_CONNECT_TOKEN_URL = "https://connect.stripe.com/oauth/token";
const STRIPE_CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/express/oauth/authorize";

/**
 * GET /stripe/connect — Redirect the merchant to Stripe's OAuth authorization page.
 */
export async function handleStripeConnect(db: Database, req: Request): Promise<Response> {
  ensureDefaultMerchant(db);

  const clientId = process.env.STRIPE_CLIENT_ID;
  const baseUrl = process.env.BASE_URL || "http://localhost:3001";

  // Build the OAuth authorize URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId || "PLACEHOLDER_CLIENT_ID",
    scope: "read_write",
    redirect_uri: `${baseUrl}/stripe/oauth/callback`,
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
    const merchant = db.query("SELECT id FROM merchants LIMIT 1").get() as { id: number };
    const merchantId = merchant.id;

    // Store the OAuth connection
    saveStripeConnection(db, {
      stripe_account_id: stripeAccountId,
      merchant_id: merchantId,
      access_token: accessToken,
      refresh_token: refreshToken,
      stripe_publishable_key: publishableKey,
    });

    console.log(`[oauth] Stripe Connect successful! Account: ${stripeAccountId}, Merchant: ${merchantId}`);

    // Redirect back to dashboard with success
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/?connected=true&account=${encodeURIComponent(stripeAccountId)}`,
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

  const merchant = db.query("SELECT id FROM merchants LIMIT 1").get() as { id: number };
  const conn = getStripeConnection(db, merchant.id);

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
