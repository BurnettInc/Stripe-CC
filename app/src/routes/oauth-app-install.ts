/**
 * Stripe Apps OAuth v2 install flow (marketplace install).
 *
 * The Stripe App Marketplace installs CollectionsCopilot through Stripe's
 * OAuth v2 flow (https://docs.stripe.com/stripe-apps/api-authentication/oauth),
 * NOT the Express connected-account + Account Links flow used by the web
 * dashboard (/stripe/connect). The two flows are parallel: this module owns
 * the marketplace path, routes/oauth.ts owns the web-connect path, and they
 * share only the session-mint + cross-host handoff mechanics.
 *
 * Flow (this module):
 *   1. GET /oauth/install            — branded install page (the URL given to
 *                                      Stripe as the marketplace install URL).
 *   2. GET /oauth/install/start      — generate a CSRF-safe state row (link
 *                                      type test|live encoded inside the state
 *                                      per the docs), 302 → marketplace.stripe
 *                                      .com/oauth/v2/authorize?client_id=…&
 *                                      redirect_uri=…&state=…
 *   3. GET /oauth/callback?code=…&state=…
 *                                    — Stripe redirects back with a one-time
 *                                      code (valid 5 min). Verify+consume the
 *                                      state row (CSRF), exchange the code at
 *                                      POST /v1/oauth/token (Basic auth with
 *                                      the app developer key matching the link
 *                                      type), store {stripe_user_id,
 *                                      access_token, refresh_token, livemode,
 *                                      expires_at} in oauth_tokens (encrypted
 *                                      at rest), create/find the merchant,
 *                                      mirror into stripe_connections so the
 *                                      existing pipeline sees the connection,
 *                                      mint a session, then bounce through the
 *                                      www-host /oauth/session handoff so the
 *                                      user lands logged-in on the dashboard.
 *   4. refreshAppAccessToken()      — helper for backend code that needs to
 *                                      act on the user's behalf: access tokens
 *                                      expire ~1h, refresh tokens expire ~1yr
 *                                      and ROLL on every exchange.
 *
 * Env: STRIPE_CLIENT_ID (app client id, ca_…), STRIPE_APP_TEST_KEY /
 * STRIPE_APP_LIVE_KEY (app developer API keys). Everything degrades to a
 * clear error page — never a crash — when unset.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { ensureDefaultMerchant } from "../db";
import { encryptValue, decryptValue, getEncryptionKey } from "../middleware/auth";
import { saveStripeConnection } from "../middleware/auth";
import { sessionCookieFor, WWW_BASE, WWW_DASHBOARD_URL } from "./oauth";

// ── Constants ──
const MARKETPLACE_AUTHORIZE_URL = "https://marketplace.stripe.com/oauth/v2/authorize";
// Same env-override convention as routes/billing.ts: endpoint tests point
// STRIPE_API_BASE at a local stub (e.g. http://localhost:3199/v1).
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, "");
// State rows are valid for 30 minutes (the one-time code itself expires in 5).
const STATE_TTL_MINUTES = 30;
const LINK_TYPES = ["test", "live"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export function isLinkType(value: string): value is LinkType {
  return value === "test" || value === "live";
}

/** App developer API key matching the link type (docs: use the key that
 * matches the link type — test links only work with test-mode keys). */
export function appDevKeyFor(linkType: LinkType): string | null {
  return linkType === "live"
    ? (process.env.STRIPE_APP_LIVE_KEY ?? null)
    : (process.env.STRIPE_APP_TEST_KEY ?? null);
}

// ── CSRF-safe state ──
// State = "<random-hex>:<link-type>". The DB row is authoritative for the link
// type (never trust a parsed suffix); rows are one-time (deleted on consume)
// and expire after STATE_TTL_MINUTES.
export function createInstallState(db: Database, linkType: LinkType): string {
  // Opportunistic cleanup of expired rows (also enforced at read).
  db.run("DELETE FROM oauth_install_states WHERE created_at < datetime('now', ?)", [`-${STATE_TTL_MINUTES} minutes`]);
  const state = `${randomBytes(24).toString("hex")}:${linkType}`;
  db.run("INSERT INTO oauth_install_states (state, link_type) VALUES (?, ?)", [state, linkType]);
  return state;
}

/** Verify + consume a state row. Returns the link type, or null when the
 * state is unknown, expired, or already used. One-time by construction. */
