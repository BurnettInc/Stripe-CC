/**
 * Reply detection v1 — deterministic keyword/pattern classification of inbound
 * customer replies (owner 8/18; pulled forward to clear the board).
 *
 * Purpose: the reply-pause pipeline already auto-pauses + cancels tasks on ANY
 * reply. This module ADDS a clear, honest, actionable classification of WHAT
 * the customer said, so the merchant gets a useful flag instead of a bare
 * "sequence paused" notification.
 *
 * Design rules:
 *   1. Deterministic v1 — keyword/pattern matching only. NO new NLP dependency,
 *      no network, no external service. Pure functions, unit-testable.
 *   2. Conservative ("honesty guard") — when in doubt, `ambiguous`. We NEVER
 *      guess a payment claim: the pattern lists require explicit payment
 *      language ("already paid", "payment sent", "will pay", …), and a small
 *      negative filter ("pay attention") keeps non-payment uses out.
 *   3. Exactly one classification per reply, priority-ordered:
 *        promise_to_pay  — future commitment WITH a date ("I'll pay Friday",
 *                          "end of month", "next week", "on the 15th"). The
 *                          mentioned date is extracted (rough) for the flag.
 *        payment_claim   — customer says they already paid / a payment is in
 *                          flight / they WILL pay without a specific date
 *                          ("already paid", "payment sent", "check is in the
 *                          mail", "paid yesterday", "will pay", …).
 *                          NEVER auto-send follow-ups (existing hard rule —
 *                          this classification only powers merchant flags).
 *        dispute         — challenge/argument over the invoice, amount, or
 *                          service ("I never got this", "this isn't mine",
 *                          "overcharged", "I dispute", …). NEVER auto-send.
 *        question        — a question about the invoice/details.
 *        ambiguous       — everything else / cannot tell (→ merchant review).
 *   4. Purely additive to the AI layer (reply-ai.ts): the detect result lives
 *      in its own columns (detect_classification / detect_extracted_date /
 *      action_flag) and NEVER changes the AI `classification` column, send
 *      behavior, escalation ladder, Trust Mode, or the hard
 *      payment_claim/dispute never-auto-send invariant.
 *
 * The flag copy (replyActionFlag) is the exact owner-approved text surfaced in
 * the merchant notification email, the /replies review queue, and the
 * dashboard task rows.
 */

export const DETECT_CLASSIFICATIONS = [
  "payment_claim",
  "promise_to_pay",
  "dispute",
  "question",
  "ambiguous",
] as const;

export type DetectClassification = (typeof DETECT_CLASSIFICATIONS)[number];

export interface DetectResult {
  classification: DetectClassification;
  /** Roughly-extracted date mention (promise_to_pay only; e.g. "Friday", "end of the month"). */
  extracted_date: string | null;
}

// ── Pattern lists (all tested against the lowercased subject + body) ──

/**
 * Future commitment with a date. Each pattern must ALSO co-occur with a date
 * pattern (extractDate) for the reply to classify as promise_to_pay.
 */
