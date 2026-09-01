/**
 * Stripe Apps OAuth v2 install flow (marketplace install).
 *
 * The Stripe App Marketplace installs Collections Copilot through Stripe's
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
 *                                      .com/oauth/v2/authorize
 *                                      ?client_id=…&redirect_uri=…&state=…
 *                                      (the OFFICIAL public format — post-
 *                                      approval; when STRIPE_APP_CHNLINK is
 *                                      set for internal QA the older
 *                                      chnlink_{TOKEN} testing-channel format
 *                                      is emitted instead — see the NOTE below)
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
 * Env: STRIPE_APP_TEST_CLIENT_ID / STRIPE_APP_LIVE_CLIENT_ID (per-mode app
 * client ids, ca_…; STRIPE_CLIENT_ID is the legacy default fallback),
 * STRIPE_APP_TEST_KEY / STRIPE_APP_LIVE_KEY (app developer API keys), and
 * STRIPE_APP_CHNLINK — the app's External-Testing channel-link token
 * (chnlink_…), retained ONLY as an internal-QA switch between the two
 * authorize formats (see the NOTE below).
 *
 * PUBLISHED → LIVE-ONLY PAGE (2026-08-18): the app is APPROVED and the
 * marketplace install URL is the PUBLIC Live-mode surface — a real merchant
 * landing from the listing must only ever be offered Live mode.
 * STRIPE_APP_ENABLE_TEST_INSTALL is the internal-QA gate (STRIPE_APP_CHNLINK
 * convention): when it is NOT exactly "1", the /oauth/install page renders as
 * if test mode does not exist — the "Connect with Stripe — test mode" button
 * AND every test-mode notice are suppressed even when
 * STRIPE_APP_TEST_CLIENT_ID + STRIPE_APP_TEST_KEY are configured, and only
 * the live-mode button (or its normal missing-creds notice) renders. When it
 * IS "1" the page renders both modes per configuredModes exactly as before
 * (dev/QA only). The gate is RENDERING-only: /oauth/install/start?link=test,
 * the ?auto=1 chain, buildAuthorizeUrl, appClientIdFor and missingEnvFor are
 * untouched, so internal QA can still drive test-mode installs via the
 * explicit ?link=test URL. The var must stay unset in production.
 * The authorize URL is built in buildAuthorizeUrl. The PUBLIC format
 * (…/oauth/v2/authorize?client_id=…&redirect_uri=…&state=…) is the OFFICIAL
 * Live-mode install URL — the reviewer-required shape (round 2026-08-15) and
 * what the published listing serves. The mode is selected by the client_id +
 * the link type carried inside `state` (the same URL shape serves both modes).
 * NOTE (2026-08-18): the app is APPROVED (v0.1.21) — the public format works
 * for real installs now. STRIPE_APP_CHNLINK is KEPT ONLY as an internal QA
 * switch: when set, buildAuthorizeUrl emits the External-Testing channel URL
 * (…/oauth/v2/chnlink_{TOKEN}/authorize, one token per app; mode via
 * client_id + state) — the ONLY working path while the app was UNPUBLISHED
 * (Stripe rejects the public link pre-approval: "The provided OAuth link is
 * invalid", re-proven on the live install 8/17). It is REMOVED from the
 * production environment (reviewer fix #4: no test-mode channel parameters
 * ship in the production install flow) and should never be re-added there —
 * set it only in dev/QA environments to exercise the testing channel.
 * For LIVE links the developer key falls back to STRIPE_SECRET_KEY when
 * STRIPE_APP_LIVE_KEY is unset — per Stripe's OAuth docs the app developer
 * key for a live-mode install IS the developer account's own live secret key
 * (their curl example authenticates with `-u sk_live_***:`). Test mode is
 * unchanged: STRIPE_APP_TEST_KEY is still required (STRIPE_SECRET_KEY is a
 * live key and must never be reused for test links).
 * Everything degrades to a clear error page — never a crash — when unset.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { ensureDefaultMerchant, isMerchantDisconnected, upsertInvoice } from "../db";
import { encryptValue, decryptValue, getEncryptionKey, getStripeConnectionFor } from "../middleware/auth";
import { saveStripeConnection } from "../middleware/auth";
import { sessionCookieFor, WWW_BASE, WWW_DASHBOARD_URL } from "./oauth";
import { accountFromCookie } from "./accounts";

// ── Constants ──
// The marketplace authorize endpoint's OFFICIAL (post-approval) format is the
// PUBLIC URL: https://marketplace.stripe.com/oauth/v2/authorize
// ?client_id=…&redirect_uri=…&state=… (built in buildAuthorizeUrl — see the
// IMPORTANT note there). When STRIPE_APP_CHNLINK is set the builder emits the
// older External-Testing channel format (…/oauth/v2/chnlink_{TOKEN}/authorize)
// instead — an internal-QA switch; the var must stay unset in production
// (reviewer fix #4).
// Same env-override convention as routes/billing.ts: endpoint tests point
// STRIPE_API_BASE at a local stub (e.g. http://localhost:3199/v1).
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, "");

/** BASE_URL (or the localhost dev default), normalized to never carry a
 * trailing slash. The OAuth redirect_uri must be BYTE-IDENTICAL to the
 * manifest's allowed_redirect_uris entry and to whatever is registered in
 * Stripe App Settings — a stray trailing "/" breaks the match and Stripe
 * rejects the authorize request. Every redirect_uri/redirect target in this
 * module is built from this value. */
export function baseUrlFor(): string {
  return (process.env.BASE_URL || "http://localhost:3002").replace(/\/+$/, "");
}
// State rows are valid for 30 minutes (the one-time code itself expires in 5).
const STATE_TTL_MINUTES = 30;
const LINK_TYPES = ["test", "live"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export function isLinkType(value: string): value is LinkType {
  return value === "test" || value === "live";
}

// ── visitor_id (visitor→merchant tracing, owner 8/25) ──
// The landing page's tracking snippet keeps a per-browser UUID in localStorage
// `cc_vid` and the install CTAs append it as ?cc_vid=<id> (see site/__root.tsx).
// This module sanitizes it exactly like routes/track.ts treats visitor_id
// (trim; a value over 128 chars is invalid) so the value stored on the
// merchant row matches a page_visits.visitor_id row byte-for-byte — the admin
// dashboard's /admin/data join depends on that. A missing/blank/overlong value
// is a graceful no-op (empty string) — it never breaks an install.
const VISITOR_ID_MAX = 128;
export function sanitizeVisitorId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  return v.length > VISITOR_ID_MAX ? "" : v;
}

/** App developer API key matching the link type (docs: use the key that
 * matches the link type — test links only work with test-mode keys). For
 * live links the key falls back to STRIPE_SECRET_KEY when STRIPE_APP_LIVE_KEY
 * is unset: per Stripe's OAuth docs the app developer key for a live-mode
 * install IS the developer account's own live secret key. */
export function appDevKeyFor(linkType: LinkType): string | null {
  return linkType === "live"
    ? (process.env.STRIPE_APP_LIVE_KEY ?? process.env.STRIPE_SECRET_KEY ?? null)
    : (process.env.STRIPE_APP_TEST_KEY ?? null);
}

/** App client id (ca_…) matching the link type. Test and live marketplace
 * install links carry DIFFERENT client ids, so the mode-specific env wins;
 * STRIPE_CLIENT_ID is the legacy live/default fallback when unset. */
export function appClientIdFor(linkType: LinkType): string | null {
  const modeClientId =
    linkType === "live" ? process.env.STRIPE_APP_LIVE_CLIENT_ID : process.env.STRIPE_APP_TEST_CLIENT_ID;
  return modeClientId ?? process.env.STRIPE_CLIENT_ID ?? null;
}

/** The app's External-Testing channel-link token (chnlink_…), retained as an
 * INTERNAL-QA switch: when set, buildAuthorizeUrl emits the testing-channel
 * URL (marketplace.stripe.com/oauth/v2/chnlink_{TOKEN}/authorize — the ONLY
 * working install path while the app was UNPUBLISHED; mode is selected by the
 * client_id). The PUBLIC format (no chnlink) is the official post-approval
 * shape and the production default — the var MUST stay unset in production
 * (reviewer fix #4); set it only in dev/QA environments to exercise the
 * testing channel. */
