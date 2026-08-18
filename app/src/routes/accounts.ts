/**
 * Platform accounts — email + magic-link sign-in for the Stripe marketplace
 * install flow (owner decision 2026-08-13, responding to the Stripe reviewer's
 * round-2 CHANGES REQUESTED).
 *
 * The reviewer's expected OAuth flow is: marketplace → listing → Install →
 * user logs in or signs up on our platform → connect Stripe → install → sync
 * → subscribe. Today /oauth/install goes straight to "Connect with Stripe"
 * with no account. This module adds the account layer:
 *
 *   POST /api/account/request-magic-link  {email}  — find-or-create the account
 *       (first-time email = signup, same endpoint — deliberately no existence
 *       leak: ALWAYS 200 {ok:true} for any valid, non-rate-limited email) and
 *       email a one-time 15-minute sign-in link. Per-email + per-IP rate limit
 *       5/hr → 429. ALSO accepts application/x-www-form-urlencoded (email=…,
 *       the NATIVE no-JS form POST from the install page's sign-in card — the
 *       Stripe review sandbox runs the page in an iframe where inline scripts
 *       don't execute) and answers THAT path with a 302 to /oauth/install
 *       (?sent=1 on success, ?error=<msg> for invalid/rate-limited) so the
 *       install page can render feedback with zero JavaScript.
 *   GET  /api/account/verify?token=…&next=…   — consume the one-time token,
 *       record last_login_at, mint a 30-day account session, set the HttpOnly
 *       `cc_account` cookie, 302 to `next` (safe-path guard; default
 *       /oauth/install). Invalid/expired/used tokens get a friendly error page.
 *   GET  /api/account/me            — {email} from the account cookie, else 401.
 *   POST /api/account/logout        — clear the account cookie.
 *
 * Security posture (constraints from the lead): tokens are 32-byte random hex,
 * one-time use, 15-minute expiry; the account cookie is HttpOnly + SameSite=Lax
 * + Secure (a first-party-only cookie — the whole install flow stays on the
 * Railway host, unlike the merchant session cookie's SameSite=None which exists
 * for the cross-host dashboard handoff); magic-link requests are rate limited;
 * account existence is never leaked.
 *
 * Email delivery mirrors pipeline/owner-notify.ts exactly: the product's own
 * sender (sendEmailForReal — Resend in production, log-only stub in tests)
 * with skipCanspam (transactional, user-initiated — no marketing footer), and
 * a send_logs row (type 'account_magic_link') for traceability + deterministic
 * test assertions.
 *
 * Linkage chain (NO billing changes): account → merchant (merchants.account_id,
 * stamped by the OAuth callback from the install state row) → subscription
 * (existing getSubscriptionByMerchantId). The dashboard already shows the plan
 * via /subscription.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { readCookie } from "../middleware/session";
import { sendEmailForReal } from "../pipeline/sender";
import type { EmailDraft } from "../pipeline/drafter";
import { logSend } from "../db";

// ── Account cookie ──
// Host-only (no Domain attribute) like the merchant session cookie: the
// account only needs to exist on the host serving the marketplace install
// flow (BASE_URL / Railway). Distinct name from the merchant `session` cookie.
const ACCOUNT_COOKIE_NAME = "cc_account";
const ACCOUNT_SESSION_DAYS = 30;

export function accountCookieFor(token: string): string {
  return `${ACCOUNT_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ACCOUNT_SESSION_DAYS * 86400}`;
}

/** The cleared-cookie string for logout (Max-Age=0 → immediate expiry). */
export function accountCookieCleared(): string {
  return `${ACCOUNT_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The current account for a request, or null when the cookie is absent/invalid/expired. */
export function accountFromCookie(db: Database, req: Request): { id: number; email: string } | null {
  const token = readCookie(req, ACCOUNT_COOKIE_NAME);
  if (!token) return null;
  return (
    db
      .query(
        `SELECT a.id, a.email
         FROM account_sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token = ? AND s.expires_at > datetime('now')`
      )
      .get(token) as { id: number; email: string } | null
  ) ?? null;
}

// ── Magic-link token + email ──

const MAGIC_LINK_TTL_MINUTES = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize a submitted email: trim + lowercase (accounts.email is UNIQUE). */
function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * Email a one-time sign-in link. Mirrors owner-notify.ts's send pattern: the
 * product sender with skipCanspam (transactional, user-initiated), plus a
 * send_logs row (type 'account_magic_link') so the send is traceable and the
 * test suite can assert it deterministically in log-only mode. Never throws —
 * the caller always returns 200 regardless.
 */
async function sendMagicLinkEmail(db: Database, toEmail: string, token: string): Promise<{ success: boolean; message: string }> {
  const baseUrl = process.env.BASE_URL || "http://localhost:3002";
  const verifyUrl = `${baseUrl}/api/account/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent("/oauth/install")}`;
  const draft: EmailDraft = {
    subject: "Your CollectionsCopilot sign-in link",
    body: [
      `Hi,`,
      ``,
      `Here's your one-time sign-in link for CollectionsCopilot:`,
      ``,
      verifyUrl,
      ``,
      `It expires in 15 minutes. If you didn't request this, ignore this email.`,
    ].join("\n"),
  };
  try {
    const sendResult = await sendEmailForReal(db, null, draft, toEmail, undefined, { skipCanspam: true });
    logSend(
      db,
      0,
      sendResult.success ? "success" : "failed",
      `Magic-link email ${sendResult.success ? "sent" : "failed"} to ${toEmail}: ${sendResult.message}`,
      "account_magic_link",
    );
    return { success: sendResult.success, message: sendResult.message };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[accounts] magic-link send error: ${msg}`);
    try {
      logSend(db, 0, "failed", `Magic-link email failed to ${toEmail}: ${msg}`, "account_magic_link");
    } catch {
      // Logging failed too — never throw to caller.
    }
    return { success: false, message: msg };
  }
}

// ── Rate limiting ──
// In-memory per-key window (5 requests / hour), the same simple abuse guard as
// routes/waitlist.ts (process-local, pruned on access — not a security
// boundary). TWO buckets per request: one keyed by the normalized email, one
// by the client IP. Both must pass; a 429 means "try again later" either way.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateBuckets = new Map<string, number[]>();

function rateLimit(key: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const stamps = (rateBuckets.get(key) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, stamps);
    return false;
  }
  stamps.push(now);
  rateBuckets.set(key, stamps);
  return true;
}

/** Client IP for rate limiting: first X-Forwarded-For hop, else X-Real-IP, else local. */
function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

// ── Handlers ──

/**
 * POST /api/account/request-magic-link — find-or-create the account and email
 * a one-time sign-in link.
 *
 * Accepts JSON {email} (the install page's JS fetch path — returns
 * 200 {ok:true} / 400 / 429 exactly as before) AND
 * application/x-www-form-urlencoded email=... (the NATIVE no-JS form POST from
 * the install page — returns a 302 the browser follows: success →
 * /oauth/install?sent=1, invalid/rate-limited → /oauth/install?error=<msg>,
 * where the install page renders server-side banners without any JavaScript —
 * the Stripe review sandbox runs the page in an iframe where inline scripts
 * don't execute). Both paths ALWAYS succeed (200 JSON / 302 sent=1) for a
 * valid, non-rate-limited email — whether the account is new or existing — so
 * the endpoint never leaks account existence. Invalid emails → 400 (JSON) /
 * 302 error (form); rate limit (per email AND per IP) → 429 (JSON) / 302
 * error (form). A send_logs row (type 'account_magic_link') is written on
 * BOTH paths (inside sendMagicLinkEmail).
 */
export async function handleAccountRequestMagicLink(db: Database, req: Request): Promise<Response> {
  const headers = { "Content-Type": "application/json" };
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  // Native form POST (no-JS path) vs JS fetch. The response SHAPE differs by
  // content-type: forms get a 302 redirect to /oauth/install?sent=1|error=…
  // (server-rendered banners, works with scripts disabled); JSON keeps the
  // existing 200/400/429 contract.
  const isForm = contentType.includes("application/x-www-form-urlencoded");
  /** 302 for the no-JS form path — root-relative to the install page ONLY
   * (never an arbitrary destination): safe by construction. */
  const formRedirect = (query: string): Response =>
    new Response(null, { status: 302, headers: { Location: `/oauth/install?${query}` } });

  // Parse email from JSON or form-encoded (same tolerance as /waitlist).
  let emailRaw = "";
  if (isForm) {
    try {
      const form = await req.formData();
      const v = form.get("email");
      if (typeof v === "string") emailRaw = v;
    } catch {
      // Fall through to validation — missing email yields 400/302-error.
    }
  } else {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (typeof body.email === "string") emailRaw = body.email;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
    }
  }

  const email = normalizeEmail(emailRaw);
  if (!email) {
    const msg = "Email is required";
    return isForm ? formRedirect(`error=${encodeURIComponent(msg)}`) : new Response(JSON.stringify({ error: msg }), { status: 400, headers });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    const msg = "Enter a valid email address";
    return isForm ? formRedirect(`error=${encodeURIComponent(msg)}`) : new Response(JSON.stringify({ error: msg }), { status: 400, headers });
  }

  // Rate limit: per email AND per IP (each 5/hr). Checked after validation so
  // garbage input gets a 400, not a burned rate-limit slot.
  if (!rateLimit(`email:${email}`) || !rateLimit(`ip:${clientIpFor(req)}`)) {
    const msg = "Too many sign-in requests — please try again later.";
    return isForm ? formRedirect(`error=${encodeURIComponent(msg)}`) : new Response(JSON.stringify({ error: msg }), { status: 429, headers });
  }

  // Find-or-create the account (first-time email = signup, same endpoint).
  db.run(
    "INSERT INTO accounts (email) VALUES (?) ON CONFLICT(email) DO NOTHING",
    [email],
  );
  const account = db.query("SELECT id FROM accounts WHERE email = ?").get(email) as { id: number };

  // Mint a one-time token (32 random bytes hex, 15-min expiry) and send the link.
  const token = randomBytes(32).toString("hex");
  db.run(
    "INSERT INTO account_magic_links (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))",
    [account.id, token],
  );
  await sendMagicLinkEmail(db, email, token);

  // Never reveal whether the account existed: JSON 200 {ok:true} (JS path) /
  // 302 ?sent=1 (no-JS form path).
  return isForm
    ? formRedirect("sent=1")
    : new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/** Safe-destination guard for ?next= on verify: relative paths starting with
 * "/" (never "//" or backslash — no protocol-relative / open redirects) or the
 * known www dashboard URL. Anything else falls back to /oauth/install. */
export function safeNextPath(next: string): string {
  if (next === "https://www.getcollectionscopilot.com/dashboard") return next;
  if (next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")) return next;
  return "/oauth/install";
}

/** Friendly HTML page for invalid/expired/used magic-link tokens. */
function magicLinkErrorPage(): Response {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign-in link invalid — CollectionsCopilot</title>
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
    <h1>This sign-in link is invalid or expired</h1>
    <p>Sign-in links are one-time and expire after 15 minutes. Request a fresh link to continue.</p>
    <a class="btn" href="/oauth/install">Back to installation</a>
    <p class="small">Still stuck? Email <a href="mailto:support@getcollectionscopilot.com" style="color:#6B7280;">support@getcollectionscopilot.com</a></p>
  </div>
</body>
</html>`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /api/account/verify?token=…&next=… — consume the one-time magic link.
 *
 * The single UPDATE below does the one-time consumption atomically: it only
 * succeeds (changes === 1) for an unconsumed, unexpired token — a replayed or
 * expired link never mints a session. On success: record last_login_at, mint a
 * 30-day account session, set the HttpOnly cc_account cookie, and 302 to the
 * safe `next` destination (default /oauth/install — the install page, which
 * the user now sees logged in).
 */
export function handleAccountVerify(db: Database, req: Request): Response {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const next = url.searchParams.get("next") || "";

  if (!token) return magicLinkErrorPage();

  const consumed = db.run(
    `UPDATE account_magic_links
     SET used_at = datetime('now')
     WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    [token],
  );
  if (consumed.changes !== 1) return magicLinkErrorPage();

  const link = db.query("SELECT account_id FROM account_magic_links WHERE token = ?").get(token) as { account_id: number };
  db.run("UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?", [link.account_id]);

  const sessionToken = randomBytes(32).toString("hex");
  db.run(
    "INSERT INTO account_sessions (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
    [link.account_id, sessionToken],
  );

  const dest = safeNextPath(next);
  return new Response(null, {
    status: 302,
    headers: {
      Location: dest,
      "Set-Cookie": accountCookieFor(sessionToken),
    },
  });
}

/** GET /api/account/me — the signed-in account's email (used by the install
 * page to render "Signed in as …"), or 401. */
export function handleAccountMe(db: Database, req: Request): Response {
  const account = accountFromCookie(db, req);
  if (!account) {
    return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ email: account.email }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** POST /api/account/logout — clear the account cookie (and drop the session
 * row so the token dies server-side too). */
export function handleAccountLogout(db: Database, req: Request): Response {
  const token = readCookie(req, ACCOUNT_COOKIE_NAME);
  if (token) {
    db.run("DELETE FROM account_sessions WHERE token = ?", [token]);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": accountCookieCleared() },
  });
}
