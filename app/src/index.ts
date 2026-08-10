import { getDb, ensureDefaultMerchant, freeDraftsRemaining, recordUnsubscribe, countOverdueInvoices, invoiceLimitFor } from "./db";
import { handleWebhook } from "./routes/webhook";
import { handleTasks } from "./routes/tasks";
import { handleSettings } from "./routes/settings";
import { handleBilling } from "./routes/billing";
import { handleStripeConnect, handleStripeOAuthCallback, handleStripeConnectionStatus } from "./routes/oauth";
import { handleInvoices } from "./routes/invoices";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSession } from "./middleware/session";

// Railway injects PORT dynamically — honor it, fall back to 3002 for local dev.
const PORT = Number(process.env.PORT) || 3002;
const START_TIME = Date.now();
const allowedOrigins = new Set([
  "https://collectionscopilot.ctonew.app",
  "https://dashboard.stripe.com",
]);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowedOrigin = origin && allowedOrigins.has(origin)
    ? origin
    : "https://collectionscopilot.ctonew.app";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

// Load the dashboard HTML once at startup
const dashboardHtml = readFileSync(join(import.meta.dirname, "ui", "dashboard.html"), "utf-8");

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

// Token encryption status (OAuth tokens at rest)
if (process.env.TOKEN_ENCRYPTION_KEY) {
  console.log(`   Token encryption: enabled (AES-256-GCM)`);
} else {
  console.log(`   Token encryption: disabled (tokens stored in plaintext)`);
}

async function handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeadersFor(req) });
    const url = new URL(req.url);
    const path = url.pathname;

    const db = getDb();
    ensureDefaultMerchant(db);

    try {
      // GET / — serve dashboard
      if (path === "/" && req.method === "GET") {
        return new Response(dashboardHtml, {
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
        const uptime = Math.floor((Date.now() - START_TIME) / 1000);

        // Total invoices processed (any status)
        const totalInvoicesRow = db.query("SELECT COUNT(*) as count FROM invoices WHERE merchant_id=?").get(merchantId) as { count: number };
        const totalInvoices = totalInvoicesRow.count;
        const freeDrafts = freeDraftsRemaining(db, merchantId);

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

        // Weekly summary emails sent
        const summaryEmailsRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id=rt.id JOIN invoices i ON rt.invoice_id=i.id WHERE sl.type='weekly_summary' AND sl.status='success' AND i.merchant_id=?"
        ).get(merchantId) as { count: number };
        const summaryEmailsSent = summaryEmailsRow.count;

        // Active sequences (tasks in pending/drafted/reviewed)
        const activeSeqRow = db.query(
          "SELECT COUNT(*) as count FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE rt.status IN ('pending', 'drafted', 'reviewed') AND i.merchant_id=?"
        ).get(merchantId) as { count: number };
        const activeSequences = activeSeqRow.count;

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
          activeSequences,
          paidInvoices,
          overdueInvoices,
          invoiceLimit,
          overInvoiceLimit,
          free_drafts_remaining: freeDrafts,
          uptime,
          uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
          startedAt: new Date(START_TIME).toISOString(),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /webhook — Stripe webhook events
      if (path === "/webhook") {
        return handleWebhook(db, req);
      }

      // GET/POST /tasks... — task management
      if (path.startsWith("/tasks")) {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        return handleTasks(db, req, path.slice("/tasks".length), auth.merchant_id);
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
        const { getSubscriptionByMerchantId } = await import("./db");
        const sub = getSubscriptionByMerchantId(db, auth.merchant_id);
        return new Response(JSON.stringify(sub || { tier: null, status: "none" }), {
          headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
        });
      }

      // POST /billing/checkout — create Stripe Checkout Session
      if (path === "/billing/checkout" && req.method === "POST") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
        const response = await handleBilling(db, req, "checkout", auth.merchant_id);
        for (const [key, value] of Object.entries(corsHeadersFor(req))) response.headers.set(key, value);
        return response;
      }

      // POST /billing/portal — create Stripe Customer Portal session
      if (path === "/billing/portal" && req.method === "POST") {
        const auth = requireSession(db, req);
        if (auth instanceof Response) return auth;
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
console.log(`   Dashboard: http://0.0.0.0:${PORT}/`);
console.log(`   Health:    http://0.0.0.0:${PORT}/health`);
console.log(`   Stats:     http://0.0.0.0:${PORT}/stats`);
console.log(`   Webhook:   POST http://0.0.0.0:${PORT}/webhook`);
console.log(`   Tasks:     GET  http://0.0.0.0:${PORT}/tasks`);
console.log(`   Settings:  GET  http://0.0.0.0:${PORT}/settings`);
