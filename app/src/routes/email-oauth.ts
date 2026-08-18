/**
 * Per-merchant email OAuth routes (sender-identity project, Phase 1).
 *
 *   GET    /email/oauth/start?provider=gmail&returnTo=<dashboard path>
 *          — signed-in merchant only (requireSession; unauthenticated → 302 to
 *            the sign-in surface preserving returnTo). Mints a CSRF-safe
 *            one-time state row tied to the merchant (mirrors the oauth
 *            install-state pattern), then 302s to Google's authorize URL with
 *            access_type=offline&prompt=consent (refresh-token grant).
 *            Capability gate: when GOOGLE_OAUTH_CLIENT_ID/SECRET are unset →
 *            503 "email sending not configured" (the production state until
 *            the owner adds creds — clean, no crash). provider=microsoft →
 *            503 until Phase 2.
 *   GET    /email/oauth/callback?code&state&error
 *          — validates + consumes the state row (fail-closed: never exchanges
 *            without a valid one-time state), exchanges the code for tokens at
 *            Google's token endpoint, upserts the encrypted email_connections
 *            row (same AES-256-GCM scheme as Stripe oauth tokens), and 302s
 *            back to returnTo with a ?emailConnected=1 flash. error param or
 *            any failure → 302 to the dashboard with ?emailError=… (no crash).
 *   DELETE /email/connection
 *          — signed-in merchant: revoke (best-effort, failures ignored), delete
 *            the row, 302 to the dashboard.
 *
 * Phase 2 (a later delegation) adds the drawer/settings UI, sender routing and
 * the actual gmail.send — nothing here sends email.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { requireSession } from "../middleware/session";
import { encryptValue, decryptValue, getEncryptionKey } from "../middleware/auth";
import { gmailProvider, providerById, gmailOAuthConfigured, isEmailProviderId } from "../email/providers";

// State rows are valid for 30 minutes (Google's one-time code expires in ~10).
const STATE_TTL_MINUTES = 30;

export interface EmailConnectionRow {
  id: number;
  merchant_id: number;
  provider: string;
  account_email: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string;
  created_at: string;
  updated_at: string;
}

// ── State (CSRF) helpers ──

/** Mint a one-time state row for the authorize hop, tied to the merchant who
 * started it (so the callback stores the connection against the right
 * merchant) and carrying the validated returnTo path. */
export function createEmailOAuthState(db: Database, merchantId: number, provider: string, returnTo: string): string {
  // Opportunistic cleanup of expired rows (also enforced at read).
  db.run("DELETE FROM email_oauth_states WHERE created_at < datetime('now', ?)", [`-${STATE_TTL_MINUTES} minutes`]);
  const state = randomBytes(24).toString("hex");
  db.run("INSERT INTO email_oauth_states (state, merchant_id, provider, return_to) VALUES (?, ?, ?, ?)", [
    state,
    merchantId,
    provider,
    returnTo,
  ]);
  return state;
}

/** Verify + consume a state row (one-time by construction). Returns the
 * merchant it was minted for + the returnTo path, or null when the state is
 * unknown, expired, or already used. */
export function consumeEmailOAuthState(
  db: Database,
  state: string
): { merchant_id: number; provider: string; return_to: string } | null {
  if (!state) return null;
  const row = db
    .query(
      "SELECT merchant_id, provider, return_to FROM email_oauth_states WHERE state = ? AND created_at >= datetime('now', ?)"
    )
    .get(state, `-${STATE_TTL_MINUTES} minutes`) as { merchant_id: number; provider: string; return_to: string } | null;
  if (!row) return null;
  db.run("DELETE FROM email_oauth_states WHERE state = ?", [state]);
  return row;
}

/** A dashboard path only — rejects anything absolute or protocol-relative so
 * the callback can never be an open redirect. */
export function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

// ── Encrypted storage (same scheme as Stripe oauth tokens) ──

