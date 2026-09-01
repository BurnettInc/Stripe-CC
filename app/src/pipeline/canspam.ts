/**
 * CAN-SPAM compliance for automated reminder emails.
 *
 * Every commercial email must give recipients a working opt-out and disclose
 * the sender's physical business address. This module appends that footer to
 * any drafted body (AI-drafted or template fallback) right before sending —
 * see sender.ts.
 */

/** Fallback business address used when BUSINESS_ADDRESS is not configured. */
export const DEFAULT_BUSINESS_ADDRESS = "Collections Copilot — Texas, USA";

/**
 * Public opt-out endpoint. Defaults to the platform site (which proxies
 * /api/* to the backend); on a standalone deployment (Railway) set BASE_URL
 * so opt-out links point at the deployed backend's /api/unsubscribe instead.
 * (BASE_URL must be the origin without a trailing slash.)
 */
export const UNSUBSCRIBE_BASE_URL =
  process.env.BASE_URL
    ? `${process.env.BASE_URL}/api/unsubscribe`
    : "https://collectionscopilot.ctonew.app/api/unsubscribe";

/**
 * Append the CAN-SPAM compliance footer to an email body.
 *
 * @param body          The drafted email body (AI or template fallback).
 * @param merchantId    The merchant the reminder belongs to (unsubscribe scope).
 * @param customerEmail The recipient's email (unsubscribe scope).
 * @returns The body with the footer appended.
 */
export function appendCanspamFooter(
  body: string,
  merchantId: number,
  customerEmail: string,
): string {
  const address = process.env.BUSINESS_ADDRESS || DEFAULT_BUSINESS_ADDRESS;
  const unsubscribeUrl =
    `${UNSUBSCRIBE_BASE_URL}?merchant=${encodeURIComponent(String(merchantId))}` +
    `&customer=${encodeURIComponent(customerEmail)}`;

  const footer = [
    "---",
    "To stop receiving reminders for this invoice, reply to this email or use the opt-out link below.",
    `Unsubscribe: ${unsubscribeUrl}`,
    address,
  ].join("\n");

  return `${body.trimEnd()}\n\n${footer}\n`;
}
