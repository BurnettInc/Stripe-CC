/**
 * Copy for the free-trial expiry email arc (engine in pipeline/trial-expiry.ts).
 *
 * ✅ OWNER-APPROVED VERBATIM — 2026-10-27.
 *
 * Every string below is the owner's approved wording, copied word-for-word from
 * the approved copy package (the standing rule, owner 2026-10-12: no email to
 * any merchant/customer goes out without the owner's explicit pre-approval of
 * that specific message). Do NOT reword, reorder, shorten or "improve"
 * anything here without a new owner approval — the only substitutions the
 * approval allows are:
 *
 *   1. the documented merge field {{expiry_date}} (the trial end date, UTC,
 *      e.g. "November 9, 2026";
 *   2. the CTA hrefs — the approved "[Choose a plan →]" / "[Subscribe to
 *      resume →]" tokens get the live checkout URL appended at render time
 *      (TRIAL_BILLING_PATH below — the same route the dashboard's own
 *      subscribe CTA points at);
 *   3. the shared opt-out line (TRIAL_EMAIL_OPT_OUT) appended once at the end
 *      of every body, after the approved signature.
 *
 * Touchpoint arc (owner sign-off 2026-10-26 after a research pass):
 *
 *   ACTIVE track (the merchant has at least one synced invoice OR one draft —
 *   they are actually using the product):
 *     t_minus_7 → "ends next week" heads-up
 *     t_minus_3 → value reminder
 *     t_minus_1 → "ends tomorrow"
 *     t_zero    → "ends today" expiry notice
 *
 *   IDLE track (zero synced invoices AND zero drafts — they connected but
 *   never did anything, so T-7/T-1 would be noise):
 *     mid_trial_checkin → one "getting started" check-in (~day 10 of trial)
 *     t_minus_3         → the idle-track value reminder (IDLE_OVERRIDES below)
 *     t_zero            → "ends today" expiry notice
 *
 *   BOTH tracks:
 *     t_plus_3 → optional win-back, up to 3 days after the trial lapsed
 *                ("reminders paused — subscribe to resume"). Only sent while
 *                the merchant is STILL unsubscribed (the pass re-checks for an
 *                active paid subscription every tick). The day-30 lock itself
 *                stays strict — t_plus_3 is a pure win-back note, never a
 *                grace period.
 *
 * Merge fields are resolved by renderTemplate() from TrialExpiryMergeFields:
 *   {{greetingName}}  — first name if we had one; the schema stores no name,
 *                       so this is the merchant's email local-part or "there"
 *   {{merchantEmail}} — the merchant's account email
 *   {{expiry_date}}   — the trial end date, UTC, e.g. "November 9, 2026"
 *                       (the approved copy's spelling of the field; the
 *                       camelCase {{expiryDate}} alias still resolves)
 *   {{daysLeft}}      — 7 / 3 / 1 / 0 (0 on the t_zero and t_plus_3 notices)
 *   {{trialDays}}     — FREE_TRIAL_DAYS (30)
 *   {{dashboardUrl}}  — the merchant dashboard
 *   {{supportEmail}}  — support@getcollectionscopilot.com
 *   {{billingUrl}}    — the live checkout page (CTA target)
 *
 * The body carries its OWN opt-out line: these are merchant-facing
 * account/announcement emails, not invoice-scoped customer reminders, so the
 * invoice-scoped CAN-SPAM footer in pipeline/canspam.ts ("To stop receiving
 * reminders for this invoice") would be wrong here — the send path passes
 * skipCanspam. The approved opt-out line is what makes that safe, so every
 * body must keep it.
 */

/** Sender identity for the trial arc — the same support@ identity the welcome
 *  emails used (continuity the owner recognised). The approved copy package
 *  specifies exactly this sender, as "Collections Copilot". */
