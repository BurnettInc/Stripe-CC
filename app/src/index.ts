import { getDb, ensureDefaultMerchant, freeDraftsRemaining, isActivePaidSubscriber, recordUnsubscribe, countOverdueInvoices, invoiceLimitFor, isMerchantDisconnected } from "./db";
import { corsHeadersFor } from "./middleware/cors";
import { handleWebhook } from "./routes/webhook";
import { handlePastDuePage, handleRemindersPage } from "./routes/pages";
import { handleTasks } from "./routes/tasks";
import { handleInboundReply } from "./routes/inbound";
import { handleReplies } from "./routes/replies";
import { handleSettings } from "./routes/settings";
import { handleBilling } from "./routes/billing";
import { handleStripeConnect, handleStripeOAuthCallback, handleStripeConnectionStatus, handleOAuthSession, handleOAuthHandoff, handleOAuthSuccess } from "./routes/oauth";
import { handleInvoices } from "./routes/invoices";
import { handleSupport } from "./routes/support";
import { handleAdminPage, handleAdminData, requireAdminToken } from "./routes/admin";
import { handleTrack } from "./routes/track";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSession } from "./middleware/session";
import { getStripeConnection } from "./middleware/auth";

// Railway injects PORT dynamically — honor it, fall back to 3002 for local dev.
const PORT = Number(process.env.PORT) || 3002;
const START_TIME = Date.now();

// Load the dashboard HTML once at startup
const dashboardHtml = readFileSync(join(import.meta.dirname, "ui", "dashboard.html"), "utf-8");

// ── Marketing site integration ──
// The ENTIRE product runs as one Railway service: the backend serves its own
// routes (API/webhook/OAuth/dashboard) AND the built TanStack Start site
// (landing page at "/", /support, /privacy, /terms, /about). Static assets come
// from the site build's dist/client; every other unmatched path falls through
// to the site's SSR handler (dist/server/server.js — emitted by
// `cd site && bun run build`, which the root Dockerfile runs at build time).
const SITE_CLIENT_DIR = join(import.meta.dirname, "..", "..", "site", "dist", "client");

// Loaded lazily on the first site request so the backend still boots in local
// dev when the site hasn't been built. A variable specifier keeps TypeScript
// (no TS2307) and bun build (stays a runtime import) happy; at runtime Bun
// resolves it relative to this file → <repo>/site/dist/server/server.js.
const SITE_SERVER_ENTRY = "../../site/dist/server/server.js";

interface SiteHandler {
  fetch(req: Request): Response | Promise<Response>;
}

let siteHandlerPromise: Promise<SiteHandler | null> | null = null;

function getSiteHandler(): Promise<SiteHandler | null> {
  if (!siteHandlerPromise) {
    siteHandlerPromise = (async () => {
      try {
        const mod = (await import(SITE_SERVER_ENTRY)) as { default?: unknown };
        const candidate = mod.default ?? mod;
        const handler = candidate as SiteHandler;
        if (typeof handler.fetch !== "function") {
          console.error("[site] Built site SSR handler has no fetch() — check the site build.");
          return null;
        }
        return handler;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[site] Site SSR handler unavailable (was the site built? run \`cd site && bun run build\`): ${message}`);
        return null;
      }
    })();
  }
  return siteHandlerPromise;
}

// Serve a built site static asset (dist/client/<path>) for GET requests whose
// path maps to a real file — e.g. /assets/*.js, /icon.svg. Paths are joined
// onto SITE_CLIENT_DIR and must stay inside it (no traversal).
async function serveSiteAsset(pathname: string): Promise<Response | null> {
  const clean = pathname.replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  const file = Bun.file(join(SITE_CLIENT_DIR, clean));
  try {
    return (await file.exists()) ? new Response(file) : null;
  } catch {
    return null;
  }
}

// ── Startup logging ──

console.log(`🚀 Stripe Collections Copilot starting up...`);
console.log(`   Time: ${new Date().toISOString()}`);
console.log(`   Port: ${PORT}`);

