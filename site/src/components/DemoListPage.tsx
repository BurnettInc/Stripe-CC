import { useEffect, useState } from "react";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { BTN_PRIMARY, BTN_SECONDARY } from "./ui";

/* The LIVE list-page template (served at /reminders and /past-due by the
 * backend) is the single source of truth — bundled in verbatim so the
 * demos render pixel-identical. */
import listPageHtml from "../../../app/src/ui/list-page.html?raw";

/* ------------------------------------------------------------------ *
 *  Public /demo-reminders + /demo-pastdue — exact replicas of the real
 *  SSR list pages (app/src/ui/list-page.html served at /reminders and
 *  /past-due), run in DEMO_MODE.
 *
 *  Single source of truth: the LIVE list-page template the backend uses
 *  (app/src/ui/list-page.html — read by app/src/routes/pages.ts and filled
 *  with {{TITLE}} / {{SUBTITLE}} / {{SUMMARY}} / {{CONTENT}}) is bundled in
 *  verbatim via vite ?raw, so the demo cannot drift. This component then:
 *    1. fills the placeholders with the SAME markup pages.ts produces
 *       (summary chips, sortable headers with data-sort-key/data-sort,
 *       per-row stage controls, email toggles, engagement pills, CAN-SPAM
 *       footers) but from fictional in-memory seeds,
 *    2. strips the list page's own visit-tracking beacon (its POST to
 *       /api/track must NOT fire from inside the demo),
 *    3. injects a DEMO_MODE shim at the top of the page's inline script —
 *       every fetch fails closed with a friendly alert, the stage-override
 *       PUT is neutered, internal links (/dashboard, /past-due?status=…)
 *       that would exit into the real app/site get a friendly alert, and
 *       the parent <iframe> is kept sized via postMessage,
 *    4. renders the result in a same-origin <iframe srcDoc> (page-level
 *       CSS can never collide with the marketing site).
 *
 *  Zero persistence: refresh resets. The conversion CTA links to the REAL
 *  install URL with utm_source=demo. All customer/invoice/email data is
 *  fictional and mirrors the sample account shown on /demo (9 invoices,
 *  $150–$4,500, 3–62 days overdue; 4 sent reminders + 5 AI drafts).
 * ------------------------------------------------------------------ */

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";
const SIGNUP_URL = `${INSTALL_URL}?utm_source=demo`;

const LISTPAGE_HTML = listPageHtml;

export type DemoListKind = "pastdue" | "reminders";
export type DemoTabKey = "pipeline" | "reminders" | "pastdue";