/** Upsert an email connection row. Tokens encrypted at rest with
 * encryptValue/decryptValue under TOKEN_ENCRYPTION_KEY — the EXACT helpers
 * stripe_connections / oauth_tokens use (middleware/auth.ts); when the key is
 * unset they degrade to plaintext exactly like Stripe tokens do. */
export function saveEmailConnection(
  db: Database,
  params: {
    merchant_id: number;
    provider: string;
    account_email: string;
    access_token: string;
    refresh_token: string | null;
    token_expires_at: string | null;
    scopes: string;
  }
): void {
  const encKey = getEncryptionKey();
  const accessToken = encryptValue(params.access_token, encKey);
  const refreshToken = encryptValue(params.refresh_token, encKey);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO email_connections
       (merchant_id, provider, account_email, access_token, refresh_token, token_expires_at, scopes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(merchant_id, provider) DO UPDATE SET
       account_email = excluded.account_email,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at`,
    [
      params.merchant_id,
      params.provider,
      params.account_email,
      accessToken,
      refreshToken,
      params.token_expires_at,
      params.scopes,
      now,
    ]
  );
}

/** Read + decrypt a merchant's connection for a provider (null when none). */
export function getEmailConnection(db: Database, merchantId: number, provider: string): EmailConnectionRow | null {
  const row = db
    .query("SELECT * FROM email_connections WHERE merchant_id = ? AND provider = ?")
    .get(merchantId, provider) as EmailConnectionRow | null;
  if (!row) return null;
  const encKey = getEncryptionKey();
  return {
    ...row,
    access_token: decryptValue(row.access_token, encKey) ?? "",
    refresh_token: decryptValue(row.refresh_token, encKey),
  };
}

/** Delete every email connection row for a merchant (all providers). */
export function deleteEmailConnections(db: Database, merchantId: number): void {
  db.run("DELETE FROM email_connections WHERE merchant_id = ?", [merchantId]);
}

/** Best-effort revoke of every stored (decrypted) refresh token — failures are
 * swallowed: revoke is a courtesy to the provider, never a blocker. */
export async function revokeEmailConnections(db: Database, merchantId: number): Promise<void> {
  const rows = db
    .query("SELECT provider, refresh_token FROM email_connections WHERE merchant_id = ?")
    .all(merchantId) as Array<{ provider: string; refresh_token: string | null }>;
  const encKey = getEncryptionKey();
  for (const row of rows) {
    const provider = providerById(row.provider);
    const token = decryptValue(row.refresh_token, encKey);
    if (!provider || !token) continue;
    try {
      await provider.revoke(token);
    } catch (err) {
      console.warn(`[email-oauth] revoke failed for provider ${row.provider}: ${err instanceof Error ? err.message : String(err)} — ignored`);
    }
  }
}

// ── Routes ──

/** GET /email/oauth/start?provider=gmail&returnTo=… */
export async function handleEmailOAuthStart(db: Database, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const providerParam = url.searchParams.get("provider") ?? "gmail";
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));

  // Capability gate: no Google client credentials → clean 503 (no crash). This
  // is the PRODUCTION state until the owner adds the creds.
  if (!isEmailProviderId(providerParam)) {
    return new Response(JSON.stringify({ error: "Unknown email provider." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (providerParam !== "gmail" || !gmailOAuthConfigured()) {
    return new Response(
      JSON.stringify({
        error: "Email sending not configured",
        detail:
          providerParam === "gmail"
            ? "Gmail OAuth is not configured on this server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET unset)."
            : "This email provider is not available yet.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  const provider = providerById(providerParam);
  if (!provider) {
    return new Response(JSON.stringify({ error: "Email sending not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Signed-in merchant only. Unauthenticated → the sign-in surface (the
  // install/sign-in page), preserving returnTo via ?next=.
  const auth = requireSession(db, req);
  if (auth instanceof Response) {
    const origin = url.origin;
    return new Response(null, {
      status: 302,
      headers: { Location: `${origin}/oauth/install?next=${encodeURIComponent(returnTo)}` },
    });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID as string;
  const state = createEmailOAuthState(db, auth.merchant_id, providerParam, returnTo);
  const authorizeUrl = provider.buildAuthorizeUrl({ clientId, state });
  return new Response(null, { status: 302, headers: { Location: authorizeUrl } });
}

export function emailOAuthRedirect(origin: string, returnTo: string, params: Record<string, string>): Response {
  const qs = new URLSearchParams(params).toString();
  // returnTo may already carry its own query (e.g. /dashboard?tab=email) —
  // join the flash params with & in that case, never a second '?'.
  const separator = returnTo.includes("?") ? "&" : "?";
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}${returnTo}${qs ? `${separator}${qs}` : ""}` },
  });
}