// Stripe key status (masked)
const stripeKey = process.env.STRIPE_SECRET_KEY || "";
if (stripeKey) {
  const masked = stripeKey.length > 8
    ? stripeKey.substring(0, 4) + "..." + stripeKey.substring(stripeKey.length - 4)
    : "***";
  console.log(`   Stripe key: ${masked} (configured)`);
} else {
  console.log(`   Stripe key: not set (webhooks & billing will fail)`);
}

// Email provider status
const sendgridKey = process.env.SENDGRID_API_KEY;
const resendKey = process.env.RESEND_API_KEY;
if (sendgridKey) {
  console.log(`   Email provider: SendGrid (configured)`);
} else if (resendKey) {
  console.log(`   Email provider: Resend (configured)`);
} else {
  console.log(`   Email provider: none (log-only mode)`);
}

// Effective from-address for outgoing reminders (shown when set — see the
// FROM_EMAIL boot guard below for the production requirement).
if (process.env.FROM_EMAIL) {
  console.log(`   From address: ${process.env.FROM_EMAIL}`);
}

// Webhook signature verification
if (process.env.STRIPE_WEBHOOK_SECRET) {
  console.log(`   Webhook verification: enabled`);
} else {
  // In production (or any non-localhost deployment) webhook endpoints MUST
  // verify Stripe signatures — otherwise anyone can forge payment events and
  // drive the email pipeline. Refuse to boot without the secret outside local
  // development instead of silently running unverified.
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const isLocalDev = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction || !isLocalDev) {
    console.error(`   FATAL: STRIPE_WEBHOOK_SECRET is not set and this server is not running on localhost.`);
    console.error(`   (NODE_ENV=${process.env.NODE_ENV || "unset"}, BASE_URL=${baseUrl})`);
    console.error(`   Webhook signature verification would be disabled in production — refusing to boot.`);
    console.error(`   Set STRIPE_WEBHOOK_SECRET (from: stripe listen --forward-to localhost:3001/webhook) and retry.`);
    process.exit(1);
  }
  console.log(`   Webhook verification: disabled (test mode)`);
}

// From-address boot guard. sender.ts falls back to
// noreply@stripecollectionscopilot.com when FROM_EMAIL is unset — that domain
// is NOT registered, so Resend rejects every send from it and production
// reminders would fail silently. Refuse to boot without FROM_EMAIL outside
// local development, mirroring the STRIPE_WEBHOOK_SECRET guard above.
if (!process.env.FROM_EMAIL) {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const isLocalDev = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction || !isLocalDev) {
    console.error(`   FATAL: FROM_EMAIL is not set and this server is not running on localhost.`);
    console.error(`   (NODE_ENV=${process.env.NODE_ENV || "unset"}, BASE_URL=${baseUrl})`);
    console.error(`   Outgoing reminders need a sender address on a Resend-verified domain — the fallback noreply@stripecollectionscopilot.com is not registered, so Resend would reject every send.`);
    console.error(`   Set FROM_EMAIL (e.g. reminders@mail.getcollectionscopilot.com) and retry.`);
    process.exit(1);
  }
}

// Token encryption status (OAuth tokens at rest)
if (process.env.TOKEN_ENCRYPTION_KEY) {
  console.log(`   Token encryption: enabled (AES-256-GCM)`);
} else {
  console.log(`   Token encryption: disabled (tokens stored in plaintext)`);
}

// Support API token status (Pro priority-support ops: token-gated merchant
// lookup + first-response log for the Support agent). The /support/*
// endpoints return 403 when this is unset — the API is effectively disabled,
// mirroring how the FROM_EMAIL guard treats its env var (checked at boot,
// logged clearly) without refusing to boot.
if (process.env.SUPPORT_API_TOKEN) {
  console.log(`   Support lookup API: enabled (SUPPORT_API_TOKEN set)`);
} else {
  console.log(`   Support lookup API disabled (SUPPORT_API_TOKEN unset)`);
}