/* ── Demo-mode sub-nav shared by all three demo pages ── */
export function DemoTabs({ active }: { active: DemoTabKey }) {
  const tabs: Array<{ key: DemoTabKey; href: string; label: string }> = [
    { key: "pipeline", href: "/demo", label: "Pipeline" },
    { key: "reminders", href: "/demo-reminders", label: "Reminders" },
    { key: "pastdue", href: "/demo-pastdue", label: "Past due" },
  ];
  return (
    <div className="mx-auto mt-7 inline-flex flex-wrap justify-center rounded-full border border-gray-700 bg-gray-800/60 p-1 text-sm font-semibold">
      {tabs.map((t) => (
        <a
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={`rounded-full px-5 py-2 transition-colors ${
            active === t.key
              ? "bg-indigo-600 text-white"
              : "text-gray-300 hover:text-white"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
 *  Fictional seed data — the SAME sample account as /demo.
 *  (demo.tsx renders Avery/Leo/Marcus/Sofia/Priya/Elena/James with the
 *  same amounts/stages; Maya + Daniel are the account's sent-reminder
 *  customers. Due dates are derived from "days overdue" at render time so
 *  the page always shows the same relative story.)
 * ══════════════════════════════════════════════════════════════════ */

interface SeedInvoice {
  id: number;
  customer_name: string;
  customer_email: string;
  amount_cents: number;
  currency: string;
  days_overdue: number;
  reminders: number;
}

const SEED_INVOICES: SeedInvoice[] = [
  { id: 19, customer_name: "Daniel Kim", customer_email: "daniel@kimdesign.co", amount_cents: 76000, currency: "usd", days_overdue: 47, reminders: 3 },
  { id: 17, customer_name: "James Okafor", customer_email: "james@okaforconsulting.com", amount_cents: 340000, currency: "usd", days_overdue: 47, reminders: 0 },
  { id: 16, customer_name: "Elena Petrova", customer_email: "elena@petrovacreative.com", amount_cents: 198000, currency: "usd", days_overdue: 34, reminders: 0 },
  { id: 15, customer_name: "Priya Natarajan", customer_email: "priya@natarajandesign.com", amount_cents: 280000, currency: "usd", days_overdue: 18, reminders: 0 },
  { id: 18, customer_name: "Maya Thompson", customer_email: "maya@thompsonstudio.com", amount_cents: 96000, currency: "usd", days_overdue: 15, reminders: 1 },
  { id: 14, customer_name: "Sofia Reyes", customer_email: "sofia@reyescollective.com", amount_cents: 64000, currency: "usd", days_overdue: 9, reminders: 0 },
  { id: 13, customer_name: "Marcus Webb", customer_email: "marcus@webbdigital.com", amount_cents: 125000, currency: "usd", days_overdue: 6, reminders: 0 },
  { id: 11, customer_name: "Avery Chen", customer_email: "avery@chenstudio.com", amount_cents: 45000, currency: "usd", days_overdue: 5, reminders: 0 },
  { id: 12, customer_name: "Leo Fischer", customer_email: "leo@fischerstudio.com", amount_cents: 72000, currency: "usd", days_overdue: 3, reminders: 0 },
];

interface SeedReminder {
  id: number;
  invoiceId: number;
  customer: string;
  email: string;
  amount_cents: number;
  currency: string;
  stage: number;
  sentDaysAgo: number | null; // null = draft, not sent
  subject: string;
  body: string;
  engagement: "opened" | "clicked" | "none" | null; // null = no data / draft
}

/* The 4 fictional "already sent" reminders — same customers/subjects/days
 * ago as demo.tsx's seedSentEmails. */
const SEED_REMINDERS: SeedReminder[] = [
  {
    id: 501, invoiceId: 18, customer: "Maya Thompson", email: "maya@thompsonstudio.com",
    amount_cents: 96000, currency: "usd", stage: 2, sentDaysAgo: 3,
    subject: "Following up — invoice #1044",
    body: "Hi Maya,\n\nJust following up on invoice #1044 ($960) — it is now a few days past due. If it is already on its way, no need to reply; if something does not add up, happy to sort it out.\n\nLet me know either way?",
    engagement: "opened",
  },
  {
    id: 502, invoiceId: 19, customer: "Daniel Kim", email: "daniel@kimdesign.co",
    amount_cents: 76000, currency: "usd", stage: 3, sentDaysAgo: 14,
    subject: "Final notice — invoice #1055",
    body: "Hi Daniel,\n\nThis is the final notice for invoice #1055 ($760), now more than three weeks overdue. Two reminders have gone out with no payment received, and per our payment terms this invoice needs to be settled without further delay.\n\nPlease arrange payment now — and if there is a dispute or a hardship, contact us today so we can find a solution before any further steps are taken.",
    engagement: "opened",
  },
  {
    id: 503, invoiceId: 19, customer: "Daniel Kim", email: "daniel@kimdesign.co",
    amount_cents: 76000, currency: "usd", stage: 2, sentDaysAgo: 28,
    subject: "Following up — invoice #1055",
    body: "Hi Daniel,\n\nFollowing up on invoice #1055 ($760) — it is now a few days past due. If it is already on its way, you can ignore this; if there is a hiccup on your end, happy to work something out.\n\nLet me know either way?",
    engagement: "none",
  },
  {
    id: 504, invoiceId: 19, customer: "Daniel Kim", email: "daniel@kimdesign.co",
    amount_cents: 76000, currency: "usd", stage: 1, sentDaysAgo: 41,
    subject: "Quick nudge — invoice #1055",
    body: "Hi Daniel,\n\nQuick nudge that invoice #1055 ($760) slipped past its due date — no rush if it has been a busy one.\n\nIf it is already on its way, no need to reply. Cheers!",
    engagement: "clicked",
  },
];

/* The 5 drafted-but-not-sent reminders — AI draft bodies verbatim from
 * demo.tsx (same subjects, same stage column as the /demo approval inbox). */
const SEED_DRAFTS: SeedReminder[] = [
  {
    id: 17, invoiceId: 17, customer: "James Okafor", email: "james@okaforconsulting.com",
    amount_cents: 340000, currency: "usd", stage: 3, sentDaysAgo: null,
    subject: "Final notice before escalation — invoice #1058",
    body: "Hi James,\n\nInvoice #1058 ($3,400) is now 47 days overdue. Our earlier reminders have gone unanswered, and this is the final notice before we consider next steps under our payment terms, including pausing future work.\n\nIf this was an oversight, one quick payment settles it. If there is a reason, reply today — we would much rather sort it out than escalate it.",
    engagement: null,
  },
  {
    id: 16, invoiceId: 16, customer: "Elena Petrova", email: "elena@petrovacreative.com",
    amount_cents: 198000, currency: "usd", stage: 3, sentDaysAgo: null,
    subject: "Final notice — invoice #1039",
    body: "Hi Elena,\n\nThis is the final notice for invoice #1039 ($1,980), now 34 days overdue. Two reminders have gone out with no payment received, and per our payment terms this invoice needs to be settled without further delay.\n\nPlease arrange payment now — and if there is a dispute or a hardship, contact us today so we can find a solution before any further steps are taken.",
    engagement: null,
  },
  {
    id: 15, invoiceId: 15, customer: "Priya Natarajan", email: "priya@natarajandesign.com",
    amount_cents: 280000, currency: "usd", stage: 2, sentDaysAgo: null,
    subject: "Overdue — invoice #1047",
    body: "Hi Priya,\n\nI wanted to check in personally about invoice #1047 ($2,800), which is now 18 days past its due date. We are past the friendly-reminder stage, so I would really appreciate it if you could arrange payment this week.\n\nIf there is a billing question or a specific blocker, reply and I will sort it out right away — otherwise our standard reminders will keep running.",
    engagement: null,
  },
  {
    id: 14, invoiceId: 14, customer: "Sofia Reyes", email: "sofia@reyescollective.com",
    amount_cents: 64000, currency: "usd", stage: 2, sentDaysAgo: null,
    subject: "Following up — invoice #1062",
    body: "Hi Sofia,\n\nFollowing up on invoice #1062 ($640) — it is now a few days past due. If it is already on its way, you can ignore this; if there is a hiccup on your end, happy to work something out.\n\nLet me know either way?",
    engagement: null,
  },
  {
    id: 13, invoiceId: 13, customer: "Marcus Webb", email: "marcus@webbdigital.com",
    amount_cents: 125000, currency: "usd", stage: 1, sentDaysAgo: null,
    subject: "Quick nudge — invoice #1053",
    body: "Hi Marcus,\n\nHope the site relaunch went well this week. Just a quick nudge that invoice #1053 ($1,250) slipped past its due date — no rush if it has been a busy one.\n\nIf it is already on its way, no need to reply. Cheers!",
    engagement: null,
  },
];

/* ── Replica of the SSR helpers in app/src/routes/pages.ts ────────── */

function esc(v: unknown): string {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

function formatMoney(cents: number, currency: string): string {
  const c = String(currency || "usd").toUpperCase();
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
  } catch {
    return "$" + n.toFixed(2);
  }
}

function formatDate(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* Whole days since due_date — same math as the watcher / pages.ts. */
function daysOverdue(dueDate: string): number | null {
  const t = new Date(dueDate).getTime();
  return isNaN(t) ? null : Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
}

/* Default 6/20 ladder — same as getEscalationStage(days, 6, 20). */
function autoStageFor(days: number | null): 1 | 2 | 3 | null {
  if (days === null) return null;
  if (days <= 0) return 1;
  if (days <= 6) return 1;
  if (days <= 20) return 2;
  return 3;
}

const chip = (cls: string, label: string): string =>
  `<span class="chip ${cls}">${esc(label)}</span>`;

function chipLink(href: string, label: string, selected: boolean): string {
  return (
    `<a class="summary-chip${selected ? " selected" : ""}" href="${esc(href)}"` +
    (selected ? ' aria-current="page"' : "") +
    `>${esc(label)}</a>`
  );
}

const thSort = (key: string, label: string): string =>
  `<th class="sortable" data-sort-key="${key}" scope="col">${esc(label)}<span class="sort-indicator"></span></th>`;

/* CAN-SPAM footer — reconstructed deterministically exactly like the
 * footer appendCanspamFooter() appended at send time. Rendered as inert
 * plain text inside the email <pre> (never a clickable link). */
function cansSpamFooter(merchantId: number, customerEmail: string): string {
  const address = "Collections Copilot — Texas, USA";
  const url =
    `https://stripe-cc-production.up.railway.app/api/unsubscribe` +
    `?merchant=${merchantId}&customer=${encodeURIComponent(customerEmail)}`;
  return (
    `---\nTo stop receiving reminders for this invoice, reply to this email or use the opt-out link below.\n` +
    `Unsubscribe: ${url}\n${address}`
  );
}

const FROM_EMAIL = "reminders@mail.getcollectionscopilot.com";
const SENDER_NAME = "Your Studio"; // demo.tsx settings.sender_name
const REPLY_DOMAIN = "replies.getcollectionscopilot.com";
const MERCHANT_ID = 1; // fictional sample merchant

function sentBodyFor(body: string, email: string): string {
  return `${body.trimEnd()}\n\n${cansSpamFooter(MERCHANT_ID, email)}\n`;
}

/* ── /past-due payload (mirrors handlePastDuePage) ─────────────────── */

const PAST_DUE_TABS = [
  { key: "all", label: "All invoices" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "refunded", label: "Refunded" },
  { key: "disputed", label: "Disputed" },
];

function pastDuePayload(): { title: string; subtitle: string; summary: string; content: string } {
  const now = Date.now();
  const iso = (daysAgo: number): string => new Date(now - daysAgo * 86400000).toISOString();

  // Whole-account counts: 9 overdue invoices, nothing paid/refunded/disputed.
  const counts: Record<string, number> = {
    all: SEED_INVOICES.length,
    overdue: SEED_INVOICES.length,
    paid: 0,
    refunded: 0,
    disputed: 0,
  };
  const summary = PAST_DUE_TABS.map((t) =>
    chipLink(`/past-due?status=${t.key}`, `${t.label} · ${counts[t.key] ?? 0}`, t.key === "overdue")
  ).join("");

  // Most overdue first — matches ORDER BY due_date ASC (oldest due first).
  const invoices = [...SEED_INVOICES].sort((a, b) => b.days_overdue - a.days_overdue);

  const stageControl = (inv: SeedInvoice, autoStage: 1 | 2 | 3 | null): string => {
    const options = [null, 1, 2, 3]
      .map((o) => {
        const val = o === null ? "" : String(o);
        const label = o === null ? "Auto" : `Stage ${o}`;
        const sel = o === null ? " selected" : "";
        return `<option value="${val}"${sel}>${label}</option>`;
      })
      .join("");
    return (
      `<td data-sort="${autoStage ?? ""}">` +
      `<div class="stage-cell">` +
      (autoStage ? `<span class="chip chip-stage st${autoStage}">Stage ${autoStage}</span>` : '<span class="cell-muted">—</span>') +
      `<select class="stage-override" data-invoice-id="${inv.id}" aria-label="Override escalation stage">${options}</select>` +
      `</div>` +
      `</td>`
    );
  };

  const rows = invoices
    .map((inv) => {
      const isoDue = iso(inv.days_overdue);
      const days = daysOverdue(isoDue);
      const autoStage = autoStageFor(days);
      return (
        "<tr>" +
        `<td><div class="cell-strong">${esc(inv.customer_name || "Unknown customer")}</div>` +
        `<div class="cell-muted" style="font-size:0.75rem;">${esc(inv.customer_email)}</div>` +
        "</td>" +
        `<td class="cell-amount" data-sort="${inv.amount_cents}">${esc(formatMoney(inv.amount_cents, inv.currency))}</td>` +
        `<td class="cell-muted" data-sort="${esc(isoDue)}">${esc(formatDate(isoDue))}</td>` +
        `<td class="cell-strong" data-sort="${days ?? ""}">${days != null ? days + (days === 1 ? " day" : " days") : "—"}</td>` +
        stageControl(inv, autoStage) +
        `<td class="cell-muted" style="font-size:0.75rem;" data-sort="${inv.reminders}">${inv.reminders > 0 ? inv.reminders + " reminder" + (inv.reminders === 1 ? "" : "s") : "no reminders yet"}</td>` +
        "</tr>"
      );
    })
    .join("");

  return {
    title: "Past-due invoices",
    subtitle: "Overdue invoices Collections Copilot is tracking for you — most overdue first.",
    summary,
    content:
      `<div class="table-wrap"><table>` +
      `<thead><tr><th scope="col">Customer</th>${thSort("amount", "Amount")}${thSort("due", "Due date")}${thSort("days", "Days overdue")}${thSort("stage", "Stage")}${thSort("reminders", "Reminders")}</tr></thead>` +
      `<tbody>${rows}</tbody></table></div>`,
  };
}

/* ── /reminders payload (mirrors handleRemindersPage, Pro) ─────────── */

function remindersPayload(): { title: string; subtitle: string; summary: string; content: string } {
  const now = Date.now();
  const iso = (daysAgo: number): string => new Date(now - daysAgo * 86400000).toISOString();
  const sentAt = (r: SeedReminder): string => (r.sentDaysAgo === null ? "" : iso(r.sentDaysAgo));

  const engagement = (r: SeedReminder): string => {
    if (r.sentDaysAgo === null) return '<span class="cell-muted">—</span>';
    if (r.engagement === "clicked") {
      return `<span class="chip chip-engagement chip-engagement-clicked" title="Clicked ${esc(sentAt(r))} — opened ${esc(sentAt(r))}">Opened &amp; clicked</span>`;
    }
    if (r.engagement === "opened") {
      return `<span class="chip chip-engagement chip-engagement-opened" title="Opened ${esc(sentAt(r))}">Opened</span>`;
    }
    return '<span class="chip chip-engagement chip-engagement-none">Not opened</span>';
  };

  const emailDetail = (r: SeedReminder, isDraft: boolean): string => {
    const body = isDraft
      ? `DRAFT — NOT SENT · AI-drafted, waiting for your approval\n\n${r.body}`
      : sentBodyFor(r.body, r.email);
    const from = `"${SENDER_NAME}" <${FROM_EMAIL}>`;
    const replyTo = r.sentDaysAgo === null ? null : `reply+${r.invoiceId}@${REPLY_DOMAIN}`;
    return (
      `<button type="button" class="email-toggle" data-id="${r.id}" aria-expanded="false">View email</button>` +
      `<div class="email-body" id="emailbody-${r.id}" hidden>` +
      `<dl class="email-meta">` +
      (r.sentDaysAgo === null ? "" : `<div class="meta-row"><dt>From</dt><dd>${esc(from)}</dd></div>`) +
      (replyTo ? `<div class="meta-row"><dt>Reply-To</dt><dd>${esc(replyTo)}</dd></div>` : "") +
      `<div class="meta-row"><dt>Subject</dt><dd>${r.subject ? esc(r.subject) : '<span class="cell-muted">—</span>'}</dd></div>` +
      `</dl>` +
      `<pre class="email-pre">${body ? esc(body) : '<span class="cell-muted">(no body recorded for this send)</span>'}</pre>` +
      `</div>`
    );
  };

  const rowFor = (r: SeedReminder): string => {
    const isDraft = r.sentDaysAgo === null;
    return (
      "<tr>" +
      `<td class="cell-toggle">${emailDetail(r, isDraft)}</td>` +
      `<td><div class="cell-strong">${esc(r.customer || "Unknown customer")}` +
      (isDraft ? ` <span class="pill pill-muted">Draft</span>` : "") +
      "</div>" +
      `<div class="cell-muted" style="font-size:0.75rem;">${esc(r.email)}</div>` +
      "</td>" +
      `<td class="cell-amount" data-sort="${r.amount_cents}">${esc(formatMoney(r.amount_cents, r.currency))}</td>` +
      `<td data-sort="${r.stage}">${chip("chip-stage st" + r.stage, "Stage " + r.stage)}</td>` +
      `<td class="cell-muted" data-sort="${esc(sentAt(r))}">${r.sentDaysAgo === null ? '<span class="cell-muted">—</span>' : esc(formatDateTime(sentAt(r)))}</td>` +
      `<td data-sort="${r.engagement ? (r.engagement === "clicked" ? 2 : r.engagement === "opened" ? 1 : 0) : ""}">${engagement(r)}</td>` +
      `<td data-sort="${esc(r.subject)}">${r.subject ? esc(r.subject) : '<span class="cell-muted">—</span>'}</td>` +
      `<td>${isDraft ? chip("chip-stub", "Draft") : chip("chip-sent", "Sent")}</td>` +
      "</tr>"
    );
  };

  // Newest send first, then drafts (most overdue first) — the sent rows are
  // the real /reminders list; draft rows are included so visitors can read
  // the AI drafts next to the sent history (clearly labeled "Draft").
  const sent = [...SEED_REMINDERS].sort((a, b) => (b.sentDaysAgo ?? 0) - (a.sentDaysAgo ?? 0));
  const drafts = [...SEED_DRAFTS].sort((a, b) => b.stage - a.stage || a.id - b.id);
  const all = [...sent, ...drafts];

  return {
    title: "Sent reminders",
    subtitle:
      "Reminder emails sent to your customers, newest first. " +
      "The Engagement column shows whether a recipient opened or clicked each reminder (via Resend open/click tracking). " +
      "Test sends are labeled “Test send”. Open any row to see the full email exactly as sent.",
    summary: "",
    content:
      `<div class="table-wrap"><table>` +
      `<thead><tr><th scope="col">Email</th><th scope="col">Customer</th>${thSort("amount", "Amount")}${thSort("stage", "Stage")}${thSort("sent_at", "Sent at")}${thSort("engagement", "Engagement")}${thSort("subject", "Subject")}<th scope="col">Result</th></tr></thead>` +
      `<tbody>${all.map(rowFor).join("")}</tbody></table></div>`,
  };
}

/* ── DEMO_MODE shim ──────────────────────────────────────────────────
 * Inserted at the TOP of the list page's inline <script>, so it runs before
 * the page's own stage-override handler. window.fetch is replaced with a
 * fail-closed stub (the list page never fetches on load — only the stage
 * override PUT and the visit beacon, which is stripped above). */
const DEMO_MODE_SNIPPET = `
// DEMO_MODE (injected by site/src/components/DemoListPage.tsx) — this copy
// of the list page runs against fictional in-memory seed data only. No
// network, no DB, no Stripe, no email. Refreshing the page resets it.
(function () {
  function halt(msg) {
    return Promise.resolve(new Response(JSON.stringify({ error: msg }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  }
  // Every network call fails closed in the demo.
  window.fetch = function () {
    window.setTimeout(function () {
      window.alert('Demo Mode: network calls are disabled in the demo — nothing here is live, nothing is saved, and nothing sends.');
    }, 0);
    return halt('Demo Mode blocks network calls.');
  };
  // The stage-override handler in list-page.html calls alert("Could not
  // update the escalation stage.") when its PUT fails — translate that into
  // an honest demo message instead of looking like a product bug.
  var _alert = window.alert;
  window.alert = function (m) {
    if (typeof m === 'string' && m.indexOf('Could not update the escalation stage') === 0) {
      _alert('Demo Mode: this is sample data — stage overrides are not saved here. Connect your Stripe account on the real app to manage real invoices.');
    } else {
      _alert(m);
    }
  };
  // Neutralize links inside the replica that would exit into the REAL app or
  // the marketing site's 404s (/dashboard, /past-due?status=…): a friendly
  // alert instead of navigating away from the demo.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a) return;
    var href = (a.getAttribute('href') || '').trim();
    if (href === '/dashboard' || href.indexOf('/past-due') === 0 || href.indexOf('/reminders') === 0) {
      ev.preventDefault();
      _alert('Demo Mode: this link is disabled so the demo stays self-contained — nothing here is live. Connect your Stripe account on the real app to see this.');
    }
  });
  // Keep the parent <iframe> sized to the full page height.
  function pushH() {
    try {
      var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 400);
      parent.postMessage({ type: 'cc-demo-height', h: h }, '*');
    } catch (e) {}
  }
  window.setTimeout(pushH, 100);
  window.setTimeout(pushH, 400);
  window.setInterval(pushH, 3000);
})();
`;

/* Strip the list page's own visit-tracking beacon (POST to /api/track) —
 * the marketing site's own beacon already records the /demo* page view. */
const BEACON_RE = /<script>\s*\(function\(\)\{try\{var p=location\.pathname;[\s\S]*?<\/script>/;

function buildDoc(kind: DemoListKind): string {
  const payload = kind === "pastdue" ? pastDuePayload() : remindersPayload();
  return LISTPAGE_HTML
    .replace(BEACON_RE, "<!-- demo: list-page visit-tracking beacon removed (no /api/track from inside the demo) -->")
    .replaceAll("{{TITLE}}", esc(payload.title))
    .replaceAll("{{SUBTITLE}}", esc(payload.subtitle))
    .replaceAll("{{SUMMARY}}", payload.summary)
    .replaceAll("{{CONTENT}}", payload.content)
    .replace(
      "  <script>\n    // Client-side table sorting",
      `  <script>\n    ${DEMO_MODE_SNIPPET}\n    // Client-side table sorting`
    );
}

/* ── Marketing-page chrome (mirrors /demo) ─────────────────────────── */

const PAGE_COPY: Record<DemoListKind, { heading: string; body: string; banner: string }> = {
  pastdue: {
    heading: "See the past-due list in action",
    body: "Every customer, invoice, and email below is made-up sample data — nothing here is real, nothing sends, and nothing is saved. This is the same overdue-invoice list a merchant sees after drilling in from the dashboard: each invoice's amount, how long it is overdue, its escalation stage, and how many reminders have gone out.",
    banner: "⚠ Demo Mode — sample data only, nothing sends, nothing is saved",
  },
  reminders: {
    heading: "See the sent-reminder history in action",
    body: "Every customer, invoice, and email below is made-up sample data — nothing here is real, nothing sends, and nothing is saved. This is the same reminder history a merchant sees once Collections Copilot has drafted and sent follow-ups — open any row to read the full email exactly as it was sent.",
    banner: "⚠ Demo Mode — sample data only, nothing sends, nothing is saved",
  },
};

function DemoListPage({ kind }: { kind: DemoListKind }) {
  const [height, setHeight] = useState(kind === "pastdue" ? 1100 : 1400);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { type?: string; h?: number } | null;
      if (d && d.type === "cc-demo-height" && typeof d.h === "number") {
        setHeight(Math.max(600, d.h));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const doc = buildDoc(kind);
  const copy = PAGE_COPY[kind];

  return (
    <div className="min-h-dvh bg-white">
      <SiteNav />

      {/* ── Custom header (Demo Mode banner + owner-style copy) ── */}
      <section className="bg-gray-900 text-white">
        <div className="max-w-5xl mx-auto px-6 py-12 text-center">
          <div className="mb-5 flex flex-wrap items-center justify-center gap-3">
            <span className="inline-block rounded-full border border-amber-300/50 bg-amber-400/10 px-4 py-1.5 text-xs font-bold tracking-wide text-amber-300">
              {copy.banner}
            </span>
            <button
              onClick={() => setResetKey((k) => k + 1)}
              className="inline-block rounded-full border border-gray-600 px-4 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:border-gray-400 hover:text-white"
            >
              ↺ Reset demo
            </button>
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{copy.heading}</h1>
          <p className="mx-auto mt-4 max-w-3xl leading-relaxed text-gray-300">{copy.body}</p>
          <DemoTabs active={kind === "pastdue" ? "pastdue" : "reminders"} />
        </div>
      </section>

      {/* ── Middle: exact replica of the real list page (DEMO_MODE) ── */}
      <div className="bg-[#F9FAFB]">
        <iframe
          key={resetKey}
          title={`Collections Copilot ${kind === "pastdue" ? "past-due" : "sent-reminders"} demo (exact replica)`}
          srcDoc={doc}
          className="block w-full border-0"
          style={{ height }}
          scrolling="no"
          tabIndex={-1}
        />
      </div>

      {/* ── Footer: conversion CTA + the site footer ── */}
      <section className="bg-gray-900 py-16 text-white">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Ready to see it with your own invoices?</h2>
          <p className="mx-auto mt-4 max-w-lg text-gray-400">
            The demo above is sample data. Connect your Stripe account and Collections Copilot watches your
            real overdue invoices in the same pipeline — read-only at first, and nothing sends without your
            approval.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4">
            <a href={SIGNUP_URL} className={BTN_PRIMARY} style={{ display: "inline-flex" }}>
              Connect your Stripe account to start free
            </a>
            <a href="/how-it-works" className={BTN_SECONDARY}>
              How it works
            </a>
          </div>
          <p className="mt-4 text-xs text-gray-500">
            No card required · cancel anytime · your first month is free
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

export default DemoListPage;