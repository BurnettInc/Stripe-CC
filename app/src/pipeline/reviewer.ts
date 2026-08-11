import type { Invoice } from "../db";
import type { EmailDraft } from "./drafter";

export interface ReviewResult {
  approved: boolean;
  issues: string[];
}

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

/**
 * True when `text` mentions the invoice due date. Accepts the literal
 * YYYY-MM-DD string (what the templates emit) OR a human-readable rendering
 * of the same calendar day ("August 11, 2026", "Aug 11, 2026",
 * "11 August 2026"). LLMs frequently reformat dates into prose; the gate's
 * intent is that the draft names the CORRECT due date, not that it uses a
 * specific serialization — a wrong date still fails (exact month/day/year
 * must match).
 */
function mentionsDueDate(text: string, dueDate: string): boolean {
  if (text.includes(dueDate)) return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!m) return false;
  const [, year, month, day] = m;
  const monthIdx = parseInt(month, 10) - 1;
  const dayNum = parseInt(day, 10);
  if (monthIdx < 0 || monthIdx > 11 || !dayNum) return false;
  const full = MONTHS[monthIdx];
  const short = full.slice(0, 3);
  // "August 11, 2026" | "Aug 11, 2026" | "11 August 2026" | "11 Aug 2026"
  const re = new RegExp(
    `\\b(?:${full}|${short})\\.?\\s+${dayNum}(?:st|nd|rd|th)?,?\\s+${year}\\b|` +
    `\\b${dayNum}(?:st|nd|rd|th)?\\s+(?:${full}|${short})\\.?,?\\s+${year}\\b`,
    "i"
  );
  return re.test(text);
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

  // Check 3: due date present (literal ISO string or a rendering of the same day)
  if (!mentionsDueDate(fullText, invoice.due_date)) {
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