export function appChnlink(): string | null {
  return process.env.STRIPE_APP_CHNLINK ?? null;
}

/** Env vars still missing for a link type to be installable (client id slot,
 * then developer key). The install page's per-mode notices render this; when
 * appClientIdFor resolves through the STRIPE_CLIENT_ID fallback the mode
 * var is not reported. For LIVE mode, STRIPE_SECRET_KEY satisfies the
 * developer-key slot (the appDevKeyFor fallback), so the key entry appears
 * only when BOTH STRIPE_APP_LIVE_KEY and STRIPE_SECRET_KEY are unset, and it
 * reads "set STRIPE_APP_LIVE_KEY or STRIPE_SECRET_KEY".
 * STRIPE_APP_CHNLINK is deliberately NOT listed here: it is an internal-QA
 * switch, never a gate — the page renders a mode's button whether or not it
 * is set, and buildAuthorizeUrl emits the official PUBLIC format when unset
 * (the production default since the app was approved; reviewer fix #4). See
 * appChnlink() + buildAuthorizeUrl. */
export function missingEnvFor(linkType: LinkType): string[] {
  const missing: string[] = [];
  if (!appClientIdFor(linkType)) {
    missing.push(linkType === "live" ? "STRIPE_APP_LIVE_CLIENT_ID" : "STRIPE_APP_TEST_CLIENT_ID");
  }
  if (!appDevKeyFor(linkType)) {
    missing.push(
      linkType === "live"
        ? "STRIPE_APP_LIVE_KEY or STRIPE_SECRET_KEY"
        : "STRIPE_APP_TEST_KEY"
    );
  }
  return missing;
}

// ── CSRF-safe state ──
// State = "<random-hex>:<link-type>". The DB row is authoritative for the link
// type (never trust a parsed suffix); rows are one-time (deleted on consume)
// and expire after STATE_TTL_MINUTES. Since the account layer (migration 017)
// the row also records WHICH platform account started the install
// (account_id, nullable for legacy rows) — the callback reads it back to link
// the created merchant to the account (account → merchant → subscription).
export function createInstallState(db: Database, linkType: LinkType, accountId: number | null = null, visitorId = ""): string {
  // Opportunistic cleanup of expired rows (also enforced at read).
  db.run("DELETE FROM oauth_install_states WHERE created_at < datetime('now', ?)", [`-${STATE_TTL_MINUTES} minutes`]);
  const state = `${randomBytes(24).toString("hex")}:${linkType}`;
  db.run(
    "INSERT INTO oauth_install_states (state, link_type, account_id, visitor_id) VALUES (?, ?, ?, ?)",
    [state, linkType, accountId, visitorId]
  );
  return state;
}

/** Verify + consume a state row. Returns the link type, the account that
 * started the install (null for legacy/back-compat rows), and the landing-page
 * visitor_id carried through the flow ("" when none — see createInstallState),
 * or null when the state is unknown, expired, or already used. One-time by
 * construction. */
export function consumeInstallState(
  db: Database,
  state: string
): { link_type: LinkType; account_id: number | null; visitor_id: string } | null {
  if (!state) return null;
  const row = db
    .query(
      "SELECT link_type, account_id, visitor_id FROM oauth_install_states WHERE state = ? AND created_at >= datetime('now', ?)"
    )
    .get(state, `-${STATE_TTL_MINUTES} minutes`) as {
      link_type: LinkType;
      account_id: number | null;
      visitor_id: string | null;
    } | null;
  if (!row) return null;
  db.run("DELETE FROM oauth_install_states WHERE state = ?", [state]);
  return {
    link_type: row.link_type,
    account_id: row.account_id ?? null,
    visitor_id: row.visitor_id || "",
  };
}

// ── Authorize URL ──
// Matches the Stripe Apps OAuth v2 flow (docs.stripe.com/
// stripe-apps/api-authentication/oauth): the marketplace authorize URL takes
// client_id + redirect_uri + state. There is NO `scope` query parameter in
// the docs' flow — the scope is implied by the app (the token response
// returns `scope: "stripe_apps"`), so adding one would be wrong. `state`
// doubles as the link-type carrier (docs: "pass the relevant link type within
// the state parameter") and is echoed back by Stripe on the callback.
// POST-APPROVAL (2026-08-18, reviewer fix #4): the app is APPROVED (v0.1.21)
// and the OFFICIAL install URL is the PUBLIC format below — no chnlink path
// segment, no test-mode channel parameters. STRIPE_APP_CHNLINK is retained
// ONLY as an internal-QA switch: when set, the URL is
// …/oauth/v2/chnlink_{TOKEN}/authorize (the External-Testing channel link
// that was the ONLY working install path pre-approval); when unset (the
// production default), the public …/oauth/v2/authorize format is emitted.
// The mode is selected by client_id + state in both cases. A leading
// "chnlink_" prefix on the env value (the exact path token from App
// Settings) is tolerated and normalized, so the produced URL always carries
// exactly one "chnlink_…" segment. Never a malformed link: when the client
// id is missing a clear error is returned.
export function buildAuthorizeUrl(state: string, linkType: LinkType): { url: string } | { error: string } {
  const clientId = appClientIdFor(linkType);
  const baseUrl = baseUrlFor();
  const redirectUri = (process.env.STRIPE_APP_REDIRECT_URI || `${baseUrl}/oauth/callback`).replace(/\/+$/, "");
  if (!clientId) {
    const modeEnv = linkType === "live" ? "STRIPE_APP_LIVE_CLIENT_ID" : "STRIPE_APP_TEST_CLIENT_ID";
    return { error: `Neither ${modeEnv} nor the default STRIPE_CLIENT_ID is set — the ${linkType}-mode app install link cannot be built. Set the app's ${linkType}-mode client id (ca_…) in the Stripe dashboard.` };
  }
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
  const chnlink = appChnlink();
  if (chnlink) {
    // Internal QA only: the chnlink (External-Testing) path segment. Normalize:
    // tolerate the env value carrying the "chnlink_" prefix (as it appears in
    // App Settings) so we never emit a doubled prefix. Never set in production.
    const token = chnlink.replace(/^chnlink_/, "");
    return { url: `https://marketplace.stripe.com/oauth/v2/chnlink_${token}/authorize?${params.toString()}` };
  }
  // STRIPE_APP_CHNLINK unset → the OFFICIAL PUBLIC format
  // (docs.stripe.com/stripe-apps/api-authentication/oauth#publish-app) — the
  // Live-mode install URL the published listing serves (reviewer fix #4).
  return { url: `https://marketplace.stripe.com/oauth/v2/authorize?${params.toString()}` };
}

