import { getDb, ensureDefaultMerchant, resolveMerchant } from "./db";
import { handleWebhook } from "./routes/webhook";
import { handleTasks } from "./routes/tasks";
import { handleSettings } from "./routes/settings";
import { handleBilling } from "./routes/billing";
import { handleStripeConnect, handleStripeOAuthCallback, handleStripeConnectionStatus } from "./routes/oauth";
import { handleInvoices } from "./routes/invoices";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = 3001;
const START_TIME = Date.now();
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
  console.log(`   Webhook verification: disabled (test mode)`);
}

async function handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
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
        const uptime = Math.floor((Date.now() - START_TIME) / 1000);

        // Total invoices processed (any status)
        const totalInvoicesRow = db.query("SELECT COUNT(*) as count FROM invoices").get() as { count: number };
        const totalInvoices = totalInvoicesRow.count;

        // Total reminders sent (send_logs with type='reminder' and status='success')
        const remindersSentRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs WHERE type='reminder' AND status='success'"
        ).get() as { count: number };
        const remindersSent = remindersSentRow.count;

        // Total emails actually sent (non-stub — we check for provider_message NOT containing '[STUB SEND]')
        const emailsSentRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs WHERE status='success' AND type='reminder' AND provider_message NOT LIKE '%[STUB SEND]%'"
        ).get() as { count: number };
        const emailsSent = emailsSentRow.count;

        // Weekly summary emails sent
        const summaryEmailsRow = db.query(
          "SELECT COUNT(*) as count FROM send_logs WHERE type='weekly_summary' AND status='success'"
        ).get() as { count: number };
        const summaryEmailsSent = summaryEmailsRow.count;

        // Active sequences (tasks in pending/drafted/reviewed)
        const activeSeqRow = db.query(
          "SELECT COUNT(*) as count FROM reminder_tasks WHERE status IN ('pending', 'drafted', 'reviewed')"
        ).get() as { count: number };
        const activeSequences = activeSeqRow.count;

        // Paid invoices count
        const paidRow = db.query(
          "SELECT COUNT(*) as count FROM invoices WHERE status='paid'"
        ).get() as { count: number };
        const paidInvoices = paidRow.count;

        return new Response(JSON.stringify({
          totalInvoices,
          totalInvoicesProcessed: totalInvoices,
          remindersSent,
          emailsSent,
          summaryEmailsSent,
          activeSequences,
          paidInvoices,
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
        return handleTasks(db, req, path.slice("/tasks".length));
      }

      // GET/PUT /settings — merchant settings
      if (path === "/settings") {
        const response = await handleSettings(db, req);
        for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
        return response;
      }

      // GET /merchant — default merchant identity for checkout
      if (path === "/merchant" && req.method === "GET") {
        const merchant = resolveMerchant(db);
        if (!merchant) return new Response(JSON.stringify({ error: "No merchant found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ id: merchant.id, email: merchant.email }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET/PUT /invoices/:id and /invoices/:id/trust-mode
      if (path.startsWith("/invoices/")) {
        const response = await handleInvoices(db, req, path.slice("/invoices".length));
        for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
        return response;
      }

      // GET /subscription — current merchant subscription
      if (path === "/subscription" && req.method === "GET") {
        const { getSubscriptionByMerchantId } = await import("./db");
        const merchant = resolveMerchant(db);
        const sub = merchant ? getSubscriptionByMerchantId(db, merchant.id) : null;
        return new Response(JSON.stringify(sub || { tier: null, status: "none" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /billing/checkout — create Stripe Checkout Session
      if (path === "/billing/checkout" && req.method === "POST") {
        const response = await handleBilling(db, req, "checkout");
        for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
        return response;
      }

      // POST /billing — our own Stripe Billing webhooks
      if (path === "/billing") {
        return handleBilling(db, req, "webhook");
      }

      // GET /stripe/connect — Stripe Connect OAuth redirect
      if (path === "/stripe/connect" && req.method === "GET") {
        return handleStripeConnect(db, req);
      }

      // GET /stripe/oauth/callback — Stripe Connect OAuth callback
      if (path === "/stripe/oauth/callback" && req.method === "GET") {
        return handleStripeOAuthCallback(db, req);
      }

      // GET /stripe/connection — current connection status
      if (path === "/stripe/connection" && req.method === "GET") {
        const response = await handleStripeConnectionStatus(db);
        for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
        return response;
      }

      // GET /summary?merchantId=1 — weekly summary stats (default merchantId=1)
      if (path === "/summary" && req.method === "GET") {
        const { generateWeeklySummary } = await import("./pipeline/summary");
        const merchantId = parseInt(url.searchParams.get("merchantId") || "1", 10);
        const summary = generateWeeklySummary(db, merchantId);
        return new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /summary/send — generate summary, send it, return formatted email
      if (path === "/summary/send" && req.method === "POST") {
        const { generateWeeklySummary } = await import("./pipeline/summary");
        const { formatSummaryEmail } = await import("./pipeline/summary-email");
        const { getMerchantById, logSend } = await import("./db");
        const { sendEmailForReal } = await import("./pipeline/sender");

        const merchantId = parseInt(url.searchParams.get("merchantId") || "1", 10);
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
  port: PORT,
  fetch: async (req) => {
    const response = await handleRequest(req);
    for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
    return response;
  },
});

console.log(`✅ Server listening on http://localhost:${PORT}`);
console.log(`   Dashboard: http://localhost:${PORT}/`);
console.log(`   Health:    http://localhost:${PORT}/health`);
console.log(`   Stats:     http://localhost:${PORT}/stats`);
console.log(`   Webhook:   POST http://localhost:${PORT}/webhook`);
console.log(`   Tasks:     GET  http://localhost:${PORT}/tasks`);
console.log(`   Settings:  GET  http://localhost:${PORT}/settings`);
