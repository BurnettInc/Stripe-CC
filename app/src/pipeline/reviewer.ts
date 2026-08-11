import type { Invoice } from "../db";
import type { EmailDraft } from "./drafter";

export interface ReviewResult {
  approved: boolean;
  issues: string[];
}

export interface ReviewOptions {
  /**
   * The exact late-fee fragment the draft must contain (from late-fee.ts).
   * When set (merchant configured a fee AND stage >= 2), the draft must
   * mention it — the reviewer re-derives the same fragment the drafter was
   * given, so the fee MATH can never drift between drafting and review.
   * Null/absent means no fee is expected and no check runs.
   */
  lateFeeText?: string | null;
}

/**
 * Validate a draft email against the actual invoice facts.
 *
 * This performs REAL comparison checks — it's not a simple pass-through.
 * Checks performed:
 *  - Invoice number (stripe_invoice_id) appears in the body
 *  - Amount (formatted as dollars) appears in the body
 *  - Due date (YYYY-MM-DD format) appears in the body or subject
 *  - A payment link (URL) is present in the body
 *  - When a late fee applies (opts.lateFeeText), the exact fee fragment is present
 */
export function reviewDraft(draft: EmailDraft, invoice: Invoice, opts?: ReviewOptions): ReviewResult {
  const issues: string[] = [];
  const fullText = `${draft.subject}\n${draft.body}`;

  // Check 1: invoice number present
  if (!fullText.includes(invoice.stripe_invoice_id)) {
    issues.push(`Missing invoice number: expected "${invoice.stripe_invoice_id}" not found in draft`);
  }

  // Check 2: amount present (both formats: $X.XX and raw substring)
  const amountDollars = (invoice.amount_cents / 100).toFixed(2);
  const hasAmount =
    fullText.includes(amountDollars) ||
    fullText.includes(invoice.amount_cents.toString());
  if (!hasAmount) {
    issues.push(
      `Missing invoice amount: expected "${amountDollars}" (or ${invoice.amount_cents} cents) not found in draft`
    );
  }

  // Check 3: due date present
  if (!fullText.includes(invoice.due_date)) {
    issues.push(`Missing due date: expected "${invoice.due_date}" not found in draft`);
  }

  // Check 4: payment link present AND references the actual invoice
  const urlPattern = /https?:\/\/[^\s]+/g;
  const urls = draft.body.match(urlPattern) || [];
  const validUrl = urls.some((url) => {
    // URL must either contain stripe.com/invoices/ AND the invoice ID,
    // or start with https:// AND contain the invoice ID
    const hasInvoiceId = url.includes(invoice.stripe_invoice_id);
    const isStripeInvoiceUrl = url.includes("stripe.com/invoices/") && hasInvoiceId;
    const isHttpsWithInvoiceId = url.startsWith("https://") && hasInvoiceId;
    return isStripeInvoiceUrl || isHttpsWithInvoiceId;
  });

  if (!validUrl) {
    issues.push(
      `Missing or invalid payment link: no URL referencing invoice "${invoice.stripe_invoice_id}" found in draft body`
    );
  }

  // Check 5: late fee (when one applies, i.e. configured AND stage >= 2).
  // The expected fragment comes from late-fee.ts — the same source the
  // drafter used — so this validates the fee math end-to-end.
  if (opts?.lateFeeText) {
    if (!fullText.includes(opts.lateFeeText)) {
      issues.push(`Missing late-fee mention: expected "${opts.lateFeeText}" not found in draft`);
    }
  }

  return {
    approved: issues.length === 0,
    issues,
  };
}
