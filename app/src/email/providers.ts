/**
 * Sender-identity email providers (per-merchant OAuth).
 *
 * Phase 1 (this change) builds the Gmail PLUMBING only:
 *   - EmailProvider seam (start/callback/send + token refresh) — designed so
 *     Phase 2 adds Microsoft and the real gmail.send without touching the
 *     routes or storage.
 *   - Gmail implementation: authorize-URL construction, code→token exchange,
 *     best-effort revoke.
 *   - Microsoft is deliberately a stub/not-yet (feasibility memo §3) — the
 *     schema (provider column) and this seam are already Morgan-ready for it.
 *
 * OUT OF SCOPE until Phase 2: sender routing (which provider a reminder goes
 * out on), the drawer/settings UI, and any actual gmail.send call. The
 * EmailProvider.send method is DEFINED here so Phase 2 plugs in cleanly, but
 * throws NotSupported until then — nothing in Phase 1 calls it.
 *
 * Scope: https://www.googleapis.com/auth/gmail.send — SENSITIVE (not
 * restricted), no Google security assessment; the minimum scope for send-only
 * apps (memo §2). We never request a read scope, so Google's Limited-Use
 * restrictions never apply.
 *
 * Endpoint override for tests: GOOGLE_OAUTH_API_BASE points BOTH the authorize
 * and token endpoints at a local in-process stub (mirrors how STRIPE_API_BASE
 * stubs Stripe — see test-email-oauth.ts). When unset, the real Google URLs
 * below are used verbatim.
 */

/** EXACT callback constant — must match the Client ID's registered redirect
 * URI in Google Cloud Console and never carry a trailing slash. */
export const GMAIL_REDIRECT_URI = "https://stripe-cc-production.up.railway.app/email/oauth/callback";
/** The minimum send-only scope (sensitive, not restricted — memo §2). */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Env override for endpoint tests (see module doc). Empty in production. */
function googleApiBase(): string {
  return (process.env.GOOGLE_OAUTH_API_BASE || "").replace(/\/+$/, "");
}

export function gmailAuthorizeUrl(): string {
  const b = googleApiBase();
  return b ? `${b}/o/oauth2/v2/auth` : GOOGLE_AUTHORIZE_URL;
}
export function gmailTokenUrl(): string {
  const b = googleApiBase();
  return b ? `${b}/token` : GOOGLE_TOKEN_URL;
}
export function gmailRevokeUrl(): string {
  const b = googleApiBase();
  return b ? `${b}/revoke` : GOOGLE_REVOKE_URL;
}

export type EmailProviderId = "gmail" | "microsoft";

export function isEmailProviderId(value: string): value is EmailProviderId {
  return value === "gmail" || value === "microsoft";
}

/** Token pair a provider exchange returns, plus the extras we persist. */
export interface EmailConnectionTokens {
  access_token: string;
  refresh_token: string | null;
  /** access-token lifetime in seconds (Gmail ~3600). undefined = unknown. */
  expires_in?: number;
  scope?: string;
  /** Best-effort mailbox address. Gmail's token response may carry `email` in
   *  tests/workspace setups; empty string when not present (Phase 1 stores
   *  what it can; the Phase-2 send path can resolve it precisely). */
  account_email?: string;
}

/** The provider seam. Phase 1 implements Gmail; Microsoft is a stub. `send` is
 * part of the interface so Phase 2 adds both providers' send paths without
 * changing the seam, but throws NotSupported until implemented — nothing in
 * Phase 1 calls it. */
export interface EmailProvider {
  readonly id: EmailProviderId;
  /** Client-id + CSRF state → provider authorize URL. Pure, no I/O. */
  buildAuthorizeUrl(params: { clientId: string; state: string }): string;
  /** Exchange an authorization code for tokens at the provider's token
   * endpoint. Never throws — returns {ok:false, error} on any failure. */
  exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string
  ): Promise<{ ok: true; tokens: EmailConnectionTokens } | { ok: false; error: string }>;
  /** Best-effort token revocation (disconnect). Failures are swallowed by the
   * caller — revoke is a courtesy, never a blocker. */
  revoke(token: string): Promise<void>;
  /** Refresh an access token from a refresh token. Gmail: refresh tokens are
   * long-lived + non-rotating, access tokens ~1h. NOT used in Phase 1 (no send
   * path yet) — part of the seam for Phase 2. */
  refreshToken?(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<{ ok: true; tokens: EmailConnectionTokens } | { ok: false; error: string }>;
  /** Send an email as the connected user — Phase 2. Throws until implemented. */
  send(..._args: unknown[]): Promise<never>;
}

/** Gmail provider (web-server OAuth flow, memo §2). */
export const gmailProvider: EmailProvider = {
  id: "gmail",

  buildAuthorizeUrl({ clientId, state }): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: GMAIL_REDIRECT_URI,
      response_type: "code",
      scope: GMAIL_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${gmailAuthorizeUrl()}?${params.toString()}`;
  },

  async exchangeCode(code, clientId, clientSecret) {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: GMAIL_REDIRECT_URI,
      grant_type: "authorization_code",
    });
    const res = await fetch(gmailTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const raw: unknown = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).access_token !== "string") {
      const d = (raw ?? {}) as Record<string, unknown>;
      const detail = String(d.error_description ?? d.error ?? `unexpected response (HTTP ${res.status})`);
      return { ok: false, error: `Google token exchange failed: ${detail}` };
    }
    const t = raw as Record<string, unknown>;
    return {
      ok: true,
      tokens: {
        access_token: String(t.access_token),
        refresh_token: typeof t.refresh_token === "string" && t.refresh_token ? t.refresh_token : null,
        expires_in: typeof t.expires_in === "number" ? t.expires_in : undefined,
        scope: typeof t.scope === "string" ? t.scope : GMAIL_SCOPE,
        account_email: typeof t.email === "string" ? t.email : "",
      },
    };
  },

  async revoke(token) {
    const body = new URLSearchParams({ token });
    await fetch(gmailRevokeUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  },

  send(): Promise<never> {
    return Promise.reject(new Error("gmail.send is Phase 2 — sender routing is not implemented yet."));
  },
};

/**
 * Microsoft (Outlook/M365, delegated Mail.Send — memo §3) is Phase 2. The
 * object exists so providerById has a typed home for it and the seam is
 * demonstrably Morgan-ready; every method degrades cleanly instead of
 * crashing. Route-level gating (routes/email-oauth.ts) returns 503 "not yet
 * available" for provider=microsoft before any of these are reached.
 */
export const microsoftProvider: EmailProvider = {
  id: "microsoft",
  buildAuthorizeUrl(): string {
    throw new Error("Microsoft email OAuth is not yet available (Phase 2).");
  },
  async exchangeCode() {
    return { ok: false, error: "Microsoft email OAuth is not yet available (Phase 2)." };
  },
  async revoke() {
    // no-op — nothing to revoke until Phase 2
  },
  send(): Promise<never> {
    return Promise.reject(new Error("Microsoft send is Phase 2 — not implemented yet."));
  },
};

/** Resolve a supported provider by id. Phase 1: only 'gmail' is usable;
 * 'microsoft' returns null (route answers 503) so nothing in the plumbing
 * ever touches the not-yet implementation. */
export function providerById(id: string): EmailProvider | null {
  if (id === "gmail") return gmailProvider;
  return null;
}

/** Whether the Google OAuth client credentials are configured. This is the
 * Phase-1 capability gate: /email/oauth/start answers 503 when false (the
 * production state until the owner adds creds — no crash, clean error). */
export function gmailOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}