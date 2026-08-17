/**
 * Data rights (PROMISES_AUDIT #42, owner direction 2026-08-17): the privacy
 * page promises (1) "If you cancel your subscription, your data is deleted
 * within 30 days", (2) "You can request immediate deletion", and (3) "Request
 * a copy of your stored data / correction / deletion". This module implements
 * the two user-facing endpoints; the 30-day clock is started by the billing
 * webhook (routes/billing.ts) and the daily purge pass is a separate
 * scheduler build that calls purgeMerchantData (db.ts).
 *
 *   GET  /account/export (also /api/account/export) — JSON download of
 *        EVERYTHING stored for the merchant, keyed by table name. Attachment
 *        filename collectionscopilot-data-<merchant_id>.json. No data outside
 *        the merchant's own (the linked platform account's identity row is
 *        included — it is the user's own email).
 *   POST /account/delete (also /api/account/delete) — immediate, permanent
 *        deletion. If the merchant has an ACTIVE paid subscription it is
 *        cancelled via the Stripe API first (subscriptions.cancel) so the user
 *        is never billed for a deleted account; if the Stripe call fails the
 *        data is STILL purged and the failure is logged. Returns
 *        {ok:true, deleted:true} — the session row is gone after the purge, so
 *        the UI redirects to the landing page on the success response.
 *
 * Both are session-authed (requireSession — the merchant `session` cookie),
 * like every other dashboard route. The cc_account cookie is the platform
 * sign-in cookie and does NOT authorize these: the data being exported/deleted
 * is the MERCHANT's, and only the merchant session identifies it.
 */
import type { Database } from "bun:sqlite";
import { getSubscriptionByMerchantId, purgeMerchantData } from "../db";

// Stripe API base. STRIPE_API_BASE lets endpoint tests point the backend at a
// local stub instead of the real API; production keeps the default. Mirrors
// routes/billing.ts.
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, "");

interface StripeCancelResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

/** Cancel a Stripe subscription immediately (subscriptions.cancel with
 * cancel_at_period_end=false — end the plan now, don't let it run to the
 * period end). Returns the raw outcome; the caller decides whether to treat a
 * failure as blocking (it never is — purge proceeds regardless). */
