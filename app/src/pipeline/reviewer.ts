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

/** Any way a draft can bring up a fee for paying late. */
const LATE_FEE_PHRASE = /\blate[\s-]+(?:fee|fees|charge|charges|penalt(?:y|ies)|surcharge)\b/i;
/**
 * The exact defect the gate exists to stop (production reminder_task 71,
 * 2026-10-24): the drafter copied the prompt's "none" placeholder into a
 * sentence. There is no legitimate reading of "a late fee of none" — reject it
 * whether or not the merchant configured a fee.
 */
const LATE_FEE_OF_NONE = /\blate[\s-]+fee\s+(?:of\s+)?none\b/i;
/**
 * A late-fee mention that is explicitly NEGATED is legitimate copy ("no late
 * fee applies", "we don't charge a late fee") — a merchant may write that by
 * hand when editing a draft. Everything else that mentions a late fee when
 * none is configured is rejected.
 */
const LATE_FEE_NEGATED =
  /(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bnone\b|\bdoesn['’]?t\b|\bdon['’]?t\b|\bwon['’]?t\b|\bisn['’]?t\b|\bwasn['’]?t\b)[^.!?\n]{0,30}\blate[\s-]+(?:fee|fees|charge|charges|penalt(?:y|ies)|surcharge)\b|\blate[\s-]+(?:fee|fees|charge|charges|penalt(?:y|ies)|surcharge)\b[^.!?\n]{0,40}\b(?:does\s+not|doesn['’]?t|is\s+not|isn['’]?t|will\s+not|won['’]?t|was\s+not|wasn['’]?t|never)\b/i;

/** Split subject+body into sentence-ish segments for the late-fee scan. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The placeholder-late-fee defect on its own, exposed for send-time guards
 * (routes/tasks.ts POST /tasks/:id/approve re-checks a STORED draft, which was
 * reviewed before this gate existed). Returns a human-readable issue or null.
 */
export function placeholderLateFeeIssue(text: string): string | null {
  const m = LATE_FEE_OF_NONE.exec(text);
  return m ? `Placeholder late fee: "${m[0]}" — the word "none" can never be a fee amount` : null;
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

  // Check 5: late fee.
  // (a) "A late fee of none may apply per your payment terms" is ALWAYS a
  //     defect — the prompt's placeholder leaked into customer copy. Rejected
  //     regardless of the merchant's configuration.
  const ofNone = LATE_FEE_OF_NONE.exec(fullText);
  if (ofNone) {
    issues.push(
      `Placeholder late fee: "${ofNone[0]}" — a draft must never render the word "none" as a fee amount`
    );
  }
  const lateFeeExpected = typeof opts?.lateFeeText === "string" && opts.lateFeeText.trim() !== "";
  if (lateFeeExpected) {
    // (b) A fee IS configured (and applies at this stage): the exact fragment
    //     from late-fee.ts must be present, so the fee math can never drift
    //     between drafting and review.
    if (!fullText.includes(opts!.lateFeeText as string)) {
      issues.push(`Missing late-fee mention: expected "${opts!.lateFeeText}" not found in draft`);
    }
  } else {
    // (c) NO fee is configured: the draft must not contain a late-fee sentence
    //     at all (explicit negations like "no late fee applies" are allowed).
    for (const segment of sentences(fullText)) {
      if (!LATE_FEE_PHRASE.test(segment)) continue;
      if (LATE_FEE_NEGATED.test(segment)) continue;
      issues.push(
        `Unexpected late-fee sentence with no late fee configured: "${segment}"`
      );
    }
  }

  return {
    approved: issues.length === 0,
    issues,
  };
}