// Inbound reply webhook status (reply-pause D1a). The /inbound/reply endpoint
// returns 403 when INBOUND_WEBHOOK_TOKEN is unset — the endpoint is disabled
// until the Cloudflare worker wiring (D3) provides the shared secret.
if (process.env.INBOUND_WEBHOOK_TOKEN) {
  console.log(`   Inbound reply webhook: enabled (INBOUND_WEBHOOK_TOKEN set)`);
} else {
  console.log(`   Inbound reply webhook disabled (INBOUND_WEBHOOK_TOKEN unset — /inbound/reply returns 403)`);
}

// Admin-only internal dashboard status (admin customer tracking): /admin and
// /admin/data return 403 when ADMIN_TOKEN is unset — the admin surface is
// disabled, mirroring the SUPPORT_API_TOKEN pattern.
if (process.env.ADMIN_TOKEN) {
  console.log(`   Admin dashboard: enabled (ADMIN_TOKEN set)`);
} else {
  console.log(`   Admin dashboard disabled (ADMIN_TOKEN unset — /admin returns 403)`);
}

// Reply-To tracking status (reply-pause D1a): customer reminders carry the
// tracked reply+{invoice}@ reply address so replies route back to the inbound
// pipeline. REPLY_DOMAIN is env-driven so production works before the
// DNS/MX wiring exists.
console.log(`   Reply-To tracking domain: ${process.env.REPLY_DOMAIN || "replies.getcollectionscopilot.com (default)"}`);