async function cancelStripeSubscription(stripeSubscriptionId: string): Promise<StripeCancelResult> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return { ok: false, status: 503, data: { error: { message: "STRIPE_SECRET_KEY is not configured" } } };
  }
  try {
    const res = await fetch(`${STRIPE_API}/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "cancel_at_period_end=false",
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: { error: { message } } };
  }
}

/**
 * POST /account/delete — immediate purge of every row stored for the merchant.
 * Session-authed in index.ts. Best-effort Stripe subscription cancellation
 * first (only for an ACTIVE subscription row); the purge ALWAYS runs. After
 * the purge the merchant's session rows are gone, so the response is produced
 * first and the UI redirects to the landing page.
 */
export async function handleAccountDelete(db: Database, merchantId: number): Promise<Response> {
  const headers = { "Content-Type": "application/json" };
  const merchant = db.query("SELECT id FROM merchants WHERE id = ?").get(merchantId);
  if (!merchant) {
    return new Response(JSON.stringify({ error: "Merchant not found" }), { status: 404, headers });
  }

  // Cancel an active paid subscription first so the user is never billed for
  // a deleted account. If the cancel fails (network, expired key, unknown
  // sub), LOG the failure and still purge — the user asked for deletion, and
  // a stuck Stripe call must not hold their data hostage.
  const sub = getSubscriptionByMerchantId(db, merchantId);
  if (sub && sub.status === "active" && sub.stripe_subscription_id) {
    try {
      const result = await cancelStripeSubscription(sub.stripe_subscription_id);
      if (result.ok) {
        console.log(
          `[account/delete] Cancelled Stripe subscription ${sub.stripe_subscription_id} (tier=${sub.tier}) for merchant ${merchantId} before purge`
        );
      } else {
        console.error(
          `[account/delete] Stripe subscription cancel FAILED for merchant ${merchantId} (sub ${sub.stripe_subscription_id}): status=${result.status} ${JSON.stringify(result.data).slice(0, 300)} — purging data anyway`
        );
      }
    } catch (err: unknown) {
      console.error(
        `[account/delete] Stripe subscription cancel threw for merchant ${merchantId}: ${err instanceof Error ? err.message : String(err)} — purging data anyway`
      );
    }
  } else {
    console.log(
      `[account/delete] Merchant ${merchantId} has no active paid subscription to cancel (status=${sub?.status ?? "none"}) — purging directly`
    );
  }

  purgeMerchantData(db, merchantId);
  console.log(`[account/delete] Purged ALL data for merchant ${merchantId}`);
  return new Response(JSON.stringify({ ok: true, deleted: true }), { status: 200, headers });
}

/**
 * GET /account/export — JSON download of everything stored for the merchant,
 * keyed by table name (the full merchant-scoped inventory: sessions,
 * oauth_tokens, stripe_connections, invoices, reminder_tasks, send_logs,
 * subscriptions, unsubscribes, inbound_replies, subscription_events) plus the
 * linked platform account identity row (the user's own email). OAuth access
 * tokens are the merchant's own credentials for their own Stripe account —
 * their data to export. Transient auth infrastructure (account_magic_links,
 * account_sessions, oauth_install_states) is deliberately NOT included: those
 * are one-time login/CSRF tokens, not merchant data (they ARE deleted by
 * purgeMerchantData). Attachment download so the browser saves the file
 * instead of rendering it.
 */
export function handleAccountExport(db: Database, merchantId: number): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="collectionscopilot-data-${merchantId}.json"`,
  };
  const merchant = db.query("SELECT * FROM merchants WHERE id = ?").get(merchantId) as
    | (Record<string, unknown> & { account_id?: number | null })
    | null;
  if (!merchant) {
    return new Response(JSON.stringify({ error: "Merchant not found" }), { status: 404, headers });
  }

  const exportData: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    merchant,
    account:
      merchant.account_id != null
        ? db.query("SELECT id, email, created_at, last_login_at FROM accounts WHERE id = ?").get(merchant.account_id) ?? null
        : null,
    sessions: db
      .query("SELECT token, created_at, expires_at FROM sessions WHERE merchant_id = ?")
      .all(merchantId),
    oauth_tokens: db
      .query(
        "SELECT stripe_user_id, stripe_publishable_key, livemode, link_type, expires_at, created_at, updated_at FROM oauth_tokens WHERE merchant_id = ?"
      )
      .all(merchantId),
    stripe_connections: db
      .query("SELECT id, stripe_publishable_key, created_at, updated_at FROM stripe_connections WHERE merchant_id = ?")
      .all(merchantId),
    invoices: db.query("SELECT * FROM invoices WHERE merchant_id = ?").all(merchantId),
    reminder_tasks: db
      .query("SELECT rt.* FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id = i.id WHERE i.merchant_id = ?")
      .all(merchantId),
    send_logs: db
      .query(
        "SELECT sl.* FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id JOIN invoices i ON rt.invoice_id = i.id WHERE i.merchant_id = ?"
      )
      .all(merchantId),
    subscriptions: db.query("SELECT * FROM subscriptions WHERE merchant_id = ?").all(merchantId),
    unsubscribes: db
      .query("SELECT id, customer_email, created_at FROM unsubscribes WHERE merchant_id = ?")
      .all(merchantId),
    inbound_replies: db.query("SELECT * FROM inbound_replies WHERE merchant_id = ?").all(merchantId),
    subscription_events: db.query("SELECT * FROM subscription_events WHERE merchant_id = ?").all(merchantId),
  };

  return new Response(JSON.stringify(exportData, null, 2), { status: 200, headers });
}