// Minimal branded install page ──
// The reviewer required the marketplace install URL to be a page that
// initiates onboarding with clear instructions using OAuth install links — not
// a bare redirect. Since the account layer (owner decision 8/13, reviewer
// round-2) the page is GATED on a platform sign-in: without a valid cc_account
// cookie it renders the "sign in / create account" card (email input → POST
// /api/account/request-magic-link → one-time link); with one it renders the
// "Connect with Stripe" buttons per configured mode (a mode is installable
// when its client id and developer key resolve), plus "Signed in as {email} ·
// sign out" and — when the account already owns a connected merchant — an
// "open your dashboard" link. STRIPE_APP_CHNLINK plays NO role here: since
// approval the public format is the official install link (reviewer fix #4),
// so there is no advisory and no chnlink mention on the page.
//
// PUBLISHED → LIVE-ONLY (2026-08-18): the app is APPROVED and the marketplace
// install page is the PUBLIC Live-mode surface, so test mode must never be
// offered to a real merchant. STRIPE_APP_ENABLE_TEST_INSTALL is the
// internal-QA gate (same convention as STRIPE_APP_CHNLINK): when it is NOT
// exactly "1" the page renders as if test mode does not exist — the test-mode
// button AND every test-mode notice are suppressed even when
// STRIPE_APP_TEST_CLIENT_ID + STRIPE_APP_TEST_KEY are configured, and only
// the live-mode button (or its normal missing-creds notice) renders. When it
// IS "1" the page renders both modes per configuredModes exactly as before
// (dev/QA only). RENDERING-ONLY: /oauth/install/start?link=test, the ?auto=1
// chain, buildAuthorizeUrl, appClientIdFor and missingEnvFor are untouched,
// so internal QA can still drive test-mode installs via the explicit
// ?link=test URL. The var must stay unset in production.
//
// NO-JS SIGN-IN (2026-08-18, review blocker): the sign-in card is a REAL form
// (method=post action=/api/account/request-magic-link) that POSTs natively
// when the inline script cannot run — the Stripe review sandbox renders this
// page in an iframe where inline <script> does NOT execute, so the previous
// fetch-only card did nothing there (no request, no email, no error). The
// endpoint answers the urlencoded form POST with a 302 back to
// /oauth/install?sent=1 (success) or /oauth/install?error=<msg> (invalid /
// rate-limited); this GET handler renders those as server-side banners
// (green in place of the form / red above the form) with zero JavaScript.
// A <noscript> block and an in-iframe hint (window.self !== window.top, shown
// only when JS DOES run) give the reviewer escape hatches. The JS fetch
// enhancement (spinner/timeout/inline status) is unchanged when scripts run.
export function installPageHtml(
  baseUrl: string,
  configuredModes: LinkType[],
  missingEnv: Record<LinkType, string[]>,
  account?: { email: string } | null,
  dashboardUrl?: string | null,
  notice?: { kind: "success" | "error"; message: string } | null,
  visitorId = ""
): string {
  // HTML-escape for any server-rendered user-visible text (error banner).
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // The landing-page visitor_id (?cc_vid=…) rides every hop that continues the
  // install flow so the /oauth/callback can stamp the created merchant (the
  // state row carries it; see createInstallState). encodeURIComponent keeps the
  // query clean even for an arbitrary-string visitor_id. No-op when absent.
  const visitorQuery = visitorId ? `&cc_vid=${encodeURIComponent(visitorId)}` : "";
  const buttonFor = (linkType: LinkType, label: string) =>
    `<a href="${baseUrl}/oauth/install/start?link=${linkType}${visitorQuery}" style="display:block;background:#635BFF;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:8px;margin:10px 0;text-align:center;">${label}</a>`;

  // PUBLISHED → LIVE-ONLY RENDER GATE (2026-08-18): the app is APPROVED and
  // this page is the PUBLIC marketplace install surface, so test mode must
  // never be offered to a real merchant. STRIPE_APP_ENABLE_TEST_INSTALL is
  // the internal-QA switch (STRIPE_APP_CHNLINK convention): when it is NOT
  // exactly "1" the page renders as if test mode does not exist — the test
  // button and EVERY test-mode notice are suppressed even when
  // STRIPE_APP_TEST_CLIENT_ID + STRIPE_APP_TEST_KEY are configured — and only
  // the live-mode button (or its normal missing-creds notice) renders. When
  // it IS "1" the page renders both modes per configuredModes exactly as
  // before (dev/QA only). RENDERING-ONLY: the /oauth/install/start?link=test
  // path, ?auto=1, buildAuthorizeUrl, appClientIdFor and missingEnvFor are
  // untouched, so internal QA can still drive test-mode installs via the
  // explicit ?link=test URL. The var must stay unset in production.
  const testInstallEnabled = process.env.STRIPE_APP_ENABLE_TEST_INSTALL === "1";
  const renderModes: LinkType[] = testInstallEnabled ? [...LINK_TYPES] : ["live"];
  // The modes that are BOTH configured by env AND eligible to render on this
  // page — the live-only gate strips "test" out of configuredModes when the
  // flag is off, so a test-only-configured server falls into the "not
  // configured" branch and shows only the live-mode notice.
  const shownModes = configuredModes.filter((lt) => renderModes.includes(lt));

  // Human text for a mode's missing env vars, e.g. "<code>STRIPE_APP_TEST_CLIENT_ID</code>
  // (or the default <code>STRIPE_CLIENT_ID</code>) and <code>STRIPE_APP_TEST_KEY</code>".
  // The live key slot reads "set <code>STRIPE_APP_LIVE_KEY</code> or
  // <code>STRIPE_SECRET_KEY</code>" (the STRIPE_SECRET_KEY fallback).
  const missingTextFor = (linkType: LinkType): string =>
    missingEnv[linkType]
      .map((env) => {
        if (env === "STRIPE_APP_LIVE_KEY or STRIPE_SECRET_KEY") {
          return `<code>STRIPE_APP_LIVE_KEY</code> or <code>STRIPE_SECRET_KEY</code>`;
        }
        return env.endsWith("_CLIENT_ID")
          ? `<code>${env}</code> (or the default <code>STRIPE_CLIENT_ID</code>)`
          : `<code>${env}</code>`;
      })
      .join(" and ");

  let body: string;
  if (!account) {
    // ── Signed-out state: sign in / create account card ──
    // The reviewer's flow: marketplace → listing → Install → user logs in or
    // signs up on our platform → connect Stripe → install → sync → subscribe.
    // One email input serves both (first-time = signup, same endpoint); the
    // endpoint ALWAYS 200s so account existence is never leaked. The card is a
    // REAL form (method=post action=…) so it works with NO JavaScript — the
    // Stripe review sandbox renders this page in an iframe where the inline
    // <script> does NOT execute (the previous fetch-only card then did
    // nothing: no request, no email, no console error). Native submission
    // POSTs email=… urlencoded to /api/account/request-magic-link, which 302s
    // back here with ?sent=1 / ?error=<msg> — the GET handler renders those as
    // server-side banners. When JS DOES run, the submit handler below calls
    // e.preventDefault() and the fetch path is unchanged (spinner, 15s
    // timeout, inline status). A <noscript> block and an iframe hint
    // (window.self !== window.top) give the reviewer escape hatches.
    const installUrl = `${baseUrl}/oauth/install${visitorId ? `?cc_vid=${encodeURIComponent(visitorId)}` : ""}`;
    const successBanner = `<p style="color:#047857;background:#ECFDF5;border:1px solid #6EE7B7;border-radius:8px;padding:14px 16px;font-size:14px;margin:0 0 12px;">Check your inbox — your sign-in link is on its way.</p>`;
    const errorBanner =
      notice?.kind === "error"
        ? `<p style="color:#B91C1C;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 16px;font-size:14px;margin:0 0 12px;">${esc(notice.message)}</p>`
        : "";
    const supportLine = `<p style="color:#9CA3AF;font-size:12px;margin:16px 0 0;">Questions? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>`;
    // The landing-page visitor_id rides the sign-in form as a hidden field so
    // the request-magic-link post (JSON or bare form) can fold it into the
    // verify-link's ?next= and the visitor is still attributed after signing
    // in (see routes/accounts.ts). HTML-escaped (it is stored and echoed into
    // an email URL) — no-op when absent.
    const visitorHidden = visitorId ? `<input type="hidden" name="cc_vid" value="${esc(visitorId)}" />` : "";

    if (notice?.kind === "success") {
      // ?sent=1 — the no-JS form POST succeeded: green banner IN PLACE OF the
      // form (nothing left to submit, so the input/status/script are gone).
      body = `${successBanner}${supportLine}`;
    } else {
      body = `<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 18px;">Sign in to install Collections Copilot. We'll email you a one-time sign-in link — no password needed.</p>
      ${errorBanner}
      <form id="magic-link-form" method="post" action="/api/account/request-magic-link" style="margin:0 0 12px;">
        <input type="email" id="magic-email" name="email" required placeholder="you@company.com" autocomplete="email" style="display:block;width:100%;box-sizing:border-box;padding:12px 14px;font-size:15px;border:1px solid #D1D5DB;border-radius:8px;margin-bottom:12px;" />
        ${visitorHidden}
        <button type="submit" style="display:block;width:100%;background:#635BFF;color:#fff;border:0;font-weight:600;font-size:16px;padding:14px 24px;border-radius:8px;cursor:pointer;">Email me a sign-in link</button>
      </form>
      <p id="magic-link-status" style="font-size:14px;margin:10px 0 0;min-height:20px;"></p>
      <noscript>
        <p style="color:#B45309;background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:10px 14px;font-size:13px;margin:12px 0 0;">This page needs JavaScript to sign in — open it in a new tab to continue: <a href="/oauth/install" style="color:#92400E;">Sign in page</a>. If the button does nothing, open this page in a new tab.</p>
      </noscript>
      ${supportLine}
      <script>
        // NOTE: the status element is held in statusEl, NOT status — the
        // bare name status collides with the legacy window.status accessor
        // in some Chrome builds (typeof status === 'string' there), which
        // made status.style.color = ... throw and killed the fetch before
        // it fired. Renamed to keep the JS path working everywhere.
        var form = document.getElementById('magic-link-form');
        var statusEl = document.getElementById('magic-link-status');
        // Sandboxed-iframe escape hatch (Stripe review sandbox): this page can
        // be rendered in an iframe where inline scripts don't run — the native
        // form POST covers that. When scripts DO run but the page is framed,
        // show a hint to open it in its own tab (some sandboxes also block
        // form submission, so the button may still do nothing here).
        if (form && window.self !== window.top) {
          var hint = document.createElement('p');
          hint.setAttribute('style', 'font-size:12px;color:#9CA3AF;margin:14px 0 0;');
          hint.innerHTML = 'If the button does nothing, open this page in a new tab: <a href="${installUrl}" target="_blank" rel="noopener" style="color:#6B7280;">Open sign-in page</a>';
          form.insertAdjacentHTML('afterend', hint.outerHTML);
        }
        if (form) form.addEventListener('submit', function (e) {
          e.preventDefault();
          var email = (document.getElementById('magic-email').value || '').trim();
          var btn = form.querySelector('button');
          var input = document.getElementById('magic-email');
          var original = btn.textContent;
          // Visible loading state: spinner + button label swap + fields locked.
          btn.disabled = true;
          btn.textContent = 'Sending…';
          if (input) input.disabled = true;
          statusEl.innerHTML = '<span class="spinner"></span>Sending your sign-in link…';
          statusEl.style.color = '#6B7280';
          var done = function (message, color) {
            statusEl.innerHTML = '';
            statusEl.textContent = message;
            statusEl.style.color = color;
            btn.textContent = original;
          };
          // First completion wins — a 15s timeout, a response, or an error.
          // Without the timeout, a fetch that never resolves or rejects (e.g.
          // the server was mid-restart when the form was submitted) would leave
          // the button stuck on "Sending…" and the spinner running forever.
          var settled = false;
          var timeoutId = setTimeout(function () {
            if (settled) return;
            settled = true;
            btn.disabled = false;
            if (input) input.disabled = false;
            done('This is taking longer than usual — check your inbox, or try again.', '#B45309');
          }, 15000);
          var finish = function (message, color, reenable) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            done(message, color);
            if (reenable) {
              btn.disabled = false;
              if (input) input.disabled = false;
            }
          };
          fetch('/api/account/request-magic-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, cc_vid: ${JSON.stringify(visitorId)} })
          }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
          }).then(function (r) {
            if (r.res.ok) {
              finish('Check your inbox — your sign-in link is on its way.', '#047857', false);
            } else {
              finish((r.data && r.data.error) ? r.data.error : 'Something went wrong — please try again.', '#B91C1C', true);
            }
          }).catch(function () {
            finish('Something went wrong — please try again.', '#B91C1C', true);
          });
        });
      </script>`;
    }
  } else {
    const accountLine = `<p style="color:#6B7280;font-size:13px;margin:0 0 16px;">Signed in as <strong style="color:#374151;">${esc(account.email)}</strong> · <a href="#" onclick="fetch('/api/account/logout',{method:'POST'}).then(function(){window.location.href='/oauth/install';});return false;" style="color:#6B7280;">sign out</a></p>`;
    const connectedLine = dashboardUrl
      ? `<p style="color:#047857;font-size:13px;margin:0 0 14px;">✅ You're connected — <a href="${dashboardUrl}" style="color:#047857;font-weight:600;">open your dashboard</a></p>`
      : "";
    if (shownModes.length === 0) {
      const perMode = renderModes.map((lt) => {
        const envs = missingEnv[lt];
        if (envs.length === 0) return "";
        return `<br>${lt === "test" ? "Test" : "Live"} mode: set ${missingTextFor(lt)}`;
      }).join("");
      body = `${accountLine}${connectedLine}<p style="color:#B45309;background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 16px;font-size:14px;"><strong>Installation is not configured yet.</strong>${perMode} Once set, this page will show a "Connect with Stripe" button. No action is needed on your side.</p>`;
    } else {
      body = `${accountLine}${connectedLine}<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 18px;">Connect your Stripe account to let Collections Copilot watch for overdue invoices and send your customers friendly, automatic payment reminders.</p>
        <ol style="color:#4B5563;font-size:14px;line-height:1.8;margin:0 0 22px;padding-left:20px;text-align:left;">
          <li>Click <strong>Connect with Stripe</strong> below — you'll be taken to Stripe's authorization screen.</li>
          <li>Review the permissions and approve the connection.</li>
          <li>You'll land in your Collections Copilot dashboard, ready to configure reminders.</li>
        </ol>
        ${shownModes.includes("test") ? buttonFor("test", "Connect with Stripe — test mode") : ""}
        ${shownModes.includes("live") ? buttonFor("live", "Connect with Stripe — live mode") : ""}
        ${
          renderModes
            .filter((lt) => !shownModes.includes(lt) && missingEnv[lt].length > 0)
            .map((lt) => `<p style="color:#9CA3AF;font-size:12px;margin:12px 0 0;">${lt === "test" ? "Test" : "Live"} mode is not available yet — set ${missingTextFor(lt)}.</p>`)
            .join("")
        }
        <p style="color:#9CA3AF;font-size:12px;margin:16px 0 0;">Questions? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install Collections Copilot — Connect Stripe</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F3F4F6; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 40px 44px; max-width: 480px; width: 100%; box-sizing: border-box; text-align: center; }
    .logo { font-size: 22px; font-weight: 700; color: #1F2937; margin-bottom: 6px; }
    .logo span { color: #635BFF; }
    h1 { font-size: 24px; margin: 14px 0 10px; color: #111827; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #C7C7C7; border-top-color: #635BFF; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Collections<span>Copilot</span></div>
    <h1>Install Collections Copilot</h1>
    ${body}
  </div>
</body>
</html>`;
}

/** GET /oauth/install — the marketplace install page. Account-gated since the
 * account layer (reviewer round-2): no valid cc_account cookie → the sign-in /
 * create-account card; valid → the Connect buttons + signed-in line. ?auto=1
 * skips the page and 302s straight into the authorize flow (useful for
 * programmatic links and tests — /oauth/install/start still enforces the
 * cookie); the default link type is LIVE (the production install mode —
 * reviewer fix #4), overridable with ?link=test|live. ?sent=1 / ?error=<msg>
 * (signed-out only) render the no-JS form POST's outcome as server-side
 * banners — the sign-in card is a real method=post form (the Stripe review
 * sandbox iframe blocks the inline script), and
 * /api/account/request-magic-link 302s back here with those params.
 * PUBLISHED → LIVE-ONLY: the RENDERED page is gated by
 * STRIPE_APP_ENABLE_TEST_INSTALL (installPageHtml applies the filter — when
 * the flag is not "1" the test-mode button and notices never render); the
 * per-mode configuration computed here is the TRUE env state, and
 * /oauth/install/start?link=test stays reachable for internal QA. */
export function handleAppInstallPage(db: Database, req: Request): Response {
  ensureDefaultMerchant(db);
  const baseUrl = baseUrlFor();
  // A mode is installable only when NOTHING is missing for it: its client id
  // (mode var, or the STRIPE_CLIENT_ID fallback) and its developer key (live
  // falls back to STRIPE_SECRET_KEY). missingEnvFor encodes both, so a mode
  // is configured iff its missing list is empty. STRIPE_APP_CHNLINK plays no
  // role on the page (internal-QA switch only — since approval the public
  // format is the official install link; reviewer fix #4).
  const configuredModes: LinkType[] = LINK_TYPES.filter((lt) => missingEnvFor(lt).length === 0);
  const missingEnv: Record<LinkType, string[]> = { test: missingEnvFor("test"), live: missingEnvFor("live") };

  const url = new URL(req.url);
  // The landing-page visitor_id the install CTA carried in (?cc_vid=…). It
  // travels every subsequent hop — Connect button → install/start → state row
  // → callback merchant stamp (see sanitizeVisitorId / createInstallState) so
  // /admin/data can trace this merchant back to its source page visit. A
  // missing/blank/overlong value is a graceful no-op (empty → nothing is
  // appended and the flow is byte-identical to before).
  const visitorId = sanitizeVisitorId(url.searchParams.get("cc_vid"));
  if (url.searchParams.get("auto") === "1") {
    const link = isLinkType(url.searchParams.get("link") ?? "") ? url.searchParams.get("link")! : "live";
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseUrl}/oauth/install/start?link=${link}${visitorId ? `&cc_vid=${encodeURIComponent(visitorId)}` : ""}`,
      },
    });
  }

  const account = accountFromCookie(db, req);
  // ── No-JS banner params ──
  // The sign-in card's form POSTs natively (no JavaScript — the Stripe review
  // sandbox iframe blocks the inline script), and the endpoint 302s back here
  // with ?sent=1 (success) or ?error=<urlencoded message> (invalid /
  // rate-limited). Render server-side banners from the query string so the
  // no-JS flow gets real feedback. Only meaningful on the signed-out card — a
  // signed-in visitor is past sign-in, so the params are ignored then
  // (notice stays null; ?sent=1/error= on a signed-in page shows nothing).
  let notice: { kind: "success" | "error"; message: string } | null = null;
  if (!account) {
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      // Defense in depth: these are our own fixed messages, but never trust
      // the query string — length-cap here, and the renderer HTML-escapes.
      notice = { kind: "error", message: errorParam.slice(0, 200) };
    } else if (url.searchParams.get("sent") === "1") {
      notice = { kind: "success", message: "Check your inbox — your sign-in link is on its way." };
    }
  }
  // Optional nicety: when the signed-in account already owns a connected
  // merchant, offer a direct link to the dashboard.
  const dashboardUrl = account
    ? (db.query(
        "SELECT id FROM merchants WHERE account_id = ? AND stripe_account_id != 'acct_default' ORDER BY id LIMIT 1"
      ).get(account.id) as { id: number } | null)
      ? `${baseUrl}/dashboard`
      : null
    : null;

  return new Response(installPageHtml(baseUrl, configuredModes, missingEnv, account, dashboardUrl, notice, visitorId), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * THE single entry point to the marketplace authorize hop — fail-closed by
 * construction:
 *   1. a fresh state is minted AND persisted (oauth_install_states row) FIRST;
 *      if persistence fails, an error page is rendered and NO redirect happens
 *      (a redirect without a stored state would make the callback's CSRF
 *      validation impossible);
 *   2. only then is the authorize URL built — buildAuthorizeUrl ALWAYS injects
 *      the state into the query;
 *   3. the full URL is logged, then the 302 goes out.
 * Every caller (today: GET /oauth/install/start, and any future entry point)
 * goes through this one function, so no code path can ever produce a
 * state-less marketplace authorize redirect.
 */
export function installStartResponse(db: Database, linkType: LinkType, accountId: number | null, visitorId = ""): Response {
  let state: string;
  try {
    state = createInstallState(db, linkType, accountId, visitorId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth-app] install start: FAILED to persist state (link=${linkType}, account=${accountId ?? "legacy"}): ${msg} — refusing to redirect`);
    return new Response(
      appOAuthErrorPage("We couldn't start the installation — the server failed to store the one-time state. Please try again in a moment."),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  const built = buildAuthorizeUrl(state, linkType);
  if ("error" in built) {
    return new Response(appOAuthErrorPage(built.error), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  // Log the authorize URL so Railway logs show exactly what Stripe is asked
  // to authorize (client_id, redirect_uri, state) — the redirect_uri here must
  // match Stripe App Settings byte-for-byte. The chnlink token is masked to
  // its suffix (it is app-level, but never log the full token).
  const maskedUrl = built.url.replace(/chnlink_[^/]+/, (m) => `chnlink_…${m.slice(-4)}`);
  console.log(`[oauth-app] install start: account=${accountId ?? "legacy"} link=${linkType} → ${maskedUrl}`);
  return new Response(null, { status: 302, headers: { Location: built.url } });
}

/** GET /oauth/install/start — REQUIRE a valid account cookie (the reviewer's
 * flow signs in BEFORE connecting), mint a fresh state stamped with the
 * account, and 302 into Stripe's marketplace authorize flow. No/invalid cookie
 * → 302 back to /oauth/install so the user lands on the sign-in card. */
export function handleAppInstallStart(db: Database, req: Request): Response {
  ensureDefaultMerchant(db);
  const baseUrl = baseUrlFor();
  const account = accountFromCookie(db, req);
  if (!account) {
    return new Response(null, { status: 302, headers: { Location: `${baseUrl}/oauth/install` } });
  }
  const url = new URL(req.url);
  const linkParam = url.searchParams.get("link") ?? "";
  // Default link type is LIVE — the production install mode (reviewer fix #4);
  // ?link=test remains for QA.
  const linkType: LinkType = isLinkType(linkParam) ? linkParam : "live";
  // The landing-page visitor_id the install page carried into this start link
  // (?cc_vid=…); sanitized and stored in the state row so the callback can
  // stamp the created merchant for visitor→merchant tracing. No-op when absent.
  const visitorId = sanitizeVisitorId(url.searchParams.get("cc_vid"));

  return installStartResponse(db, linkType, account.id, visitorId);
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
    return {
      ok: false,
      error:
        linkType === "live"
          ? "Neither STRIPE_APP_LIVE_KEY nor STRIPE_SECRET_KEY is set — cannot exchange the authorization code for live-mode tokens."
          : "STRIPE_APP_TEST_KEY is not set — cannot exchange the authorization code for test-mode tokens.",
    };
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
  if (!key) {
    return {
      ok: false,
      error:
        row.link_type === "live"
          ? "Neither STRIPE_APP_LIVE_KEY nor STRIPE_SECRET_KEY is set — cannot refresh tokens for live-mode link."
          : "STRIPE_APP_TEST_KEY is not set — cannot refresh tokens for test-mode link.",
    };
  }

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
 * for the merchant row). Never throws — null on any failure. NOTE: for the
 * marketplace install the app-scoped OAuth token's scope is `stripe_apps`,
 * NOT `read_only`, so /v1/account returns 403 and this yields null in
 * production — the merchant email therefore comes from the platform account
 * (primary) or the developer-key fetch below (secondary); this remains as a
 * final fallback for read-scope tokens (and test stubs). */
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

/** Best-effort fetch of the CONNECTED account's details using the app
 * developer key + Stripe-Account header (email/display name for the merchant
 * row). The developer key acting in the connected account's context CAN read
 * it — the same mechanism proven with the live key in the 8/14 install E2E
 * (it read the merchant's invoices) — unlike the app-scoped OAuth token,
 * which 403s on /v1/account (scope `stripe_apps`, not `read_only`). Never
 * throws; null on any failure (a non-OK response is silent — installs must
 * not spam error logs for accounts the dev key cannot read). */
export async function fetchAccountDetailsViaDevKey(
  stripeUserId: string,
  linkType: LinkType
): Promise<{ email?: string; display_name?: string } | null> {
  const key = appDevKeyFor(linkType);
  if (!key) return null;
  try {
    const res = await fetch(`${STRIPE_API}/account`, {
      headers: { Authorization: `Bearer ${key}`, "Stripe-Account": stripeUserId },
    });
    if (!res.ok) return null;
    const acct = (await res.json()) as Record<string, unknown>;
    return {
      email: typeof acct.email === "string" && acct.email ? acct.email : undefined,
      display_name: typeof acct.display_name === "string" && acct.display_name ? acct.display_name : undefined,
    };
  } catch (err) {
    console.error(`[oauth-app] account fetch via developer key failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Find the merchant owning a Stripe account, or create it (reusing the
 * merchants table; same shape ensureDefaultMerchant writes). Unknown emails
 * fall back to a .local placeholder so notification/summary code treats the
 * row as a placeholder until the real email is known.
 *
 * When a REAL email is available it is applied on BOTH paths: on create it
 * becomes the merchant's email, and on an existing merchant whose email is
 * still the placeholder (`user_…@install.local` — the pre-fix install
 * behavior, because the app-scoped OAuth token cannot read /v1/account) it
 * REPAIRS the row, so a re-install fixes merchants created while the email
 * gap existed. A real email never overwrites an existing real email.
 * When the install was started by a platform account (state row's
 * account_id), the merchant is LINKED to that account — account → merchant →
 * subscription (billing unchanged) — regardless of whether the row already
 * existed, so a merchant first created via web-connect gets attached when
 * the marketplace install completes. */
export function findOrCreateMerchant(
  db: Database,
  stripeUserId: string,
  email?: string | null,
  accountId?: number | null,
  visitorId = ""
): number {
  const existing = db
    .query("SELECT id, email, visitor_id FROM merchants WHERE stripe_account_id = ?")
    .get(stripeUserId) as { id: number; email: string | null; visitor_id: string } | null;
  if (existing) {
    if (accountId) db.run("UPDATE merchants SET account_id = ? WHERE id = ?", [accountId, existing.id]);
    // Email-gap repair: a merchant created before a real email was known (the
    // pre-fix install) carries the placeholder — stamp the real one now so
    // notifications/summaries stop skipping the row. Never overwrite a real
    // email that a later source already wrote.
    if (email && email.includes("@") && (existing.email ?? "").endsWith("@install.local")) {
      db.run("UPDATE merchants SET email = ? WHERE id = ?", [email, existing.id]);
    }
    // visitor-gap repair (visitor→merchant tracing): if this merchant was
    // created before capture existed (visitor_id still the empty default) and
    // THIS install carries a visitor_id, stamp it now so /admin/data can trace
    // the merchant to its source visit. Never overwrite an already-set id.
    if (visitorId && !existing.visitor_id) {
      db.run("UPDATE merchants SET visitor_id = ? WHERE id = ?", [visitorId, existing.id]);
    }
    return existing.id;
  }
  const finalEmail = email && email.includes("@") ? email : `user_${stripeUserId}@install.local`;
  const info = db.run(
    "INSERT INTO merchants (stripe_account_id, email, trust_mode, account_id, visitor_id) VALUES (?, ?, 'draft', ?, ?)",
    [stripeUserId, finalEmail, accountId ?? null, visitorId]
  );
  return Number(info.lastInsertRowid);
}

// ── Post-connect data sync (invoice backfill) ──

/** Convert a unix-seconds timestamp to the watcher's date convention
 * (YYYY-MM-DD, UTC). Mirrors watcher.ts's due_date derivation exactly so the
 * backfilled rows and webhook-derived rows share one date format. */
function unixToIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().split("T")[0];
}

/**
 * Map one Stripe invoice object (from GET /v1/invoices, the merchant's OWN
 * account via their OAuth access token) to the SAME status semantics the
 * watcher stores — never a parallel scheme:
 *   - paid          → 'paid'    (amount = amount_paid, due_date = created)
 *   - open          → 'overdue' when due_date is in the past, else 'open'
 *                     (amount = amount_due, due_date = invoice due_date;
 *                      open invoices without a due_date use created)
 *   - void          → 'void' — a first-class TERMINAL stop state (reviewer
 *                     fix #2): the debt is no longer active and must never be
 *                     chased again.
 *   - uncollectible → 'uncollectible' — the same terminal semantics, kept
 *                     DISTINCT from 'void' so the pipeline's logs and stop
 *                     reasons can tell the two apart.
 *   - draft         → never stored: draft invoices are not active debts and
 *                     must never surface as actionable or as "stopped".
 * With `includeInactive` unset (the install backfill) all inactive statuses
 * (void / uncollectible / draft) map to null = skipped entirely, so the
 * backfill never surfaces a dead debt as actionable. With `includeInactive`
 * (the scheduler's reconciliation sync) void → 'void' and uncollectible →
 * 'uncollectible' are stored (the sync pass then stops open sequences for
 * them — cancel tasks — so an invoice voided or marked uncollectible in
 * Stripe after a missed webhook stops being chased locally); draft still
 * maps to null (a draft never carries tasks, so there is nothing to cancel
 * and nothing to record — and 'draft' is not a legal value of the status
 * CHECK constraint).
 * Customer name/email fall back to "—" when the invoice carries none.
 */
function mapBackfilledInvoice(
  inv: Record<string, unknown>,
  merchantId: number,
  includeInactive = false
): {
  stripe_invoice_id: string;
  merchant_id: number;
  customer_name: string;
  customer_email: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  status: string;
} | null {
  if (!inv || typeof inv.id !== "string" || !inv.id) return null;
  const status = typeof inv.status === "string" ? inv.status : "";
  const name = typeof inv.customer_name === "string" && inv.customer_name ? inv.customer_name : "—";
  const email = typeof inv.customer_email === "string" && inv.customer_email ? inv.customer_email : "—";
  const currency = typeof inv.currency === "string" && inv.currency ? inv.currency : "usd";
  const created = typeof inv.created === "number" ? inv.created : Date.now() / 1000;

  if (status === "paid") {
    return {
      stripe_invoice_id: inv.id,
      merchant_id: merchantId,
      customer_name: name,
      customer_email: email,
      amount_cents: typeof inv.amount_paid === "number" ? inv.amount_paid : 0,
      currency,
      due_date: unixToIsoDate(created),
      status: "paid",
    };
  }
  if (status !== "open") {
    if (!includeInactive) return null; // void / uncollectible / draft: not active
    if (status === "draft") return null; // drafts never carry tasks — nothing to reconcile
    // Reconciliation pass: keep void and uncollectible DISTINCT (both are
    // first-class terminal stop states; the CHECK constraint now allows both).
    return {
      stripe_invoice_id: inv.id,
      merchant_id: merchantId,
      customer_name: name,
      customer_email: email,
      amount_cents: typeof inv.amount_due === "number" ? inv.amount_due : 0,
      currency,
      due_date: unixToIsoDate(created),
      status: status === "uncollectible" ? "uncollectible" : "void",
    };
  }

  const dueDate = typeof inv.due_date === "number" ? inv.due_date : created;
  return {
    stripe_invoice_id: inv.id,
    merchant_id: merchantId,
    customer_name: name,
    customer_email: email,
    amount_cents: typeof inv.amount_due === "number" ? inv.amount_due : 0,
    currency,
    due_date: unixToIsoDate(dueDate),
    status: dueDate * 1000 < Date.now() ? "overdue" : "open",
  };
}

/**
 * Post-connect data sync: best-effort fetch of the merchant's recent invoices
 * (limit 100) using the fresh access_token scoped to their own Stripe account,
 * so a brand-new marketplace install lands on a dashboard that already shows
 * their invoices instead of an empty one (the Stripe reviewer's round-2 ask).
 *
 * Idempotent by construction: every row goes through upsertInvoice, which
 * updates in place on stripe_invoice_id (UNIQUE) — re-runs never duplicate.
 * Never throws: any failure logs and degrades to the previous empty-dashboard
 * behavior. One API call total, rate-limit safe (single 100-row list).
 */
export async function backfillMerchantInvoices(
  db: Database,
  merchantId: number,
  accessToken: string,
  opts: { includeInactive?: boolean; livemode?: number } = {}
): Promise<{ inserted: number; error?: string }> {
  try {
    const res = await fetch(`${STRIPE_API}/invoices?limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      console.warn(`[oauth-app] invoice backfill failed (${msg}) — install continues with an empty dashboard`);
      return { inserted: 0, error: msg };
    }
    const data = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const list = Array.isArray(data?.data) ? data.data : [];
    let inserted = 0;
    for (const raw of list) {
      const mapped = mapBackfilledInvoice((raw ?? {}) as Record<string, unknown>, merchantId, opts.includeInactive === true);
      if (!mapped) continue;
      upsertInvoice(db, { ...mapped, livemode: opts.livemode === 0 ? 0 : 1 });
      inserted++;
    }
    console.log(`[oauth-app] backfilled ${inserted} invoice(s) for merchant ${merchantId} (livemode=${opts.livemode === 0 ? 0 : 1})`);
    return { inserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth-app] invoice backfill failed (${msg}) — install continues with an empty dashboard`);
    return { inserted: 0, error: msg };
  }
}

/**
 * Ongoing invoice sync for a connected merchant: re-runs the same idempotent
 * install backfill (backfillMerchantInvoices — upsert on stripe_invoice_id)
 * using the merchant's STORED (decrypted) OAuth access token. This is the
 * post-install counterpart to the one-time backfill: invoices created AFTER
 * the install never entered the pipeline (no cron, no per-merchant webhook
 * registration), so the dashboard/drawer stayed stale forever.
 *
 * MODE-AWARE since reviewer fix #5: `opts.livemode` (1 = live default,
 * 0 = test) selects the token of that mode via getStripeConnectionFor and tags
 * every pulled row with the mode (upsertInvoice livemode). The dashboard /
 * drawer / scheduler call it once per mode — live rows never mix with test
 * rows. A merchant with a marketplace install in only ONE mode gets a no-op
 * for the other mode (getStripeConnectionFor returns null — never the other
 * mode's token); a legacy web-connect merchant (no oauth_tokens at all) syncs
 * live via the stripe_connections mirror, exactly as before.
 *
 * Wired into dashboard loads (see index.ts): when /stats or /overdue/summary
 * is requested for a merchant with a stored connection, this best-effort
 * refresh runs FIRST so the response reflects invoices created since the last
 * sync — the reviewer flow (connect → land on dashboard → create a test
 * invoice in Stripe → reload → it appears) works with zero extra steps.
 *
 * Guard rails:
 *   - NO fetch when the merchant has no stored connection/token for the mode,
 *     or is disconnected (application.deauthorized sets merchants.disconnected=1
 *     while the token row may still exist) — log + skip.
 *   - NEVER throws into the caller: every failure is caught and logged, and
 *     the page still renders (sync is a refresh, never a gate).
 *   - Sync only refreshes the INVOICES table — it never creates or cancels
 *     reminder_tasks. Task creation stays webhook-only, so a sync can never
 *     resurrect a sequence the pipeline stopped.
 */
export async function syncMerchantInvoices(
  db: Database,
  merchantId: number,
  opts: { includeInactive?: boolean; livemode?: number } = {}
): Promise<{ inserted: number; synced: boolean; reason?: string }> {
  const livemode = opts.livemode === 0 ? 0 : 1;
  try {
    if (isMerchantDisconnected(db, merchantId)) {
      console.log(`[oauth-app] invoice sync skipped for merchant ${merchantId} — stripe account disconnected/deauthorized`);
      return { inserted: 0, synced: false, reason: "disconnected" };
    }
    const conn = getStripeConnectionFor(db, merchantId, livemode);
    if (!conn || !conn.access_token) {
      // No OAuth connection for this mode (web-connect merchant without one,
      // or a marketplace install in the other mode only): nothing to fetch
      // with — skip silently (log-only). Never falls back to the other mode's
      // token (getStripeConnectionFor guarantees that).
      console.log(`[oauth-app] invoice sync skipped for merchant ${merchantId} (livemode=${livemode}) — no stored connection token for this mode`);
      return { inserted: 0, synced: false, reason: "no-connection" };
    }
    // Token refresh before backfill. Stripe OAuth access tokens (rk_live_…)
    // EXPIRE ~1 hour after exchange; the stored stripe_connections mirror
    // holds whatever was last written at install/refresh time, so a sync after
    // expiry hits the API with a dead key (HTTP 401 platform_api_key_expired
    // — reproduced live 2026-08-17: every stored merchant token 401'd and
    // /invoices/sync returned backfill-error:HTTP 401). The marketplace
    // install path keeps the refresh_token in oauth_tokens (refresh tokens
    // roll and live ~1 year): refresh first when the pair exists, so sync
    // keeps working indefinitely without a re-install. refreshAppAccessToken
    // only makes a network call when the stored access token is expired
    // (expires_at) — a fresh token is used as-is. On refresh success the
    // fresh pair is ALSO mirrored into stripe_connections so every other
    // consumer of getStripeConnection (watcher, /stripe/connection status)
    // sees the current token, not the stale mirror.
    let accessToken = conn.access_token;
    const oauthRow = db
      .query("SELECT stripe_user_id FROM oauth_tokens WHERE merchant_id = ? AND livemode = ? ORDER BY updated_at DESC LIMIT 1")
      .get(merchantId, livemode) as { stripe_user_id: string } | null;
    if (oauthRow?.stripe_user_id) {
      const refreshed = await refreshAppAccessToken(db, oauthRow.stripe_user_id);
      if (refreshed.ok) {
        if (refreshed.refreshed) {
          console.log(`[oauth-app] invoice sync: refreshed expired access token for ${oauthRow.stripe_user_id} (merchant ${merchantId}, livemode=${livemode})`);
          // Mirror the fresh pair into stripe_connections so getStripeConnection
          // callers don't keep reading the pre-refresh (expired) token.
          const fresh = getAppOAuthTokens(db, oauthRow.stripe_user_id);
          if (fresh?.access_token) {
            db.run(
              `UPDATE stripe_connections SET access_token=?, refresh_token=?, updated_at=? WHERE id=?`,
              [fresh.access_token, fresh.refresh_token, new Date().toISOString(), conn.id]
            );
          }
        }
        accessToken = refreshed.access_token;
      } else {
        console.warn(`[oauth-app] invoice sync: token refresh failed for ${oauthRow.stripe_user_id} (${refreshed.error}) — falling back to stored access token`);
      }
    }
    const result = await backfillMerchantInvoices(db, merchantId, accessToken, { ...opts, livemode });
    return {
      inserted: result.inserted,
      synced: true,
      reason: result.error ? `backfill-error:${result.error}` : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth-app] invoice sync failed for merchant ${merchantId} (${msg}) — dashboard renders from the stored snapshot`);
    return { inserted: 0, synced: false, reason: "error" };
  }
}

// ── Callback ──

function appOAuthErrorPage(message: string, hint?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const hintHtml = hint
    ? `<p style="background:#EEF2FF;border:1px solid #C7D2FE;border-radius:8px;padding:10px 14px;font-size:13px;color:#3730A3;">${esc(hint)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Installation issue — Collections Copilot</title>
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
    ${hintHtml}
    <a class="btn" href="/oauth/install">Back to installation</a>
    <p class="small">Still stuck? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>
  </div>
</body>
</html>`;
}

/**
 * GET /oauth/callback?code=…&state=… — the marketplace OAuth v2 callback
 * (index.ts branches here when the `code` param is present OR an `error` param
 * arrives without `account`). Verifies the state (CSRF), exchanges the
 * one-time code, stores the token pair, creates/finds the merchant (linked to
 * the platform account that started the install — the state row's account_id),
 * mints a session and bounces through the www-host /oauth/session handoff so
 * the user lands logged-in on the dashboard.
 *
 * Every hit is logged with the FULL raw query string first (`[oauth-app]
 * callback raw query:`) so a failed install is diagnosable from Railway logs
 * without guessing what Stripe sent.
 */
export async function handleAppInstallCallback(db: Database, req: Request): Promise<Response> {
  ensureDefaultMerchant(db);
  const baseUrl = baseUrlFor();
  const url = new URL(req.url);
  const rawQuery = url.searchParams.toString();
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const error = url.searchParams.get("error") ?? "";
  const errorDescription = url.searchParams.get("error_description") ?? "";

  // ── (A) Raw-query logging — BEFORE any branching ──
  // Railway logs must show exactly what Stripe sent back (every key: code,
  // state, error, error_description, and any future/unknown keys), plus the
  // full URL. Without this, "the callback is missing code or state" is
  // unverifiable: was it code-without-state? state-without-code? an error
  // param we ignored? nothing at all?
  console.log(`[oauth-app] callback raw query: ${rawQuery || "(empty)"}`);
  console.log(`[oauth-app] callback url: ${req.url}`);
  const allKeys = [...url.searchParams.keys()];
  if (allKeys.length > 0) {
    console.log(
      `[oauth-app] callback params: ${allKeys
        .map((k) => `${k}=${String(url.searchParams.get(k) ?? "").slice(0, 120)}`)
        .join(" | ")}`
    );
  }

  // ── (E) Explicit error-param handling ──
  // Stripe redirects back with `error` + `error_description` when the
  // authorize step fails (redirect_uri_mismatch, access_denied,
  // invalid_client_id, invalid_scope, …). Show Stripe's ACTUAL error (never
  // the generic missing-params message for this case) plus a fix hint where
  // one is known.
  if (error || errorDescription) {
    const shownError = error || "unknown_error";
    console.error(`[oauth-app] callback error: ${shownError}${errorDescription ? ` — ${errorDescription}` : ""}`);
    let hint = "Please start the installation again from the install page.";
    if (shownError === "redirect_uri_mismatch") {
      hint = "Check that the redirect URI in Stripe App Settings matches https://stripe-cc-production.up.railway.app/oauth/callback exactly (no trailing slash), then start the installation again.";
    } else if (shownError === "access_denied") {
      hint = "You declined the authorization — you can start the installation again any time.";
    } else if (shownError === "invalid_client_id") {
      hint = "Stripe doesn't recognize the app's client id — check STRIPE_APP_LIVE_CLIENT_ID / STRIPE_APP_TEST_CLIENT_ID on the server.";
    } else if (shownError === "invalid_scope") {
      hint = "The requested OAuth scope is not valid for this app.";
    }
    return new Response(
      appOAuthErrorPage(`Authorization was not completed (${shownError}).${errorDescription ? ` ${errorDescription}.` : ""}`, hint),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // ── Distinct no-params messages (generic only as last resort) ──
  // Stripe echoes `state` back only when it was present in the authorize URL,
  // so "code WITHOUT state" means a bare OAuth link (no state=…) was tested
  // directly instead of the install page's /oauth/install/start flow. We must
  // NOT exchange the code without state (state is the one-time DB-backed CSRF
  // proof), but the user gets the real reason, not a generic message.
  if (code && !state) {
    // FAIL-CLOSED: never exchange a code without its state (state is the
    // one-time DB-backed CSRF proof). Log the truncated code prefix so the hit
    // can be correlated with Stripe's OAuth dashboard, then show the specific
    // bare-link diagnosis page.
    console.warn(`[oauth-app] callback: code WITHOUT state (code prefix ${code.slice(0, 12)}…) — a bare authorize URL (no state=…) was used; refusing to exchange (fail-closed). Start the install from /oauth/install instead.`);
    return new Response(
      appOAuthErrorPage(
        "The callback received an authorization code but no state parameter — this usually happens when a bare OAuth link (without state=…) is tested directly instead of going through the install page. Please start the installation again from the install page."
      ),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  if (state && !code) {
    console.warn(`[oauth-app] callback: state WITHOUT code (state prefix ${state.slice(0, 12)}…) — refusing to exchange.`);
    return new Response(
      appOAuthErrorPage("The callback received a state parameter but no authorization code. Please start the installation again."),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  if (!code || !state) {
    console.warn("[oauth-app] callback: no code AND no state — refusing to exchange.");
    return new Response(
      appOAuthErrorPage("The callback is missing the authorization code or state. Please start the installation again."),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const consumed = consumeInstallState(db, state);
  if (!consumed) {
    console.warn(`[oauth-app] callback: state NOT FOUND / consumed / expired (state prefix ${state.slice(0, 12)}…) — refusing to exchange (fail-closed).`);
    return new Response(appOAuthErrorPage("This installation link is invalid or has expired. Please start the installation again."), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const { link_type: linkType, account_id: installAccountId, visitor_id: installVisitorId } = consumed;
  console.log(`[oauth-app] callback: state OK (link=${linkType}, account=${installAccountId ?? "legacy"}, visitor=${installVisitorId ? "present" : "none"}) — exchanging code (prefix ${code.slice(0, 12)}…)`);

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

  // ── Merchant email resolution (the email-gap fix) ──
  // The app-scoped OAuth access token CANNOT read /v1/account (its scope is
  // `stripe_apps`, not `read_only`), so the app-token fetch below returns null
  // in production and merchants used to get a placeholder
  // (`user_…@install.local`) — the "no real email" gap that skipped weekly
  // summaries. PRIMARY source: the signed-in platform account that started the
  // install (accounts.email — the magic-link sign-in address, always real and
  // deliverable; the install flow is account-gated and the state row records
  // WHICH account started it). SECONDARY: the connected account's own email
  // via the developer key + Stripe-Account header (works in production —
  // proven with the live key in the 8/14 install E2E). TERTIARY: the app-token
  // fetch (read-scope tokens only; kept for back-compat with test stubs). The
  // placeholder fallback remains ONLY when all three yield nothing.
  const platformAccount = installAccountId
    ? (db.query("SELECT id, email FROM accounts WHERE id = ?").get(installAccountId) as { id: number; email: string } | null)
    : null;
  const devKeyDetails = await fetchAccountDetailsViaDevKey(tokens.stripe_user_id, linkType);
  const appTokenDetails = await fetchAccountDetails(tokens.access_token);
  const merchantEmail =
    platformAccount?.email && platformAccount.email.includes("@")
      ? platformAccount.email
      : devKeyDetails?.email ?? appTokenDetails?.email ?? null;

  // Link the merchant to the platform account that started the install
  // (state row's account_id; null for legacy/back-compat state rows). This is
  // the account → merchant → subscription chain the reviewer asked for: the
  // purchased subscription (getSubscriptionByMerchantId) becomes reachable
  // from the account through the merchant. Billing itself is unchanged.
  const merchantId = findOrCreateMerchant(db, tokens.stripe_user_id, merchantEmail, installAccountId, installVisitorId);
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

  // Post-connect data sync: pull the merchant's recent invoices (their own
  // account, via the fresh access_token) so a brand-new marketplace install
  // lands on a dashboard that already shows their invoices rather than an
  // empty one (reviewer round-2 ask). Best-effort — any failure logs and
  // degrades to the previous empty-dashboard behavior; never blocks or
  // breaks the install. Idempotent via upsertInvoice on stripe_invoice_id.
  // Tagged with the install's mode (livemode from the token exchange —
  // reviewer fix #5) so a test-mode install never writes live rows.
  await backfillMerchantInvoices(db, merchantId, tokens.access_token, { livemode: tokens.livemode ? 1 : 0 });

  // ── Mint the session + cross-host handoff ──
  // SameSite / persistence analysis (task D): the install STATE is
  // DB-backed (oauth_install_states, one-time + 30-min TTL) — nothing about
  // this flow depends on browser cookies surviving the Stripe redirect, so
  // cookie SameSite was never implicated in state loss; the state always
  // round-trips server-side. The cookies that DO matter:
  //   • cc_account (platform sign-in, set by /api/account/verify):
  //     SameSite=Lax + Secure — correct; the whole install flow is
  //     first-party on the Railway host, no cross-site subresource use.
  //   • session (merchant session, set below): SameSite=None + Secure +
  //     HttpOnly — required because this callback is a top-level navigation
  //     FROM Stripe's site (cross-site), and the same cookie must later be
  //     re-set on the www dashboard host via /oauth/session (a different
  //     registrable domain). SameSite=None is the only policy that lets the
  //     browser carry it on those first-party navigations.
  // Identical mechanics to the Express callback in routes/oauth.ts:
  // Railway-host cookie here, then bounce through www /oauth/session so the
  // dashboard host gets the same cookie.
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