async function handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeadersFor(req) });
    const url = new URL(req.url);
    const path = url.pathname;

    const db = getDb();
    ensureDefaultMerchant(db);

    try {
      // GET /dashboard — the app dashboard. Moved from "/" (which now serves
      // the marketing site's landing page). dashboard.html talks to the backend
      // with root-absolute paths (/tasks, /settings, /stripe/connect, ...), so
      // the move doesn't affect its API calls. The static HTML carries a
      // __CC_HANDOFF_URL__ placeholder that is replaced here at serve time with
      // <BASE_URL>/oauth/handoff — the dashboard's JS bounces through that URL
      // on the first 401 so a Railway-host-only session cookie (merchants who
      // connected before the /oauth/session handoff shipped) gets handed to the
      // www host, self-healing the dashboard without any manual reconnect.
      if (path === "/dashboard" && req.method === "GET") {
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const served = dashboardHtml.replaceAll("__CC_HANDOFF_URL__", `${baseUrl}/oauth/handoff`);
        return new Response(served, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /health — health check endpoint
      if (path === "/health" && req.method === "GET") {
        const uptime = Math.floor((Date.now() - START_TIME) / 1000);
        return new Response(JSON.stringify({
          status: "ok",
          uptime,
          uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
          startedAt: new Date(START_TIME).toISOString(),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /stats — usage statistics
      if (path === "/stats" && req.method === "GET") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const merchantId = auth.merchant_id;
        // Stripe connection state for the dashboard's Stripe stat card:
        //   connected     — a stripe_connections row exists (OAuth completed)
        //                   and the account has not been deauthorized
        //   disconnected  — account.application.deauthorized set
        //                   merchants.disconnected=1 (watcher)
        //   never connected — no stripe_connections row at all
        const stripeConn = getStripeConnection(db, merchantId);
        const stripeDisconnected = isMerchantDisconnected(db, merchantId);
        const stripeConnected = !!stripeConn && !stripeDisconnected;
        const stripeAccountId = stripeConn?.id ?? null;
        // Total invoices processed (any status)
        const totalInvoicesRow = db.query("SELECT COUNT(*) as count FROM invoices WHERE merchant_id=?").get(merchantId) as { count: number };
        const totalInvoices = totalInvoicesRow.count;
        const freeDrafts = freeDraftsRemaining(db, merchantId);
        // The 5-draft free allowance only applies to merchants with no active
        // paid subscription. Paid merchants (Standard or Pro active) have no
        // draft cap — the dashboard renders "Unlimited" instead of the
        // misleading countdown (which would otherwise show a number for a plan
        // that has no limit).
        const freeDraftsUnlimited = isActivePaidSubscriber(db, merchantId);

        // Total reminders sent (send_logs with type='reminder' and status='success')
        const remindersSentRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id=rt.id JOIN invoices i ON rt.invoice_id=i.id WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=?"
        ).get(merchantId) as { count: number };
        const remindersSent = remindersSentRow.count;

        // Total emails actually sent (non-stub — we check for provider_message NOT containing '[STUB SEND]')
        const emailsSentRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id=rt.id JOIN invoices i ON rt.invoice_id=i.id WHERE sl.status='success' AND sl.type='reminder' AND sl.provider_message NOT LIKE '%[STUB SEND]%' AND i.merchant_id=?"
        ).get(merchantId) as { count: number };
        const emailsSent = emailsSentRow.count;

        // Weekly summary emails sent — exclude [STUB SEND] rows the same way
        // the reminder count above does, so stats can never count a stub as a
        // real send (a summary to a placeholder merchant would otherwise
        // surface here as "sent").
        const summaryEmailsRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id=rt.id JOIN invoices i ON rt.invoice_id=i.id WHERE sl.type='weekly_summary' AND sl.status='success' AND sl.provider_message NOT LIKE '%[STUB SEND]%' AND i.merchant_id=?"
        ).get(merchantId) as { count: number };
        const summaryEmailsSent = summaryEmailsRow.count;

        // Paid invoices count
        const paidRow = db.query(
          "SELECT COUNT(*) as count FROM invoices WHERE status='paid' AND merchant_id=?"
        ).get(merchantId) as { count: number };
        const paidInvoices = paidRow.count;

        // Standard plan cap status. invoiceLimit is null when the merchant is
        // not capped (Pro or free); overInvoiceLimit is true only when an
        // active Standard merchant has >= 50 overdue invoices (new tracking
        // is blocked by the watcher until the count drops back under 50).
        const overdueInvoices = countOverdueInvoices(db, merchantId);
        const invoiceLimit = invoiceLimitFor(db, merchantId);
        const overInvoiceLimit = invoiceLimit !== null && overdueInvoices >= invoiceLimit;

        return new Response(JSON.stringify({
          totalInvoices,
          totalInvoicesProcessed: totalInvoices,
          remindersSent,
          emailsSent,
          summaryEmailsSent,
          paidInvoices,
          overdueInvoices,
          invoiceLimit,
          overInvoiceLimit,
          free_drafts_remaining: freeDrafts,
          free_drafts_unlimited: freeDraftsUnlimited,
          stripeConnected,
          stripeDisconnected,
          stripeAccountId,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /past-due — server-rendered list of the merchant's past-due
      // (overdue) invoices. Drilled into from the dashboard "Invoices" stat
      // card. Same session-cookie auth as every other dashboard route.
      if (path === "/past-due" && req.method === "GET") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        // Optional ?status= filter tab (all|overdue|paid|refunded|disputed);
        // the handler defaults to overdue when absent or unknown.
        const status = url.searchParams.get("status") ?? "";
        return handlePastDuePage(db, auth.merchant_id, status);
      }

      // GET /reminders — server-rendered history of sent reminder emails.
      // Drilled into from the dashboard "Sent Reminders" stat card. Every row
      // is a send_logs 'success' entry; test-mode stub sends are labeled with
      // a muted "Test send" pill next to the customer name (and carry a
      // row-test marker class) so a stub can never be mistaken for a real
      // delivery, and can be hidden with the "Hide test sends" checkbox.
      if (path === "/reminders" && req.method === "GET") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        // Single list — no ?type= split (the page has one dataset).
        return handleRemindersPage(db, auth.merchant_id);
      }

      // POST /webhook — Stripe webhook events
      if (path === "/webhook") {
        return handleWebhook(db, req);
      }

      // POST /inbound/reply — inbound customer-reply webhook (reply-pause
      // D1a). Token-verified (Authorization: Bearer INBOUND_WEBHOOK_TOKEN);
      // the Cloudflare Email Routing Worker posts captured replies here using
      // the contract documented in routes/inbound.ts. Always responds 200 fast
      // and is idempotent on idempotency_key (worker retries safe). When
      // INBOUND_WEBHOOK_TOKEN is unset every request returns 403 — the
      // endpoint is effectively disabled (same pattern as /support/*).
      if (path === "/inbound/reply") {
        return handleInboundReply(db, req);
      }

      // GET/POST /tasks... — task management
      if (path.startsWith("/tasks")) {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        return handleTasks(db, req, path.slice("/tasks".length), auth.merchant_id);
      }

      // GET/POST /replies... — reply review queue (reply-pause D1b): list,
      // approve, edit, reject held customer replies. Same session auth as
      // /tasks; the future dashboard UI consumes these for one-click actions.
      if (path.startsWith("/replies")) {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        return handleReplies(db, req, path.slice("/replies".length), auth.merchant_id);
      }

      // GET/PUT /settings — merchant settings
      if (path === "/settings") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const response = await handleSettings(db, req, auth.merchant_id);
        for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
        return response;
      }

      // GET/PUT /invoices/:id and /invoices/:id/trust-mode
      if (path.startsWith("/invoices/")) {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const response = await handleInvoices(db, req, path.slice("/invoices".length), auth.merchant_id);
        for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
        return response;
      }

      // GET /subscription — current merchant subscription
      if (path === "/subscription" && req.method === "GET") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const { getSubscriptionByMerchantId, isDevPro } = await import("./db");
        const sub = getSubscriptionByMerchantId(db, auth.merchant_id);
        if (sub) {
          return new Response(JSON.stringify(sub), {
            headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
          });
        }
        // Dev-only Pro preview flag (merchants.dev_pro=1): no subscription row,
        // but the merchant is entitled to Pro — return the same shape a paid
        // Pro merchant's /subscription returns (tier 'pro' + status 'active')
        // so the Stripe App drawer shows the paid OverviewView and the
        // dashboard renders the Pro plan state. `dev_pro: true` lets any UI
        // distinguish the preview from a real subscription.
        if (isDevPro(db, auth.merchant_id)) {
          return new Response(JSON.stringify({
            tier: "pro",
            status: "active",
            dev_pro: true,
            merchant_id: auth.merchant_id,
            stripe_subscription_id: null,
            stripe_customer_id: null,
            created_at: null,
          }), {
            headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ tier: null, status: "none" }), {
          headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
        });
      }

      // GET /overdue/summary — JSON summary of the merchant's overdue invoices
      // for the Stripe App drawer (counts + up to 20 invoices + recent
      // reminders). Session-authenticated like /subscription; every response
      // carries the CORS headers because the drawer fetches it from inside a
      // sandboxed iframe that sends Origin: null.
      if (path === "/overdue/summary" && req.method === "GET") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const { handleOverdueSummary } = await import("./routes/overdue-summary");
        return handleOverdueSummary(db, auth.merchant_id, req);
      }

      // POST/GET /billing/checkout - create Stripe Checkout Session. POST
      // (JSON body, returns {url}) is used by the JS subscribe() helper and
      // the site; GET (?tier=standard|pro) is the real-link entry used by the
      // dashboard "Free Drafts" stat card ("Upgrade for unlimited ->") and
      // redirects straight to Stripe Checkout.
      if (path === "/billing/checkout" && (req.method === "POST" || req.method === "GET")) {
        const auth = requireSession(db, req);
        if (auth instanceof Response) {
          // GET is a browser navigation (dashboard stat-card link): never show
          // a raw JSON auth error — bounce back to the dashboard gracefully.
          if (req.method === "GET") return new Response(null, { status: 302, headers: { Location: "/dashboard?billing=error" } });
          return auth;
        }
        const response = await handleBilling(db, req, "checkout", auth.merchant_id);
        for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
        return response;
      }

      // POST/GET /billing/portal - create Stripe Customer Portal session.
      // POST returns {url}; GET is the real-link entry for the dashboard stat
      // card's "Manage plan ->" (paid merchants) and 302-redirects to portal.
      if (path === "/billing/portal" && (req.method === "POST" || req.method === "GET")) {
        const auth = requireSession(db, req);
        if (auth instanceof Response) {
          // GET is a browser navigation (dashboard stat-card link): never show
          // a raw JSON auth error — bounce back to the dashboard gracefully.
          if (req.method === "GET") return new Response(null, { status: 302, headers: { Location: "/dashboard?billing=error" } });
          return auth;
        }
        const response = await handleBilling(db, req, "portal", auth.merchant_id);
        for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
        return response;
      }

      // POST /billing — our own Stripe Billing webhooks
      if (path === "/billing") {
        return handleBilling(db, req, "webhook");
      }

      // GET /stripe/connect — Stripe Connect OAuth redirect
      if ((path === "/stripe/connect" || path === "/api/stripe/connect") && req.method === "GET") {
        return handleStripeConnect(db, req);
      }

      // GET /stripe/oauth/callback — Stripe Connect OAuth callback
      // GET /oauth/callback — alias (matches manifest's allowed_redirect_uris as well)
      if ((path === "/stripe/oauth/callback" || path === "/oauth/callback" || path === "/api/oauth/callback") && req.method === "GET") {
        return handleStripeOAuthCallback(db, req);
      }

      // GET /oauth/session — cross-host session handoff (sets the www-host
      // session cookie for merchants who connected through the Stripe App;
      // first-party navigation so it works under third-party cookie blocking).
      // Served on ANY host — the same Railway service answers both
      // www.getcollectionscopilot.com and the Railway host — so the callback's
      // redirect target needs no host-specific routing.
      if (path === "/oauth/session" && req.method === "GET") {
        return handleOAuthSession(db, req);
      }

      // GET /oauth/handoff — self-healing cross-host session handoff: the
      // dashboard's JS bounces here (a top-level navigation to the Railway
      // host, where the session cookie lives) on its first 401. A valid
      // session 302s through /oauth/session on the www host (sets the www
      // cookie) and back to the dashboard; no session 302s straight to the
      // www dashboard, where the dashboard's one-shot cc_handoff guard stops
      // any redirect loop.
      if (path === "/oauth/handoff" && req.method === "GET") {
        return handleOAuthHandoff(db, req);
      }

      // GET /oauth/success — final "Stripe account connected" page of the
      // handoff chain, always served from the Railway host so the
      // oauth-complete postMessage keeps its current origin.
      if (path === "/oauth/success" && req.method === "GET") {
        return handleOAuthSuccess(req);
      }

      // GET /stripe/connection — current connection status
      if ((path === "/stripe/connection" || path === "/api/stripe/connection") && req.method === "GET") {
        const response = await handleStripeConnectionStatus(db);
        for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
        return response;
      }

      // GET /unsubscribe (also /api/unsubscribe — the site proxy strips the
      // /api prefix before forwarding to this backend) — CAN-SPAM opt-out.
      if ((path === "/unsubscribe" || path === "/api/unsubscribe") && req.method === "GET") {
        const unsubscribePage = (message: string, status = 200) =>
          new Response(
            `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribed — CollectionsCopilot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f8fa; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 40px 48px; max-width: 460px; margin: 24px; text-align: center; }
    h1 { font-size: 20px; margin: 0 0 12px; color: #1a1a2e; }
    p { font-size: 15px; line-height: 1.6; color: #4a4a68; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unsubscribed</h1>
    <p>${message}</p>
  </div>
</body>
</html>`,
            { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );

        const merchantParam = url.searchParams.get("merchant");
        const customerParam = url.searchParams.get("customer");
        if (!merchantParam || !customerParam) {
          return unsubscribePage("The unsubscribe link is invalid or incomplete. If you continue receiving emails, please reply to one to opt out.", 400);
        }
        const merchantId = Number.parseInt(merchantParam, 10);
        if (Number.isNaN(merchantId) || merchantId <= 0) {
          return unsubscribePage("The unsubscribe link is invalid. If you continue receiving emails, please reply to one to opt out.", 400);
        }

        // Only record the opt-out for a merchant we actually know — the FK on
        // unsubscribes.merchant_id requires it, and garbage params shouldn't
        // throw a 500. Unknown merchants still get the confirmation page.
        const merchantExists = db.query("SELECT id FROM merchants WHERE id = ?").get(merchantId);
        if (merchantExists) {
          recordUnsubscribe(db, merchantId, customerParam);
        }

        return unsubscribePage("You've been unsubscribed from CollectionsCopilot reminders. No further emails will be sent for this invoice.");
      }

      // GET /summary?merchantId=1 — weekly summary stats (default merchantId=1)
      if (path === "/summary" && req.method === "GET") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const { generateWeeklySummary } = await import("./pipeline/summary");
        const merchantId = auth.merchant_id;
        const summary = generateWeeklySummary(db, merchantId);
        return new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /summary/send — generate summary, send it, return formatted email
      if (path === "/summary/send" && req.method === "POST") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const { generateWeeklySummary } = await import("./pipeline/summary");
        const { formatSummaryEmail } = await import("./pipeline/summary-email");
        const { getMerchantById, logSend, isActivePaidSubscriber } = await import("./db");
        const { sendEmailForReal } = await import("./pipeline/sender");

        const merchantId = auth.merchant_id;

        // Weekly recovery reports are included with every PAID plan (Standard
        // and Pro) — homepage parity. There is no separate scheduled send
        // path today: this route is the only place summaries go out, and any
        // future scheduler must apply the same isActivePaidSubscriber() rule
        // before sending (must never send to free merchants). Read-only GET
        // /summary stays open to any authenticated user.
        if (!isActivePaidSubscriber(db, merchantId)) {
          return new Response(
            JSON.stringify({ error: "Weekly recovery reports require a subscription. Upgrade to unlock." }),
            { status: 402, headers: { "Content-Type": "application/json" } }
          );
        }

        const merchant = getMerchantById(db, merchantId);
        if (!merchant) {
          return new Response(JSON.stringify({ error: "Merchant not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Placeholder merchants (acct_default / default@collections-copilot.local
        // and other .local seeds) have no real, deliverable inbox — never treat
        // them as a weekly-summary send target. Skipping entirely (no send, no
        // send_logs row) means the dashboard can never show a fake "sent"
        // success and stats can never count a [STUB SEND] as a real send.
        const { isPlaceholderMerchant } = await import("./pipeline/notify");
        if (isPlaceholderMerchant(merchant)) {
          console.log(
            `[summary] merchant ${merchantId} (${merchant.email || "no email"}) is a placeholder — skipping weekly summary (no real email)`
          );
          return new Response(JSON.stringify({
            skipped: true,
            sentTo: merchant.email,
            sendResult: {
              success: false,
              skipped: true,
              message: "Weekly summary skipped — this account has no real email configured.",
            },
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        const summary = generateWeeklySummary(db, merchantId);
        const email = formatSummaryEmail(summary, merchant.stripe_account_id === "acct_default" ? "Merchant" : merchant.email);

        // Attempt real send
        let sendResult: { success: boolean; message: string; provider?: string } | null = null;
        try {
          sendResult = await sendEmailForReal(db, null, email, merchant.email);
          const status = sendResult.success ? "success" : "failed";
          logSend(db, 0, status, `Weekly summary ${sendResult.success ? "sent" : "failed"}: ${sendResult.message}`, "weekly_summary");
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          logSend(db, 0, "failed", `Weekly summary send error: ${errMsg}`, "weekly_summary");
          sendResult = { success: false, message: errMsg };
        }

        return new Response(JSON.stringify({
          summary,
          email,
          sentTo: merchant.email,
          sendResult,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /aggregate — cross-merchant aggregate recovery stats (internal dashboard, no auth)
      if (path === "/aggregate" && req.method === "GET") {
        const { handleAggregate } = await import("./routes/aggregate");
        const stats = handleAggregate(db);
        return new Response(JSON.stringify(stats), {
          status: 200,
          headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
        });
      }

      // /support/* — token-gated internal Support-agent APIs (Pro priority
      // support): GET /support/lookup?email=... and GET|POST /support/log.
      // Authenticated by the SUPPORT_API_TOKEN bearer token, NOT by a session
      // (the Support agent has no merchant session). When SUPPORT_API_TOKEN is
      // unset every request returns 403 — the API is effectively disabled.
      if (path.startsWith("/support/")) {
        return await handleSupport(db, req, path.slice("/support".length), url);
      }

      // /admin + /admin/data — owner-only internal customer-tracking dashboard
      // (page-visit analytics, merchant funnel, subscription event log).
      // Token-gated by ADMIN_TOKEN (?token= query param or Authorization:
      // Bearer header). When ADMIN_TOKEN is unset every request returns 403.
      // The gate runs BEFORE the method check so unknown methods can't probe
      // the route surface unauthenticated (same pattern as /support/*).
      // Deliberately NEVER linked from the public UI (no dashboard/site link,
      // no robots/sitemap exposure — the page also carries X-Robots-Tag:
      // noindex). Route order matters: /admin/data must match before /admin,
      // and both must sit BEFORE the marketing-site fallback so the site's
      // SPA handler can never swallow them.
      if (path === "/admin" || path === "/admin/data") {
        if (!requireAdminToken(req)) {
          return new Response(JSON.stringify({ error: "Unauthorized — missing or invalid ADMIN_TOKEN" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (req.method !== "GET") {
          return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (path === "/admin/data") return handleAdminData(db, req);
        return handleAdminPage(db, req);
      }

      // POST /api/track (also /track — the dev site proxy strips the /api
      // prefix before forwarding) — first-party privacy-minimal landing-page
      // visit tracking for the admin dashboard. Public by design: it exists to
      // collect visits, and stores only the non-identifying fields the snippet
      // sends (visitor_id UUID, page, referrer, utm_*, ts — no IP, no UA, no
      // cookies).
      if ((path === "/api/track" || path === "/track") && req.method === "POST") {
        return await handleTrack(db, req);
      }

      // ── Marketing site fallback ──
      // Everything not handled by a backend route is served by the built
      // TanStack Start site: static assets from dist/client first (GET only),
      // then the SSR handler for any method (the site's server functions are
      // POSTs to the page path, so non-GET requests must reach it too). The
      // handler serves the landing page at "/", /support, /privacy, /terms,
      // /about, and the SPA fallback itself.
      if (req.method === "GET") {
        const asset = await serveSiteAsset(path);
        if (asset) return asset;
      }
      const siteHandler = await getSiteHandler();
      if (siteHandler) {
        try {
          return await siteHandler.fetch(req);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[site] SSR handler error for ${req.method} ${path}:`, message);
        }
      }

      // 404 — return JSON, not plain text
      return new Response(JSON.stringify({
        error: "Not found",
        path,
        method: req.method,
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] ${req.method} ${path}:`, message);

      // Graceful JSON error response
      return new Response(JSON.stringify({
        error: "Internal server error",
        detail: message,
        path,
        method: req.method,
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
}

const server = Bun.serve({
  // Bind all interfaces — Railway's proxy runs outside the container and can
  // only reach services listening on 0.0.0.0, not loopback.
  hostname: "0.0.0.0",
  port: PORT,
  fetch: async (req) => {
    const response = await handleRequest(req);
    for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
    return response;
  },
});

console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
console.log(`   Dashboard: http://0.0.0.0:${PORT}/dashboard`);
console.log(`   Landing:   http://0.0.0.0:${PORT}/ (site SSR handler)`);
console.log(`   Health:    http://0.0.0.0:${PORT}/health`);
console.log(`   Stats:     http://0.0.0.0:${PORT}/stats`);
console.log(`   Webhook:   POST http://0.0.0.0:${PORT}/webhook`);
console.log(`   Tasks:     GET  http://0.0.0.0:${PORT}/tasks`);
console.log(`   Settings:  GET  http://0.0.0.0:${PORT}/settings`);
