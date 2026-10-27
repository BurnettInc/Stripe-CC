/**
 * Copy for the free-trial expiry email arc (owner-approved direction
 * 2026-10-26, after a research pass; engine in pipeline/trial-expiry.ts).
 *
 * ⚠️ PLACEHOLDER COPY ONLY — NOTHING HERE IS MERCHANT-FACING COPY YET.
 *
 * Every string below is an obvious placeholder. The owner approves EVERY WORD
 * of every merchant-facing email before it can ever send (standing rule,
 * owner 2026-10-12: no email to any merchant/customer goes out without the
 * owner's explicit pre-approval of that specific message). A follow-up commit
 * replaces these templates verbatim with the approved copy — the structure
 * (one template per touchpoint, {{merge_field}} placeholders, an opt-out line
 * in the body) stays exactly as it is.
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
 *     t_minus_3         → value reminder
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
 *   {{expiryDate}}    — the trial end date, UTC, e.g. "November 9, 2026"
 *   {{daysLeft}}      — 7 / 3 / 1 / 0 (0 on the t_zero and t_plus_3 notices)
 *   {{trialDays}}     — FREE_TRIAL_DAYS (30)
 *   {{dashboardUrl}}  — the merchant dashboard
 *   {{supportEmail}}  — support@getcollectionscopilot.com
 *
 * The body carries its OWN opt-out line ("reply to this email …"): these are
 * merchant-facing account/announcement emails, not invoice-scoped customer
 * reminders, so the invoice-scoped CAN-SPAM footer in pipeline/canspam.ts
 * ("To stop receiving reminders for this invoice") would be wrong here — the
 * send path passes skipCanspam. An easy opt-out must survive the copy swap.
 */

/** Sender identity for the trial arc — the same support@ identity the welcome
 *  emails used (continuity the owner recognised). */
export const TRIAL_EMAIL_FROM = "support@getcollectionscopilot.com";
/** Support address quoted inside the bodies. */
export const TRIAL_EMAIL_SUPPORT = "support@getcollectionscopilot.com";

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
  track: TrialTrack;
}

export interface TrialCopyTemplate {
  subject: string;
  body: string;
}

/**
 * The templates, one per touchpoint. PLACEHOLDERS — see the module doc.
 * Deliberately explicit so nobody mistakes them for approved copy: a
 * placeholder that looks final is the one real risk in this feature.
 */
export const TRIAL_EXPIRY_COPY: Record<TrialTouchpoint, TrialCopyTemplate> = {
  mid_trial_checkin: {
    subject: "[PLACEHOLDER — pending owner approval] Getting started with Collections Copilot",
    body: [
      "Hi {{greetingName}},",
      "",
      "PLACEHOLDER COPY — this message is not approved yet and cannot send until the owner approves the final wording.",
      "",
      "Touchpoint: MID-TRIAL CHECK-IN (idle track — ~day 10 of the {{trialDays}}-day trial)",
      "Trial ends: {{expiryDate}}",
      "Days left:  {{daysLeft}} of {{trialDays}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "To stop receiving these trial emails, reply to this email or write to {{supportEmail}}.",
    ].join("\n"),
  },
  t_minus_7: {
    subject: "[PLACEHOLDER — pending owner approval] Your trial ends in {{daysLeft}} days",
    body: [
      "Hi {{greetingName}},",
      "",
      "PLACEHOLDER COPY — this message is not approved yet and cannot send until the owner approves the final wording.",
      "",
      "Touchpoint: T-7 (active track — heads-up that the trial ends next week)",
      "Trial ends: {{expiryDate}}",
      "Days left:  {{daysLeft}} of {{trialDays}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "To stop receiving these trial emails, reply to this email or write to {{supportEmail}}.",
    ].join("\n"),
  },
  t_minus_3: {
    subject: "[PLACEHOLDER — pending owner approval] {{daysLeft}} days left in your trial",
    body: [
      "Hi {{greetingName}},",
      "",
      "PLACEHOLDER COPY — this message is not approved yet and cannot send until the owner approves the final wording.",
      "",
      "Touchpoint: T-3 (value reminder — shared by the active and idle tracks)",
      "Trial ends: {{expiryDate}}",
      "Days left:  {{daysLeft}} of {{trialDays}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "To stop receiving these trial emails, reply to this email or write to {{supportEmail}}.",
    ].join("\n"),
  },
  t_minus_1: {
    subject: "[PLACEHOLDER — pending owner approval] Your trial ends tomorrow",
    body: [
      "Hi {{greetingName}},",
      "",
      "PLACEHOLDER COPY — this message is not approved yet and cannot send until the owner approves the final wording.",
      "",
      "Touchpoint: T-1 (active track — the trial ends tomorrow)",
      "Trial ends: {{expiryDate}}",
      "Days left:  {{daysLeft}} of {{trialDays}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "To stop receiving these trial emails, reply to this email or write to {{supportEmail}}.",
    ].join("\n"),
  },
  t_zero: {
    subject: "[PLACEHOLDER — pending owner approval] Your trial ends today",
    body: [
      "Hi {{greetingName}},",
      "",
      "PLACEHOLDER COPY — this message is not approved yet and cannot send until the owner approves the final wording.",
      "",
      "Touchpoint: T-0 (expiry notice — shared by the active and idle tracks)",
      "Trial ends: {{expiryDate}}",
      "Days left:  {{daysLeft}} of {{trialDays}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "To stop receiving these trial emails, reply to this email or write to {{supportEmail}}.",
    ].join("\n"),
  },
  t_plus_3: {
    subject: "[PLACEHOLDER — pending owner approval] Your reminders are paused",
    body: [
      "Hi {{greetingName}},",
      "",
      "PLACEHOLDER COPY — this message is not approved yet and cannot send until the owner approves the final wording.",
      "",
      "Touchpoint: T+3 (win-back — the trial has ended; sending is locked, drafting stays free)",
      "Trial ended: {{expiryDate}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "To stop receiving these trial emails, reply to this email or write to {{supportEmail}}.",
    ].join("\n"),
  },
};

/**
 * Optional per-track overrides: when the owner approves different wording for
 * the idle track at a shared touchpoint, add the entry here instead of forking
 * the whole table. Empty today (every shared touchpoint uses one template).
 */
export const TRIAL_EXPIRY_IDLE_OVERRIDES: Partial<Record<TrialTouchpoint, TrialCopyTemplate>> = {};

/** The template for one touchpoint on one track (idle override wins). */
export function copyTemplateFor(touchpoint: TrialTouchpoint, track: TrialTrack): TrialCopyTemplate {
  if (track === "idle") {
    const override = TRIAL_EXPIRY_IDLE_OVERRIDES[touchpoint];
    if (override) return override;
  }
  return TRIAL_EXPIRY_COPY[touchpoint];
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
    daysLeft: String(fields.daysLeft),
    trialDays: String(fields.trialDays),
    dashboardUrl: fields.dashboardUrl,
    supportEmail: fields.supportEmail,
    track: fields.track,
  };
  const fill = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (key in values ? values[key] : whole));
  return { subject: fill(template.subject), body: fill(template.body) };
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
