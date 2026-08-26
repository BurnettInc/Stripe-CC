/**
 * Owner signup/subscription notifications (owner request 2026-08-12).
 *
 * Emails the OWNER — OWNER_NOTIFY_EMAIL (e.g. stripecopilot@outlook.com) — a
 * short plain-text alert whenever a merchant connects Stripe or subscribes to
 * a paid plan, plus a cheap cancellation alert. These are internal account
 * alerts for the owner: they go through the SAME Resend sender the product
 * uses for reminders (sendEmailForReal — never the team's AgentMail inbox, so
 * they work in production independent of this workspace), carry no CAN-SPAM
 * footer (no customer opt-out to honor), and are never sent to customers.
 *
 * Test/dev merchants are EXCLUDED so the owner gets no noise from our own
 * testing: dev_pro=1 flag, the acct_default placeholder account, and .local
 * placeholder emails — the same dev-flagging the admin dashboard uses.
 *
 * Disabled entirely when OWNER_NOTIFY_EMAIL is unset: no crash, no send, no
 * log row. Never throws into the caller — a failed owner email must never
 * break an OAuth callback or a billing webhook.
 */

import type { Database } from "bun:sqlite";
import { getMerchantById, logSend } from "../db";
import type { Merchant } from "../db";
import { sendEmailForReal } from "./sender";
import type { EmailDraft } from "./drafter";

export interface OwnerNotifyResult {
  success: boolean;
  message: string;
  /** True when the notification was deliberately not sent (no owner email / dev-test merchant). */
  skipped?: boolean;
}

/** The owner's notification inbox ('' when unset → notifications disabled). */
export function getOwnerNotifyEmail(): string {
  return (process.env.OWNER_NOTIFY_EMAIL || "").trim();
}

/**
 * Whether a merchant should be excluded from owner notifications (dev/test /
 * placeholder). Mirrors the admin dashboard's dev-flagging: dev_pro=1, the
 * acct_default placeholder account, or a .local placeholder email.
 * Unknown merchants are treated as dev/test (never notify).
 */
export function isDevOrTestMerchant(merchant: Merchant | null): boolean {
  if (!merchant) return true;
  if (Number(merchant.dev_pro) === 1) return true;
  if (merchant.stripe_account_id === "acct_default") return true;
  const email = (merchant.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return true;
  if (email.endsWith(".local")) return true;
  return false;
}

/** Human plan label with monthly price, matching the landing-page pricing. */
export function planLabel(tier: string): string {
  const t = (tier || "").toLowerCase();
  if (t === "standard") return "Standard ($7/mo)";
  if (t === "pro") return "Pro ($15/mo)";
  return tier;
}

/** Capitalized tier name for the cancellation subject (Standard / Pro). */
function planName(tier: string): string {
  const t = (tier || "").toLowerCase();
  if (t === "standard") return "Standard";
  if (t === "pro") return "Pro";
  return tier;
}

/** The admin dashboard URL for "details" links (token-gated, owner-only). */
function adminUrl(): string {
  return `${process.env.BASE_URL || "https://stripe-cc-production.up.railway.app"}/admin`;
}

/**
 * Deliver an owner notification via the product's sender and record the
 * outcome in send_logs (type 'owner_notification') — the same traceable
 * pattern notifyMerchant uses. No-ops when OWNER_NOTIFY_EMAIL is unset.
 * Never throws.
 */
async function sendOwnerNotification(
  db: Database,
  subject: string,
  body: string,
): Promise<OwnerNotifyResult> {
  const to = getOwnerNotifyEmail();
  if (!to) {
    return { success: false, message: "OWNER_NOTIFY_EMAIL not set — owner notifications disabled", skipped: true };
  }
  const draft: EmailDraft = { subject, body: body.trimEnd() + "\n" };
  try {
    const sendResult = await sendEmailForReal(db, null, draft, to, undefined, {
      skipCanspam: true,
    });
    const status = sendResult.success ? "success" : "failed";
    logSend(
      db,
      0,
      status,
      `Owner notification ${sendResult.success ? "sent" : "failed"}: ${sendResult.message}`,
      "owner_notification",
    );
    return { success: sendResult.success, message: sendResult.message };
  } catch (err: unknown) {
    const msg = `Owner notification error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[owner-notify] ${msg}`);
    try {
      logSend(db, 0, "failed", msg, "owner_notification");
    } catch {
      // Logging failed too — nothing more we can do; never throw to caller.
    }
    return { success: false, message: msg };
  }
}

/**
 * "New waitlist signup: <email>" — fired from POST /waitlist on a NEW signup
 * only (duplicates skip; the handler decides). Landing-page visitors are not
 * merchants, so there is no dev/test exclusion — every new signup notifies.
 * Never throws: sendOwnerNotification swallows and logs all failures.
 */