export const TRIAL_EMAIL_FROM = "support@getcollectionscopilot.com";
/** Support address quoted inside the bodies. */
export const TRIAL_EMAIL_SUPPORT = "support@getcollectionscopilot.com";

/** The approved signature line that closes every body. */
export const TRIAL_EMAIL_SIGNATURE = "— Collections Copilot";

/**
 * The approved opt-out line — part of the owner-approved package and REQUIRED
 * at the end of every email in this arc (the send path skips the
 * invoice-scoped CAN-SPAM footer, so this is the merchant's only opt-out).
 * Appended once, by trialBody(), never pasted mid-body.
 */
export const TRIAL_EMAIL_OPT_OUT =
  'Don\'t want trial reminders? Reply with "unsubscribe" and we\'ll stop sending them.';

/**
 * Where the approved CTA tokens point: the dashboard's own subscribe CTA
 * (`/billing/checkout?tier=standard` — see ui/dashboard.html and
 * ui/messages.html), resolved against the app's BASE_URL.
 */
export const TRIAL_BILLING_PATH = "/billing/checkout?tier=standard";

/**
 * The two CTA tokens exactly as the owner approved them. The visible text is
 * never changed; renderTemplate() appends the checkout URL after each token so
 * the plain-text email carries a real, clickable link.
 */
export const TRIAL_CTA_TOKENS: readonly string[] = ["[Choose a plan →]", "[Subscribe to resume →]"];

/** The six touchpoints of the arc (one template each). */
export type TrialTouchpoint =
  | "mid_trial_checkin"
  | "t_minus_7"
  | "t_minus_3"
  | "t_minus_1"
  | "t_zero"
  | "t_plus_3";

/** Which arc a merchant is on (see the module doc). */
export type TrialTrack = "active" | "idle";

/** Values substituted into {{merge_field}} tokens. */
export interface TrialExpiryMergeFields {
  /** Greeting name — the email local-part, or "there" when there is none. */
  greetingName: string;
  merchantEmail: string;
  /** Trial end date in UTC, e.g. "November 9, 2026". */
  expiryDate: string;
  /** Whole days of trial left at this touchpoint (7/3/1/0). */
  daysLeft: number;
  trialDays: number;
  dashboardUrl: string;
  supportEmail: string;
  /** Live checkout page — the approved CTA tokens link here. */
  billingUrl: string;
  track: TrialTrack;
}

export interface TrialCopyTemplate {
  subject: string;
  body: string;
}

/**
 * Build a body: the approved lines (ending with the signature), then a blank
 * line and the shared approved opt-out line. Used for every template so the
 * opt-out can never be forgotten or duplicated.
 */
function trialBody(lines: readonly string[]): string {
  return [...lines, "", TRIAL_EMAIL_OPT_OUT].join("\n");
}