/** GET /email/oauth/callback?code&state&error */
export async function handleEmailOAuthCallback(db: Database, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const error = url.searchParams.get("error") ?? "";

  // Explicit denial / provider-side error → back to the dashboard, no crash.
  if (error) {
    console.warn(`[email-oauth] callback error: ${error} — returning to dashboard`);
    return emailOAuthRedirect(origin, "/dashboard", { emailError: `Authorization was not completed (${error}).` });
  }
  // Fail-closed: never exchange a code without a valid one-time state.
  const consumed = consumeEmailOAuthState(db, state);
  if (!consumed) {
    console.warn(`[email-oauth] callback: state missing/invalid/expired (prefix ${state.slice(0, 12)}…) — refusing to exchange`);
    return emailOAuthRedirect(origin, "/dashboard", {
      emailError: "This email connection link is invalid or has expired. Please start again from the dashboard.",
    });
  }
  if (!code) {
    console.warn(`[email-oauth] callback: state OK but no code (prefix ${state.slice(0, 12)}…) — refusing to exchange`);
    return emailOAuthRedirect(origin, "/dashboard", {
      emailError: "The email connection callback was missing the authorization code. Please try again.",
    });
  }
  const { merchant_id: merchantId, provider: providerParam, return_to: returnTo } = consumed;
  const provider = providerById(providerParam);
  if (!provider) {
    return emailOAuthRedirect(origin, "/dashboard", { emailError: "That email provider is not available." });
  }

  const exchanged = await provider.exchangeCode(
    code,
    process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || ""
  );
  if (!exchanged.ok) {
    console.error(`[email-oauth] code exchange failed: ${exchanged.error}`);
    return emailOAuthRedirect(origin, "/dashboard", { emailError: `Could not connect email: ${exchanged.error}` });
  }
  const { tokens } = exchanged;

  // token_expires_at = now + expires_in seconds (Google access tokens ~1h);
  // null when the provider didn't say.
  const tokenExpiresAt = typeof tokens.expires_in === "number" && tokens.expires_in > 0
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  saveEmailConnection(db, {
    merchant_id: merchantId,
    provider: providerParam,
    account_email: tokens.account_email ?? "",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: tokenExpiresAt,
    scopes: tokens.scope ?? "",
  });
  console.log(`[email-oauth] ${providerParam} connection stored for merchant ${merchantId} (email ${tokens.account_email || "unknown"})`);

  return emailOAuthRedirect(origin, returnTo, { emailConnected: "1" });
}

/** DELETE /email/connection — revoke (best-effort), delete the row, back to
 * the dashboard. */
export async function handleEmailConnectionDelete(db: Database, req: Request): Promise<Response> {
  const auth = requireSession(db, req);
  if (auth instanceof Response) return auth;
  await revokeEmailConnections(db, auth.merchant_id);
  deleteEmailConnections(db, auth.merchant_id);
  const origin = new URL(req.url).origin;
  return emailOAuthRedirect(origin, "/dashboard", { emailDisconnected: "1" });
}