const FUTURE_COMMITMENT: RegExp[] = [
  /\b(?:i'?ll|will|gonna|going to|plan to|promise to|intend to|will be) (?:pay|send|make|transfer|wire|settle|get .{0,15}paid)/,
  /\bpay(?:ing)? (?:on|by|before|after|within|at the end|end of|next|this|in |in the|today|tomorrow)/,
  /\bpay(?:ing)? (?:it|this|the (?:invoice|bill|balance|full|outstanding)) (?:on|by|before|after|within|at the end|end of|next|this|in |in the|today|tomorrow)/,
  /\bpayment (?:on|by|before|after|within|at the end|end of|next|this|in |in the|will (?:go|be|goes|is)|is going)/,
  /\bsend(?:ing)? (?:the |a |an )?(?:payment|check|wire|transfer|money|funds) (?:on|by|before|after|within|at the end|end of|next|this|in |in the|today|tomorrow)/,
  /\bsettle (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\btake care of (?:it|this|the (?:invoice|bill|balance)) (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\bsort (?:it|this|out) (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\bget (?:this|it|the (?:invoice|bill|balance)) (?:paid|settled|sorted) (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\bwill have (?:it|this|the (?:invoice|bill|balance)) (?:paid|settled) (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\btransfer(?:ring)? (?:the |a |an )?(?:payment|funds|money|wire) (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\bwire(?:ing)? (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
  /\bwire(?:ing)? (?:the |a |an )?(?:payment|money|funds) (?:on|by|before|after|at the end|end of|next|this|within|in |in the|today|tomorrow)/,
];

/**
 * Clear past-tense payment claims / payments in flight. These win over every
 * other category: "I already paid" is the most specific, fact-based statement
 * a customer can make in this context.
 */
const PAST_CLAIM: RegExp[] = [
  /\balready paid\b/,
  /\bjust paid\b/,
  /\bi paid\b/,
  /\bi'?ve paid\b/,
  /\bhave paid\b/,
  /\bhas been paid\b/,
  /\bwas paid\b/,
  /\bit(?:'s| is) paid\b/,
  /\bpaid it\b/,
  /\bpaid the\b/,
  /\bpaid this\b/,
  /\bpaid in full\b/,
  /\bpaid off\b/,
  /\bpaid on\b/,
  /\bpaid via\b/,
  /\bpaid already\b/,
  /\bpaid (?:yesterday|today|earlier|already|last [a-z]+|this (?:morning|week|month))\b/,
  /\bpaid for it\b/,
  /\bpaid the full\b/,
  /\bpayment sent\b/,
  /\bpayment was sent\b/,
  /\bpayment has been sent\b/,
  /\bsent (?:the )?(?:payment|money|funds|wire|check)\b/,
  /\balready sent\b/,
  /\bcheck is in the mail\b/,
  /\bcheck in the mail\b/,
  /\bin the mail\b/,
  /\bmailed\b/,
  /\bmade (?:the|a) payment\b/,
  /\bpayment was made\b/,
  /\bpayment has been made\b/,
  /\bwired\b/,
  /\bpayment is on (?:its|the) way\b/,
  /\bpayment on (?:its|the) way\b/,
  /\bpayments? (?:went|has gone|have gone) (?:out|through)\b/,
];

/**
 * Generic payment intent WITHOUT a date ("will pay", "going to pay",
 * "pay it soon", …). Per the owner spec these are payment claims (the
 * distinction from promise_to_pay is the presence of a date).
 */
const GENERIC_PAYMENT: RegExp[] = [
  /\b(?:i'?ll|will|gonna|going to|plan to|promise to|intend to) pay\b/,
  /\b(?:i'?ll|will|gonna|going to|plan to) (?:send|make|transfer|wire) (?:the |a |an )?(?:payment|transfer|wire|check|money|funds)\b/,
  /\b(?:i'?ll|will|gonna|going to|plan to) settle\b/,
  /\bpay(?:ing)? (?:it|this|the (?:invoice|bill|balance|full amount)) (?:soon|shortly|right away|asap|immediately)\b/,
  /\bpayment (?:is )?(?:coming|going out|will (?:come|be made|go out))\b/,
  /\bpayment will be (?:sent|made|transferred)\b/,
  /\bcan pay\b/,
  /\bcan (?:send|make|transfer|wire) (?:the |a |an )?(?:payment|transfer|wire|check|money|funds)\b/,
  /\bwould (?:like to )?pay\b/,
];

/** Disputes / challenges over the invoice, amount, or service. */
const DISPUTE: RegExp[] = [
  /\bdisput(?:e|es|ing|ed)\b/,
  /\bnever (?:got|received)\b/,
  /\bdid(?:n't| not) (?:receive|get|order|buy|sign up|authorize|authorise|approve|request)\b/,
  /\bwas(?:n't| not) (?:delivered|provided|supplied|fulfilled)\b/,
  /\bnever (?:delivered|provided|supplied|fulfilled|ordered|bought|signed up)\b/,
  /\b(?:is|it'?s) not (?:mine|my (?:invoice|bill|charge|order|account))\b/,
  /\b(?:isn'?t|not) mine\b/,
  /\bnot my (?:invoice|bill|charge|order|account)\b/,
  /\bovercharg(?:e|ed|ing)\b/,
  /\bover charg(?:e|ed|ing)\b/,
  /\bcharged (?:me )?twice\b/,
  /\bdouble charg(?:e|ed|ing)\b/,
  /\bunauthori[sz]ed\b/,
  /\bfraud(?:ulent)?\b/,
  /\bdon'?t recognize\b/,
  /\bdo not recognize\b/,
  /\bwrong (?:amount|charge|invoice|bill)\b/,
  /\bincorrect (?:amount|charge|invoice|bill)\b/,
  /\bshould(?:n't| not) be charged\b/,
  /\b(?:need|want|asked for|requested) a refund\b/,
  /\brefund me\b/,
  /\brefund the\b/,
  /\bcancel (?:this|the) charge\b/,
  /\bremove (?:this|the) charge\b/,
  /\bcomplaint\b/,
  /\bnever agreed\b/,
  /\bdid(?:n't| not) agree\b/,
  /\bnot (?:happy|satisfied) with (?:the|your|this) (?:service|product|work|invoice|delivery)\b/,
  /\bno such (?:invoice|charge|order|bill)\b/,
  /\bi never (?:made|authorized|authorised|signed up for|bought|ordered|received)\b/,
  /\bstop charging me\b/,
  /\bdon'?t charge me\b/,
];

/** Questions / information requests about the invoice or details. */
const QUESTION: RegExp[] = [
  /\?/,
  /(?:^|[.!?]\s+)(?:what|why|when|where|who|which|how)\b/,
  /\bwhat(?:'s| is| was) (?:my|the|a)\b/,
  /\bwhen (?:was|is|did|will|would)\b/,
  /\bhow (?:much|many|long|do|does|did|can|would|will)\b/,
  /\b(?:can|could|would) (?:you|i|we)\b/,
  /\b(?:do|did) you\b/,
  /\bdoes (?:this|that|it)\b/,
  /\bis (?:there|this|it|that)\b/,
  /\bare (?:there|you|we)\b/,
  /\bwas (?:this|it|that)\b/,
  /\bhave you\b/,
  /\bplease (?:send|explain|tell|provide|share|show|clarify|confirm|let me know|advise)\b/,
  /\b(?:send|email|forward|share) me (?:the|a|my|an)\b/,
  /\bi(?:'d| would) like (?:to know|the|a)\b/,
  /\bi (?:was|am) wondering\b/,
  /\bquestion\b/,
  /\b(?:what'?s|what is) my (?:balance|total|amount|bill)\b/,
];

/**
 * Negative filters: phrases that contain payment words but are NOT a payment
 * claim. The honesty guard — when in doubt, ambiguous — lives here.
 */
const PAYMENT_NEGATIVES: RegExp[] = [
  /\bpay attention\b/,
  /\bpaid attention\b/,
  /\bpay tribute\b/,
  /\bpayday\b/,
];

// ── Rough date extraction (v1) ──

const DATE_PATTERNS: RegExp[] = [
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  /\bend of (?:the )?(?:month|week|year)\b/,
  /\b(?:next|this) (?:week|month|year)\b/,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  /\b\d{1,2}(?:st|nd|rd|th)\b/,
  /\b(tomorrow|tonight|today)\b/,
  /\bin (?:a few|a couple of|two|three|one|a|several|ten|fourteen) (?:days?|weeks?|months?)\b/,
];

/**
 * Extract the FIRST rough date mention from a lowercased string. Returns the
 * original-cased substring so the flag reads naturally ("Friday", not
 * "friday").
 */
function extractDate(rawText: string, lowerText: string): string | null {
  for (const re of DATE_PATTERNS) {
    const m = re.exec(lowerText);
    if (m) {
      // m.index is valid on the lowercased string (same length/positions).
      return rawText.slice(m.index, m.index + m[0].length);
    }
  }
  return null;
}

/**
 * Deterministic v1 classifier. Takes the raw reply text (subject + body, any
 * case) and returns exactly one classification + optional extracted date.
 *
 * Priority: promise_to_pay (future + date) → payment_claim (clear past / in
 * flight / will-pay) → dispute → generic payment (will-pay, no date) →
 * question → ambiguous. NEVER guesses: no match → ambiguous.
 */
export function classifyReplyDetect(text: string): DetectResult {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();

  const hasFuture = FUTURE_COMMITMENT.some((re) => re.test(lower));
  if (hasFuture) {
    const date = extractDate(raw, lower);
    if (date) {
      return { classification: "promise_to_pay", extracted_date: date };
    }
  }

  const isPaymentContext = !PAYMENT_NEGATIVES.some((re) => re.test(lower));
  if (isPaymentContext && PAST_CLAIM.some((re) => re.test(lower))) {
    return { classification: "payment_claim", extracted_date: null };
  }

  if (DISPUTE.some((re) => re.test(lower))) {
    return { classification: "dispute", extracted_date: null };
  }

  if (isPaymentContext && GENERIC_PAYMENT.some((re) => re.test(lower))) {
    return { classification: "payment_claim", extracted_date: null };
  }

  if (QUESTION.some((re) => re.test(lower))) {
    return { classification: "question", extracted_date: null };
  }

  return { classification: "ambiguous", extracted_date: null };
}

// ── Merchant-facing labels + actionable flags (owner-approved copy) ──

const DETECT_LABELS: Record<DetectClassification, string> = {
  payment_claim: "payment claim",
  promise_to_pay: "promise to pay",
  dispute: "dispute",
  question: "question",
  ambiguous: "ambiguous",
};

/** Human label for the notification subject / dashboard ("payment claim", …). */
export function detectLabel(classification: DetectClassification): string {
  return DETECT_LABELS[classification] ?? classification;
}

/**
 * The actionable flag text the merchant sees (notification email, /replies
 * queue, dashboard). Exact owner-approved copy:
 *   payment_claim → "Customer says they paid — verify in Stripe, then close or resume."
 *   promise_to_pay → "Customer promises payment by <date> — resume after that date if still unpaid."
 *   dispute → "Customer disputes the invoice — handle personally; sequence stays paused."
 *   question → "Customer asked a question — reply directly; sequence paused."
 *   ambiguous → "Couldn't classify — review the reply."
 */
export function replyActionFlag(classification: DetectClassification, extractedDate: string | null): string {
  switch (classification) {
    case "payment_claim":
      return "Customer says they paid — verify in Stripe, then close or resume.";
    case "promise_to_pay":
      return extractedDate
        ? `Customer promises payment by ${extractedDate} — resume after that date if still unpaid.`
        : "Customer promises payment — resume after the promised date if still unpaid.";
    case "dispute":
      return "Customer disputes the invoice — handle personally; sequence stays paused.";
    case "question":
      return "Customer asked a question — reply directly; sequence paused.";
    case "ambiguous":
      return "Couldn't classify — review the reply.";
  }
}