export function consumeInstallState(db: Database, state: string): LinkType | null {
  if (!state) return null;
  const row = db
    .query("SELECT link_type FROM oauth_install_states WHERE state = ? AND created_at >= datetime('now', ?)")
    .get(state, `-${STATE_TTL_MINUTES} minutes`) as { link_type: LinkType } | null;
  if (!row) return null;
  db.run("DELETE FROM oauth_install_states WHERE state = ?", [state]);
  return row.link_type;
}

// ── Authorize URL ──
export function buildAuthorizeUrl(state: string): { url: string } | { error: string } {
  const clientId = process.env.STRIPE_CLIENT_ID;
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const redirectUri = process.env.STRIPE_APP_REDIRECT_URI || `${baseUrl}/oauth/callback`;
  if (!clientId) {
    return { error: "STRIPE_CLIENT_ID is not set — the app install link cannot be built. Set it to the app's client id (ca_…) in the Stripe dashboard." };
  }
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
  return { url: `${MARKETPLACE_AUTHORIZE_URL}?${params.toString()}` };
}

// ── Minimal branded install page ──
// The reviewer required the marketplace install URL to be a page that
// initiates onboarding with clear instructions using OAuth install links — not
// a bare redirect. The page renders a "Connect with Stripe" button per
// configured mode; each button starts /oauth/install/start, which builds a
// fresh state and redirects into the marketplace authorize flow.
export function installPageHtml(baseUrl: string, clientIdSet: boolean, configuredModes: LinkType[]): string {
  const buttonFor = (linkType: LinkType, label: string) =>
    `<a href="${baseUrl}/oauth/install/start?link=${linkType}" style="display:block;background:#635BFF;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:8px;margin:10px 0;text-align:center;">${label}</a>`;

  let body: string;
  if (!clientIdSet) {
    body = `<p style="color:#B45309;background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 16px;font-size:14px;"><strong>Installation is not configured yet.</strong><br>The app developer hasn't set <code>STRIPE_CLIENT_ID</code>. Once set, this page will show a "Connect with Stripe" button.</p>`;
  } else if (configuredModes.length === 0) {
    body = `<p style="color:#B45309;background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 16px;font-size:14px;"><strong>No developer keys configured yet.</strong><br>Set <code>STRIPE_APP_TEST_KEY</code> (and <code>STRIPE_APP_LIVE_KEY</code> for live) to enable installation. No action is needed on your side.</p>`;
  } else {
    body = `<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 18px;">Connect your Stripe account to let CollectionsCopilot watch for overdue invoices and send your customers friendly, automatic payment reminders.</p>
      <ol style="color:#4B5563;font-size:14px;line-height:1.8;margin:0 0 22px;padding-left:20px;text-align:left;">
        <li>Click <strong>Connect with Stripe</strong> below — you'll be taken to Stripe's authorization screen.</li>
        <li>Review the permissions and approve the connection.</li>
        <li>You'll land in your CollectionsCopilot dashboard, ready to configure reminders.</li>
      </ol>
      ${configuredModes.includes("test") ? buttonFor("test", "Connect with Stripe — test mode") : ""}
      ${configuredModes.includes("live") ? buttonFor("live", "Connect with Stripe — live mode") : ""}
      <p style="color:#9CA3AF;font-size:12px;margin:16px 0 0;">Questions? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install CollectionsCopilot — Connect Stripe</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F3F4F6; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 40px 44px; max-width: 480px; width: 100%; box-sizing: border-box; text-align: center; }
    .logo { font-size: 22px; font-weight: 700; color: #1F2937; margin-bottom: 6px; }
    .logo span { color: #635BFF; }
    h1 { font-size: 24px; margin: 14px 0 10px; color: #111827; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Collections<span>Copilot</span></div>
    <h1>Install CollectionsCopilot</h1>
    ${body}
  </div>
</body>
</html>`;
}

/** GET /oauth/install — the marketplace install page. ?auto=1 skips the page
 * and 302s straight into the authorize flow (useful for programmatic links
 * and tests). */
export function handleAppInstallPage(db: Database, req: Request): Response {
  ensureDefaultMerchant(db);
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const clientIdSet = !!process.env.STRIPE_CLIENT_ID;
  const configuredModes: LinkType[] = LINK_TYPES.filter((lt) => appDevKeyFor(lt));

  const url = new URL(req.url);
  if (url.searchParams.get("auto") === "1") {
    const link = isLinkType(url.searchParams.get("link") ?? "") ? url.searchParams.get("link")! : "test";
    return new Response(null, { status: 302, headers: { Location: `${baseUrl}/oauth/install/start?link=${link}` } });
  }
  return new Response(installPageHtml(baseUrl, clientIdSet, configuredModes), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** GET /oauth/install/start — mint a fresh state and 302 into Stripe's
 * marketplace authorize flow. */
export function handleAppInstallStart(db: Database, req: Request): Response {
  ensureDefaultMerchant(db);
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const url = new URL(req.url);
  const linkParam = url.searchParams.get("link") ?? "";
  const linkType: LinkType = isLinkType(linkParam) ? linkParam : "test";

  const state = createInstallState(db, linkType);
  const built = buildAuthorizeUrl(state);
  if ("error" in built) {
    return new Response(appOAuthErrorPage(built.error), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  console.log(`[oauth-app] install start: link=${linkType} state=${state.slice(0, 16)}… → marketplace authorize`);
  return new Response(null, { status: 302, headers: { Location: built.url } });
}

// ── Token exchange + storage ──

export interface ExchangeResult {
  access_token: string;
  livemode: boolean;
  refresh_token: string | null;
  scope?: string;
  stripe_publishable_key?: string;
  stripe_user_id: string;
  token_type?: string;
}

/** POST /v1/oauth/token with grant_type=authorization_code, Basic auth with
 * the app developer key matching the link type. */
export async function exchangeCodeForTokens(
  code: string,
  linkType: LinkType
): Promise<{ ok: true; tokens: ExchangeResult } | { ok: false; error: string }> {
  const key = appDevKeyFor(linkType);
  if (!key) {
    return { ok: false, error: `STRIPE_APP_${linkType === "live" ? "LIVE" : "TEST"}_KEY is not set — cannot exchange the authorization code for ${linkType}-mode tokens.` };
  }
  const body = new URLSearchParams({ grant_type: "authorization_code", code });
  const res = await fetch(`${STRIPE_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object" || !("access_token" in data)) {
    const d = (data ?? {}) as Record<string, unknown>;
    return { ok: false, error: `Stripe token exchange failed (HTTP ${res.status}): ${String(d.error_description ?? d.error ?? "unexpected response")}` };
  }
  const t = data as Record<string, unknown>;
  return {
    ok: true,
    tokens: {
      access_token: String(t.access_token),
      livemode: t.livemode === true || t.livemode === 1,
      refresh_token: typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : null,
      scope: typeof t.scope === "string" ? t.scope : undefined,
      stripe_publishable_key: typeof t.stripe_publishable_key === "string" ? t.stripe_publishable_key : "",
      stripe_user_id: String(t.stripe_user_id ?? ""),
      token_type: typeof t.token_type === "string" ? t.token_type : undefined,
    },
  };
}

export interface AppOAuthTokens {
  stripe_user_id: string;
  merchant_id: number;
  access_token: string;
  refresh_token: string | null;
  stripe_publishable_key: string;
  livemode: number;
  link_type: LinkType;
  expires_at: string;
}

/** Store a token pair (encrypted at rest when TOKEN_ENCRYPTION_KEY is set,
 * same AES-256-GCM scheme as stripe_connections). Upserts on stripe_user_id. */
export function saveAppOAuthTokens(
  db: Database,
  params: {
    stripe_user_id: string;
    merchant_id: number;
    access_token: string;
    refresh_token: string | null;
    stripe_publishable_key: string;
    livemode: boolean | number;
    link_type: LinkType;
  }
): void {
  const encKey = getEncryptionKey();
  const accessToken = encryptValue(params.access_token, encKey);
  const refreshToken = encryptValue(params.refresh_token, encKey);
  db.run(
    `INSERT INTO oauth_tokens
       (stripe_user_id, merchant_id, access_token, refresh_token, stripe_publishable_key, livemode, link_type, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 hour'), datetime('now'))
     ON CONFLICT(stripe_user_id) DO UPDATE SET
       merchant_id = excluded.merchant_id,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       stripe_publishable_key = excluded.stripe_publishable_key,
       livemode = excluded.livemode,
       link_type = excluded.link_type,
       expires_at = excluded.expires_at,
       updated_at = datetime('now')`,
    [
      params.stripe_user_id,
      params.merchant_id,
      accessToken,
      refreshToken,
      params.stripe_publishable_key,
      params.livemode ? 1 : 0,
      params.link_type,
    ]
  );
}

/** Read + decrypt the stored token pair for a Stripe user. */
export function getAppOAuthTokens(db: Database, stripeUserId: string): AppOAuthTokens | null {
  const row = db.query("SELECT * FROM oauth_tokens WHERE stripe_user_id = ?").get(stripeUserId) as AppOAuthTokens | null;
  if (!row) return null;
  const encKey = getEncryptionKey();
  return {
    ...row,
    access_token: decryptValue(row.access_token, encKey) ?? "",
    refresh_token: decryptValue(row.refresh_token, encKey),
  };
}

/**
 * Refresh a stored token pair (grant_type=refresh_token). Access tokens expire
 * ~1h; refresh tokens expire ~1yr and ROLL on every exchange — the new pair is
 * stored, so the caller always has the latest. Returns the fresh access token.
 * When the stored access token is still valid (and force is false) no network
 * call is made. Used by any backend code that needs to act on the user's
 * behalf (e.g. reading invoices with the merchant's own credentials).
 */
export async function refreshAppAccessToken(
  db: Database,
  stripeUserId: string,
  force = false
): Promise<{ ok: true; access_token: string; refreshed: boolean } | { ok: false; error: string }> {
  const row = getAppOAuthTokens(db, stripeUserId);
  if (!row) return { ok: false, error: "No stored tokens for this Stripe user." };

  if (!force) {
    const stillValid = db
      .query("SELECT 1 AS ok FROM oauth_tokens WHERE stripe_user_id = ? AND expires_at > datetime('now')")
      .get(stripeUserId);
    if (stillValid) return { ok: true, access_token: row.access_token, refreshed: false };
  }

  if (!row.refresh_token) return { ok: false, error: "No refresh token stored — cannot refresh." };
  const key = appDevKeyFor(row.link_type);
  if (!key) return { ok: false, error: `STRIPE_APP_${row.link_type === "live" ? "LIVE" : "TEST"}_KEY is not set — cannot refresh tokens for ${row.link_type}-mode link.` };

  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  const res = await fetch(`${STRIPE_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object" || !("access_token" in data)) {
    const d = (data ?? {}) as Record<string, unknown>;
    return { ok: false, error: `Token refresh failed (HTTP ${res.status}): ${String(d.error_description ?? d.error ?? "unexpected response")}` };
  }
  const t = data as Record<string, unknown>;
  // Refresh tokens roll: the response carries the NEW refresh token. If it is
  // absent for any reason, keep the previous one rather than nulling it.
  const newRefresh = typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : row.refresh_token;
  saveAppOAuthTokens(db, {
    stripe_user_id: typeof t.stripe_user_id === "string" && t.stripe_user_id ? t.stripe_user_id : row.stripe_user_id,
    merchant_id: row.merchant_id,
    access_token: String(t.access_token),
    refresh_token: newRefresh,
    stripe_publishable_key: typeof t.stripe_publishable_key === "string" ? t.stripe_publishable_key : row.stripe_publishable_key,
    livemode: t.livemode === true || t.livemode === 1 ? 1 : row.livemode,
    link_type: row.link_type,
  });
  console.log(`[oauth-app] refreshed access token for ${row.stripe_user_id} (link=${row.link_type})`);
  return { ok: true, access_token: String(t.access_token), refreshed: true };
}

// ── Account + merchant helpers ──

/** Best-effort account fetch using the fresh access token (email/display name
 * for the merchant row). Never throws — null on any failure. */
async function fetchAccountDetails(accessToken: string): Promise<{ email?: string; display_name?: string } | null> {
  try {
    const res = await fetch(`${STRIPE_API}/account`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const acct = (await res.json()) as Record<string, unknown>;
    return {
      email: typeof acct.email === "string" && acct.email ? acct.email : undefined,
      display_name: typeof acct.display_name === "string" && acct.display_name ? acct.display_name : undefined,
    };
  } catch (err) {
    console.error(`[oauth-app] account fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Find the merchant owning a Stripe account, or create it (reusing the
 * merchants table; same shape ensureDefaultMerchant writes). Unknown emails
 * fall back to a .local placeholder so notification/summary code treats the
 * row as a placeholder until the real email is known. */
export function findOrCreateMerchant(db: Database, stripeUserId: string, email?: string | null): number {
  const existing = db.query("SELECT id FROM merchants WHERE stripe_account_id = ?").get(stripeUserId) as { id: number } | null;
  if (existing) return existing.id;
  const finalEmail = email && email.includes("@") ? email : `user_${stripeUserId}@install.local`;
  const info = db.run(
    "INSERT INTO merchants (stripe_account_id, email, trust_mode) VALUES (?, ?, 'draft')",
    [stripeUserId, finalEmail]
  );
  return Number(info.lastInsertRowid);
}

// ── Callback ──

function appOAuthErrorPage(message: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Installation issue — CollectionsCopilot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F3F4F6; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 36px 40px; max-width: 460px; width: 100%; box-sizing: border-box; text-align: center; }
    .logo { font-size: 20px; font-weight: 700; color: #1F2937; margin-bottom: 10px; }
    .logo span { color: #635BFF; }
    h1 { font-size: 20px; margin: 0 0 12px; color: #111827; }
    p { font-size: 14px; line-height: 1.6; color: #4B5563; margin: 0 0 18px; }
    a.btn { display: inline-block; background: #635BFF; color: #fff; text-decoration: none; font-weight: 600; padding: 11px 22px; border-radius: 8px; font-size: 14px; }
    .small { color: #9CA3AF; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Collections<span>Copilot</span></div>
    <h1>Couldn't complete the install</h1>
    <p>${esc(message)}</p>
    <a class="btn" href="/oauth/install">Back to installation</a>
    <p class="small">Still stuck? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>
  </div>
</body>
</html>`;
}

/**
 * GET /oauth/callback?code=…&state=… — the marketplace OAuth v2 callback
 * (index.ts branches here when the `code` param is present). Verifies the
 * state (CSRF), exchanges the one-time code, stores the token pair, creates/
 * finds the merchant, mints a session and bounces through the www-host
 * /oauth/session handoff so the user lands logged-in on the dashboard.
 */
export async function handleAppInstallCallback(db: Database, req: Request): Promise<Response> {
  ensureDefaultMerchant(db);
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const denied = url.searchParams.get("error") ?? "";

  // User declined on Stripe's screen (Stripe redirects back with `error` and
  // no code). Show a friendly page instead of a confusing "invalid code".
  if (denied) {
    return new Response(appOAuthErrorPage(`Authorization was not completed (${denied}). You can try again any time.`), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (!code || !state) {
    return new Response(appOAuthErrorPage("The callback is missing the authorization code or state. Please start the installation again."), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const linkType = consumeInstallState(db, state);
  if (!linkType) {
    return new Response(appOAuthErrorPage("This installation link is invalid or has expired. Please start the installation again."), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const exchanged = await exchangeCodeForTokens(code, linkType);
  if (!exchanged.ok) {
    console.error(`[oauth-app] code exchange failed (link=${linkType}): ${exchanged.error}`);
    return new Response(appOAuthErrorPage(exchanged.error), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const { tokens } = exchanged;
  if (!tokens.stripe_user_id) {
    return new Response(appOAuthErrorPage("Stripe's response did not include an account id (stripe_user_id). Please try again."), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Best-effort account details for the merchant row's email (never fatal).
  const account = await fetchAccountDetails(tokens.access_token);

  const merchantId = findOrCreateMerchant(db, tokens.stripe_user_id, account?.email);
  saveAppOAuthTokens(db, {
    stripe_user_id: tokens.stripe_user_id,
    merchant_id: merchantId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    stripe_publishable_key: tokens.stripe_publishable_key ?? "",
    livemode: tokens.livemode,
    link_type: linkType,
  });
  // Mirror into stripe_connections so the existing pipeline (watcher merchant
  // attribution, /stripe/connection status, resolveMerchant, drawer) sees the
  // connection without changes.
  saveStripeConnection(db, {
    stripe_account_id: tokens.stripe_user_id,
    merchant_id: merchantId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    stripe_publishable_key: tokens.stripe_publishable_key ?? "",
  });

  // Mint the session + cross-host handoff (identical mechanics to the Express
  // callback in routes/oauth.ts): Railway-host cookie here, then bounce
  // through www /oauth/session so the dashboard host gets the same cookie.
  const sessionToken = randomBytes(32).toString("hex");
  db.run(
    "INSERT INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
    [sessionToken, merchantId]
  );
  console.log(`[oauth-app] install complete: ${tokens.stripe_user_id} (merchant ${merchantId}, link=${linkType}, livemode=${tokens.livemode})`);

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${WWW_BASE}/oauth/session?token=${encodeURIComponent(sessionToken)}&next=${encodeURIComponent(WWW_DASHBOARD_URL)}`,
      "Set-Cookie": sessionCookieFor(sessionToken),
    },
  });
}