export async function notifyOwnerWaitlistSignup(
  db: Database,
  email: string,
  totalCount: number,
): Promise<OwnerNotifyResult> {
  const subject = `New waitlist signup: ${email}`;
  const body = [
    `A new visitor just joined the CollectionsCopilot waitlist.`,
    ``,
    `  Email:      ${email}`,
    `  Signed up:  ${new Date().toISOString()}`,
    `  Total list: ${totalCount}`,
    ``,
    `This is the opt-in they gave — email the list when the app is live.`,
  ].join("\n");
  return sendOwnerNotification(db, subject, body);
}
/**
 * "🎉 New signup — <email> connected Stripe" — fired from the OAuth callback
 * success path after a merchant finishes connecting. accountEmail (the Stripe
 * account holder's email, from the retrieved account object) is preferred for
 * the subject/body because it is the real signup email; merchant.email is the
 * fallback. Excludes dev/test merchants (isDevOrTestMerchant).
 */
export async function notifyOwnerStripeConnect(
  db: Database,
  merchantId: number,
  stripeAccountId: string,
  accountEmail?: string | null,
): Promise<OwnerNotifyResult> {
  const merchant = getMerchantById(db, merchantId);
  if (isDevOrTestMerchant(merchant)) {
    console.log(`[owner-notify] Skipping connect notification — merchant ${merchantId} is dev/test (${merchant?.email || "no email"})`);
    return { success: false, message: "dev/test merchant skipped", skipped: true };
  }

  const email = (accountEmail || merchant?.email || "unknown").trim();
  const subject = `🎉 New signup — ${email} connected Stripe`;
  const body = [
    `A new merchant just connected Stripe to CollectionsCopilot.`,
    ``,
    `  Email:        ${email}`,
    `  Stripe acct:  ${stripeAccountId}`,
    `  Plan:         free`,
    `  Connected at: ${new Date().toISOString()}`,
    ``,
    `Details: ${adminUrl()}`,
  ].join("\n");

  return sendOwnerNotification(db, subject, body);
}

/**
 * "💳 Paid subscription — <email> subscribed to <Plan> ($7/mo or $15/mo)" —
 * fired from the billing webhook's checkout.session.completed path when a
 * Standard/Pro subscription is actually created (not on idempotent replays).
 * Excludes dev/test merchants.
 */
export async function notifyOwnerPaidSubscription(
  db: Database,
  merchantId: number,
  tier: string,
  stripeCustomerId?: string | null,
): Promise<OwnerNotifyResult> {
  const merchant = getMerchantById(db, merchantId);
  if (isDevOrTestMerchant(merchant)) {
    console.log(`[owner-notify] Skipping paid-subscription notification — merchant ${merchantId} is dev/test`);
    return { success: false, message: "dev/test merchant skipped", skipped: true };
  }

  const label = planLabel(tier);
  const email = (merchant?.email || "unknown").trim();
  const subject = `💳 Paid subscription — ${email} subscribed to ${label}`;
  const body = [
    `A merchant just subscribed to a paid CollectionsCopilot plan.`,
    ``,
    `  Email:     ${email}`,
    `  Plan:      ${label}`,
    `  Customer:  ${stripeCustomerId || "n/a"}`,
    `  Subscribed at: ${new Date().toISOString()}`,
    ``,
    `Details: ${adminUrl()}`,
  ].join("\n");

  return sendOwnerNotification(db, subject, body);
}

/**
 * "❌ <email> canceled <Plan>" — fired from the billing webhook's
 * customer.subscription.deleted path. Nice-to-have cancellation alert;
 * excludes dev/test merchants.
 */
export async function notifyOwnerCancelledSubscription(
  db: Database,
  merchantId: number,
  tier: string,
): Promise<OwnerNotifyResult> {
  const merchant = getMerchantById(db, merchantId);
  if (isDevOrTestMerchant(merchant)) {
    console.log(`[owner-notify] Skipping cancellation notification — merchant ${merchantId} is dev/test`);
    return { success: false, message: "dev/test merchant skipped", skipped: true };
  }

  const email = (merchant?.email || "unknown").trim();
  const subject = `❌ ${email} canceled ${planName(tier)}`;
  const body = [
    `A merchant just canceled their CollectionsCopilot paid plan.`,
    ``,
    `  Email:  ${email}`,
    `  Plan:   ${planName(tier)}`,
    `  Canceled at: ${new Date().toISOString()}`,
    ``,
    `Details: ${adminUrl()}`,
  ].join("\n");

  return sendOwnerNotification(db, subject, body);
}
