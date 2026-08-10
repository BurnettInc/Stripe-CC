/**
 * Merchant account notifications.
 *
 * Sends the merchant themselves an alert about their own account (payment
 * received, sequence escalated, dispute filed, Stripe account deauthorized,
 * etc.). These are account notifications, NOT commercial reminders to
 * customers — so they intentionally carry no CAN-SPAM unsubscribe footer
 * (there is no customer opt-out to honor) but DO include a support contact
 * line. The triggers live in the webhook/pipeline code that calls
 * notifyMerchant; this module only knows how to deliver.
 */

import type { Database } from "bun:sqlite";
import { getMerchantById, logSend } from "../db";
import type { Merchant } from "../db";
import { sendEmailForReal } from "./sender";
import type { EmailDraft } from "./drafter";

/** Support contact line appended to every merchant notification. */
export const SUPPORT_CONTACT_LINE =
  "Questions about this alert? Reply to this email or contact support@getcollectionscopilot.com.";

export interface NotifyResult {
  success: boolean;
  message: string;
  /** True when the notification was deliberately not sent (no real email). */
  skipped?: boolean;
}

/**
 * Whether a merchant has a real, deliverable email address. The default
 * merchant (acct_default, email default@collections-copilot.local) is a
 * placeholder created by the sandbox — we must never fire real email at it.
 */
function isPlaceholderMerchant(merchant: Merchant): boolean {
  if (merchant.stripe_account_id === "acct_default") return true;
  const email = (merchant.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return true;
  if (email === "default@collections-copilot.local") return true;
  if (email.endsWith(".local")) return true;
  return false;
}

/**
 * Email the merchant an account alert.
 *
 * - Looks up the merchant; unknown merchant or placeholder email → logs a
 *   skip and returns quietly (never throws into the caller).
 * - Builds a short plain-text email from subject + body as passed, appending
 *   the support contact line (no CAN-SPAM footer — see module doc).
 * - Sends via sendEmailForReal (Resend → SendGrid → log-only fallback) and
 *   records the outcome in send_logs with type 'merchant_notification'.
 * - Never throws: send failures are caught, logged, and returned.
 */
export async function notifyMerchant(
  db: Database,
  merchantId: number,
  subject: string,
  body: string,
): Promise<NotifyResult> {
  let merchant: Merchant | null = null;
  try {
    merchant = getMerchantById(db, merchantId);
  } catch (err: unknown) {
    const msg = `Merchant lookup failed for merchant ${merchantId}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[notify] ${msg}`);
    return { success: false, message: msg };
  }

  if (!merchant) {
    const msg = `Merchant ${merchantId} not found — skipping notification`;
    console.warn(`[notify] ${msg}`);
    return { success: false, message: msg, skipped: true };
  }

  if (isPlaceholderMerchant(merchant)) {
    const msg = `Merchant ${merchantId} has no real email (${merchant.email || "none"}) — skipping notification`;
    console.log(`[notify] ${msg}`);
    return { success: false, message: msg, skipped: true };
  }

  const draft: EmailDraft = {
    subject,
    body: `${body.trimEnd()}\n\n${SUPPORT_CONTACT_LINE}\n`,
  };

  try {
    const sendResult = await sendEmailForReal(db, null, draft, merchant.email, undefined, {
      skipCanspam: true,
    });

    const status = sendResult.success ? "success" : "failed";
    logSend(
      db,
      0,
      status,
      `Merchant notification ${sendResult.success ? "sent" : "failed"}: ${sendResult.message}`,
      "merchant_notification",
    );

    return { success: sendResult.success, message: sendResult.message };
  } catch (err: unknown) {
    const msg = `Merchant notification error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[notify] ${msg}`);
    try {
      logSend(db, 0, "failed", msg, "merchant_notification");
    } catch {
      // Logging failed too — nothing more we can do; never throw to caller.
    }
    return { success: false, message: msg };
  }
}