/** The templates, one per touchpoint — owner-approved wording, verbatim. */
export const TRIAL_EXPIRY_COPY: Record<TrialTouchpoint, TrialCopyTemplate> = {
  // 1) Mid-trial check-in — IDLE merchants only (~day 10 of the trial)
  mid_trial_checkin: {
    subject: "Getting started with your Collections Copilot trial",
    body: trialBody([
      "Hello,",
      "",
      "You connected Stripe to Collections Copilot a few days ago — you're all set up, and your 30-day trial is fully active.",
      "",
      "If you haven't yet, the quickest way to see it in action: create or find an overdue invoice in Stripe. Copilot will draft a friendly reminder for it in English (we turn collections-ese into plain language), and you stay in control of what gets sent.",
      "",
      "A few honest facts so you know where things stand:",
      "- Drafting reminders is free forever, even after the trial.",
      "- Sending reminders requires a plan — that's the one thing the trial unlocks free for 30 days.",
      "- Your trial gives you full access through {{expiry_date}}. No card was requested, and nothing will be charged at the end.",
      "",
      "If you hit a snag or want to set things up over a quick email, just reply — a human reads this inbox.",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },

  // 2) T-7 heads-up — ACTIVE merchants (6–7 days before expiry)
  t_minus_7: {
    subject: "Your free trial ends {{expiry_date}}",
    body: trialBody([
      "Hello,",
      "",
      "Quick heads-up: your Collections Copilot free trial ends on {{expiry_date}}.",
      "",
      "Until then, everything is on — reminders to your customers keep drafting and sending automatically on your schedule.",
      "",
      "What happens after {{expiry_date}} if you don't subscribe: your account, drafts and settings all stay exactly as they are, but sending pauses until you pick a plan. Nothing is ever charged without you choosing it — we ask for no card during the trial.",
      "",
      "If Collections Copilot has been quietly doing its job for your overdue invoices, subscribing keeps it running. Plans start at $7/month:",
      "",
      "[Choose a plan →]",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },

  // 3) T-3 value reminder — ACTIVE merchants (3–4 days before expiry)
  t_minus_3: {
    subject: "3 days left in your trial — keep your reminders running",
    body: trialBody([
      "Hello,",
      "",
      "You have 3 days left in your free trial (it ends {{expiry_date}}).",
      "",
      "Since you connected, Copilot has been watching your overdue invoices and keeping the escalation going — polite first reminder, firmer follow-up, final notice — so you don't have to chase anyone by hand. Your drafts stay free forever no matter what; it's the sending that would pause the day after {{expiry_date}}.",
      "",
      "If it's been useful, keep it on the job:",
      "",
      "[Choose a plan →]",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },

  // 4) T-1 final heads-up — ACTIVE merchants (24–48h before expiry)
  t_minus_1: {
    subject: "Your trial ends tomorrow, {{expiry_date}}",
    body: trialBody([
      "Hello,",
      "",
      "This is just the last heads-up: your free trial ends tomorrow, {{expiry_date}}.",
      "",
      "After that, your reminders to customers pause until you're on a plan. Your account, drafts and settings all stay put, and nothing is charged automatically — ever.",
      "",
      "One click keeps everything running:",
      "",
      "[Choose a plan →]",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },

  // 5) T-0 expiry notice — both tracks (the final day, 0–24h before expiry)
  t_zero: {
    subject: "Your trial ends today, {{expiry_date}}",
    body: trialBody([
      "Hello,",
      "",
      "Today is the last day of your Collections Copilot trial.",
      "",
      "To be completely clear about what that means:",
      "- Nothing has been charged and nothing will be — we never took a card.",
      "- Your account, drafts and settings stay. Drafting reminders remains free forever.",
      "- The one thing that changes starting tomorrow: reminder emails to your customers pause until you subscribe.",
      "",
      "If you want to keep your collections running without a gap:",
      "",
      "[Choose a plan →]",
      "",
      "Reply any time — a human reads this inbox.",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },

  // 6) T+3 win-back — both tracks (within 3 days AFTER expiry, still unsubscribed)
  t_plus_3: {
    subject: "Your trial ended — your reminders are paused",
    body: trialBody([
      "Hello,",
      "",
      "A few days ago your free trial ended, so we've paused the reminder emails your customers would have been receiving. Your account is exactly as you left it — nothing was charged, nothing was deleted, and all your drafts are still there, free.",
      "",
      "If you'd like, it takes one click to resume everything you had running:",
      "",
      "[Subscribe to resume →]",
      "",
      "And if you decided it's not for you, no hard feelings — just reply \"unsubscribe\" and we'll keep it to that.",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },
};

/**
 * Per-track overrides: the owner approved DIFFERENT wording for the idle track
 * at T-3 (an idle merchant has nothing running yet, so the active track's
 * "keep your reminders running" reminder would be wrong). Only the idle T-3
 * differs; every other shared touchpoint uses one template.
 */
export const TRIAL_EXPIRY_IDLE_OVERRIDES: Partial<Record<TrialTouchpoint, TrialCopyTemplate>> = {
  // 3b) T-3 reminder — IDLE merchants (replaces the active T-3 on that track)
  t_minus_3: {
    subject: "3 days left in your trial",
    body: trialBody([
      "Hello,",
      "",
      "Your Collections Copilot trial ends {{expiry_date}} — you have 3 days left.",
      "",
      "If you've been meaning to set it up: connect time is already done, so the only step left is an overdue invoice. Copilot drafts your reminder, you approve what goes out, and future chases happen automatically.",
      "",
      "One honest note: after {{expiry_date}}, your account and drafts stay free forever, but sending reminders requires a plan. If you'd rather just see what it can do first, reply and I'll walk you through it — happy to help either way.",
      "",
      TRIAL_EMAIL_SIGNATURE,
    ]),
  },
};

/** The template for one touchpoint on one track (idle override wins). */
export function copyTemplateFor(touchpoint: TrialTouchpoint, track: TrialTrack): TrialCopyTemplate {
  if (track === "idle") {
    const override = TRIAL_EXPIRY_IDLE_OVERRIDES[touchpoint];
    if (override) return override;
  }
  return TRIAL_EXPIRY_COPY[touchpoint];
}

/**
 * Append the live checkout URL after each approved CTA token (plain-text email
 * — the link has to be the URL itself). The visible token text is untouched.
 * Idempotent: a body that already carries the link is not linked twice.
 */
function linkCtas(text: string, billingUrl: string): string {
  if (!billingUrl) return text;
  let out = text;
  for (const token of TRIAL_CTA_TOKENS) {
    const linked = `${token} ${billingUrl}`;
    out = out
      .split(linked)
      .map((part) => part.split(token).join(linked))
      .join(linked);
  }
  return out;
}

/**
 * Substitute {{merge_field}} tokens. Unknown tokens are left in place on
 * purpose (a visible leftover is a copy bug, and the pass's render guard
 * refuses to send a template with an unresolved field), and a null/undefined
 * value renders as an empty string.
 */
export function renderTemplate(template: TrialCopyTemplate, fields: TrialExpiryMergeFields): TrialCopyTemplate {
  const values: Record<string, string> = {
    greetingName: fields.greetingName,
    merchantEmail: fields.merchantEmail,
    expiryDate: fields.expiryDate,
    // The approved copy spells the field {{expiry_date}}; keep both spellings
    // resolving to the same approved value.
    expiry_date: fields.expiryDate,
    daysLeft: String(fields.daysLeft),
    trialDays: String(fields.trialDays),
    dashboardUrl: fields.dashboardUrl,
    supportEmail: fields.supportEmail,
    billingUrl: fields.billingUrl,
    track: fields.track,
  };
  const fill = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (key in values ? values[key] : whole));
  return { subject: fill(template.subject), body: linkCtas(fill(template.body), fields.billingUrl) };
}

/** Fully rendered subject + body for one touchpoint. */
export function renderTrialEmail(
  touchpoint: TrialTouchpoint,
  track: TrialTrack,
  fields: TrialExpiryMergeFields,
): TrialCopyTemplate {
  return renderTemplate(copyTemplateFor(touchpoint, track), fields);
}

/**
 * "November 9, 2026" from a UTC epoch-ms instant — the date shown in the
 * emails. Kept UTC on purpose: the admin dashboard renders the expiry in the
 * owner's local timezone, but a merchant-facing date must be decided by the
 * owner in the approved copy, so the engine hands over the plain UTC date
 * rather than inventing a per-merchant timezone for v1.
 */
export function formatExpiryDateUtc(epochMs: number): string {
  const d = new Date(epochMs);
  if (!Number.isFinite(d.getTime())) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Greeting name — no name is stored on merchants, so use the email
 *  local-part and fall back to "there". */
export function greetingNameFor(email: string): string {
  const local = (email || "").trim().split("@")[0]?.trim() ?? "";
  return local || "there";
}
