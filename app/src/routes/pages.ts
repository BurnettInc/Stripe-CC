import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEscalationStage } from "../pipeline/escalation";
import { appendCanspamFooter } from "../pipeline/canspam";
import { buildFromAddress, trackedReplyToForTask } from "../pipeline/sender";
import { isActiveProSubscriber } from "../db";

// Server-side rendered list pages for the dashboard's drill-down links:
//   GET /past-due  — past-due (overdue) invoices
//   GET /reminders — sent-reminder history
// Both use the same session-cookie auth as every other dashboard route (the
// caller — index.ts — runs requireSession() before invoking these) and render
// the shared list-page shell (app/src/ui/list-page.html) with the dashboard's
// design tokens, so the pages look like the dashboard they came from.
//
// /past-due is filterable via query params; both pages are sortable
// client-side:
//   /past-due?status=all|overdue|paid|refunded|disputed  (default overdue)
//   /reminders — single list, newest first: every successful reminder send
//                (real + test rows together). Test (stub) rows are labeled
//                with a muted "Test send" pill next to the customer name and
//                are always hidden from merchants (see the shared list-page
//                CSS; ?type= is deliberately a no-op — there is one dataset,
//                not two views).
// The past-due summary chips are real <a> tabs (work without JS — server-side
// filtering); the table headers are client-side sorted by vanilla JS in
// list-page.html (graceful no-op without JS). Lists stay capped at 200 rows.

const template = readFileSync(join(import.meta.dirname, "..", "ui", "list-page.html"), "utf-8");

const htmlHeaders = { "Content-Type": "text/html; charset=utf-8" };

/** Escape a value for safe embedding in HTML (attribute + text contexts). */
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

function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? String(s) : d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whole days since due_date — mirrors the watcher / task-inbox math. */
function daysOverdue(dueDate: string | null | undefined): number | null {
  if (!dueDate) return null;
  const t = new Date(dueDate).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
}

function renderPage(title: string, subtitle: string, summary: string, content: string): Response {
  return new Response(
    template
      .replaceAll("{{TITLE}}", esc(title))
      .replaceAll("{{SUBTITLE}}", esc(subtitle))
      .replaceAll("{{SUMMARY}}", summary)
      .replaceAll("{{CONTENT}}", content),
    { status: 200, headers: htmlHeaders }
  );
}

const chip = (cls: string, label: string): string =>
  `<span class="chip ${cls}">${esc(label)}</span>`;

/** A filter-tab chip: an <a> styled like a summary pill. Selected gets a
 *  distinct active state + aria-current. Works without JS (plain href). */
function chipLink(href: string, label: string, selected: boolean): string {
  return (
    `<a class="summary-chip${selected ? " selected" : ""}" href="${esc(href)}"` +
    (selected ? ' aria-current="page"' : "") +
    `>${esc(label)}</a>`
  );
}

/** Sortable table header. The client-side sort (list-page.html) reads
 *  data-sort-key from the <th> and data-sort from the row cells. */
const thSort = (key: string, label: string): string =>
  `<th class="sortable" data-sort-key="${key}" scope="col">${esc(label)}<span class="sort-indicator"></span></th>`;

// ── GET /past-due — past-due invoices ──

interface PastDueView {
  key: string;
  chipLabel: string;   // chip label; the live count is appended
  title: string;
  subtitle: string;
  where: string;       // SQL fragment ANDed with merchant_id=?
  emptyHead: string;
  emptyBody: string;
}

const PAST_DUE_VIEWS: PastDueView[] = [
  {
    key: "all", chipLabel: "All invoices",
    title: "All invoices",
    subtitle: "Every invoice on file for this account — use the tabs to filter.",
    where: "1=1",
    emptyHead: "No invoices on file",
    emptyBody: "Invoices appear here once Collections Copilot starts tracking them.",
  },
  {
    key: "overdue", chipLabel: "Overdue",
    title: "Past-due invoices",
    subtitle: "Overdue invoices Collections Copilot is tracking for you — most overdue first.",
    where: "status='overdue'",
    emptyHead: "No past-due invoices",
    emptyBody: "Newly overdue invoices will appear here automatically. You're all caught up.",
  },
  {
    key: "paid", chipLabel: "Paid",
    title: "Paid invoices",
    subtitle: "Invoices your customers have paid.",
    where: "status='paid'",
    emptyHead: "No paid invoices",
    emptyBody: "When a customer pays an overdue invoice, it will show up here.",
  },
  {
    key: "refunded", chipLabel: "Refunded",
    title: "Refunded invoices",
    subtitle: "Invoices where the charge was refunded — reminders were stopped automatically.",
    where: "refund_id IS NOT NULL",
    emptyHead: "No refunded invoices",
    emptyBody: "Refunded invoices appear here after a charge is refunded.",
  },
  {
    key: "disputed", chipLabel: "Disputed",
    title: "Disputed invoices",
    subtitle: "Invoices your customer disputed — reminders were paused automatically.",
    where: "dispute_id IS NOT NULL",
    emptyHead: "No disputed invoices",
    emptyBody: "Disputed invoices appear here after a customer opens a dispute.",
  },
];

const DEFAULT_PAST_DUE_VIEW = "overdue";

export function handlePastDuePage(db: Database, merchantId: number, statusParam: string = DEFAULT_PAST_DUE_VIEW): Response {
  const view = PAST_DUE_VIEWS.find((v) => v.key === statusParam) ??
    PAST_DUE_VIEWS.find((v) => v.key === DEFAULT_PAST_DUE_VIEW)!;

  // Per-view count, used for the chip labels (always whole-dataset counts so
  // the chips stay a true summary no matter which tab is active).
  const countFor = (where: string): number =>
    (db.query(`SELECT COUNT(*) AS n FROM invoices WHERE merchant_id=? AND ${where}`).get(merchantId) as { n: number }).n;

  const counts = new Map(PAST_DUE_VIEWS.map((v) => [v.key, countFor(v.where)]));

  const summary = PAST_DUE_VIEWS.map((v) =>
    chipLink(`/past-due?status=${v.key}`, `${v.chipLabel} · ${counts.get(v.key)}`, v.key === view.key)
  ).join("");

  const invoices = db.query(
    `SELECT * FROM invoices WHERE merchant_id=? AND ${view.where} ORDER BY due_date ASC, id ASC`
  ).all(merchantId) as Array<{
    id: number; stripe_invoice_id: string; customer_name: string; customer_email: string;
    amount_cents: number; currency: string; due_date: string; status: string; created_at: string;
    stage_override: number | null;
  }>;

  // Merchant ladder timing for the automatic days-overdue stage (same default
  // 6/20 ladder the watcher uses; Pro may customize stage1_days/stage2_days).
  const timing = db.query("SELECT stage1_days, stage2_days FROM merchants WHERE id=?").get(merchantId) as { stage1_days: number; stage2_days: number } | null;
  const autoStageFor = (dueDate: string): number | null => {
    const days = daysOverdue(dueDate);
    return days === null ? null : getEscalationStage(days, timing?.stage1_days ?? 6, timing?.stage2_days ?? 20);
  };
  // A per-row Stage control: Auto (automatic progression) or a manual 1|2|3
  // override. The effective stage shown is the override when set, else the
  // auto stage. A "manually set" pill marks any overridden row at a glance.
  const stageControl = (inv: { id: number; stage_override: number | null; due_date: string }, autoStage: number | null) => {
    const override = inv.stage_override;
    const effective = override ?? autoStage;
    const options = [null, 1, 2, 3].map((o) => {
      const val = o === null ? "" : String(o);
      const label = o === null ? "Auto" : `Stage ${o}`;
      const sel = override === o ? " selected" : "";
      return `<option value="${val}"${sel}>${label}</option>`;
    }).join("");
    const saved = override !== null ? `data-saved="${override}"` : "";
    return (
      `<td data-sort="${effective ?? ""}">` +
        `<div class="stage-cell">` +
          (effective ? `<span class="chip chip-stage st${effective}">Stage ${effective}</span>` : '<span class="cell-muted">—</span>') +
          `<select class="stage-override" data-invoice-id="${inv.id}" aria-label="Override escalation stage" ${saved}>${options}</select>` +
        `</div>` +
        (override !== null ? `<div class="cell-muted" style="font-size:0.7rem;margin-top:4px;"><span class="pill pill-manual">manually set</span></div>` : "") +
      `</td>`
    );
  };

  let rows = "";
  if (invoices.length === 0) {
    rows =
      `<div class="empty"><strong>${esc(view.emptyHead)}</strong>` +
      `${esc(view.emptyBody)}</div>`;
  } else {
    for (const inv of invoices) {
      // Most recent reminder task for this invoice (reminder count only).
      const taskRow = db.query(
        "SELECT COUNT(*) AS reminders FROM reminder_tasks WHERE invoice_id=?"
      ).get(inv.id) as { reminders: number } | null;
      const reminders = taskRow?.reminders ?? 0;
      const days = daysOverdue(inv.due_date);
      const autoStage = autoStageFor(inv.due_date);
      rows +=
        "<tr>" +
          `<td><div class="cell-strong">${esc(inv.customer_name || "Unknown customer")}</div>` +
          (inv.customer_email ? `<div class="cell-muted" style="font-size:0.75rem;">${esc(inv.customer_email)}</div>` : "") +
          "</td>" +
          `<td class="cell-amount" data-sort="${inv.amount_cents}">${esc(formatMoney(inv.amount_cents, inv.currency))}</td>` +
          `<td class="cell-muted" data-sort="${esc(inv.due_date)}">${esc(formatDate(inv.due_date))}</td>` +
          `<td class="cell-strong" data-sort="${days ?? ""}">${days != null ? days + (days === 1 ? " day" : " days") : "—"}</td>` +
          stageControl(inv, autoStage) +
          `<td class="cell-muted" style="font-size:0.75rem;" data-sort="${reminders}">${reminders > 0 ? reminders + " reminder" + (reminders === 1 ? "" : "s") : "no reminders yet"}</td>` +
        "</tr>";
    }
    rows = `<div class="table-wrap"><table>
      <thead><tr><th scope="col">Customer</th>${thSort("amount", "Amount")}${thSort("due", "Due date")}${thSort("days", "Days overdue")}${thSort("stage", "Stage")}${thSort("reminders", "Reminders")}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  return renderPage(view.title, view.subtitle, summary, rows);
}

// ── GET /reminders — sent-reminder history ──

const LOG_COLUMNS = `
  SELECT sl.id, sl.status, sl.provider_message, sl.created_at AS sent_at,
         sl.resend_message_id, sl.opened_at, sl.open_count, sl.clicked_at, sl.click_count,
         rt.id AS task_id, rt.stage, rt.draft_subject, rt.draft_body, rt.invoice_id,
         i.id AS invoice_id, i.merchant_id, i.customer_name, i.customer_email, i.amount_cents, i.currency, i.due_date, i.stripe_invoice_id,
         m.sender_name
  FROM send_logs sl
  JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
  JOIN invoices i ON rt.invoice_id = i.id
  JOIN merchants m ON i.merchant_id = m.id
  WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=?`;
// A "real send" is any successful reminder send whose provider_message is
// not a test-mode [STUB SEND] (matches GET /stats emailsSent; the no-fake-
// sends rule). Stubs still appear in the list — labeled with a muted
// "Test send" pill and a row-test marker class (see handleRemindersPage) —
// and the shared list-page CSS hides row-test rows unconditionally, so
// merchants never see the team's internal test sends.

export function handleRemindersPage(db: Database, merchantId: number): Response {
  // One list, newest first — every successful reminder send, real and test
  // (stub) alike. There is no ?type= split anymore: test rows are labeled
  // per-row with a muted "Test send" pill and a row-test marker class, and
  // the shared list-page CSS hides row-test rows unconditionally (no toggle —
  // merchants never see internal test sends).
  // ORDER BY sl.created_at DESC, sl.id DESC = newest first (matches the
  // subtitle copy; id DESC breaks ties deterministically for same-second rows).
  // Each row carries a "View email" toggle that reveals the EXACT sent
  // content: the persisted draft (draft_subject/draft_body — never
  // regenerated), the sender's From address (global FROM_EMAIL + the
  // merchant's sender_name display-name branding), the system-tracked
  // Reply-To (reply+{invoice_id}@{REPLY_DOMAIN}), and the CAN-SPAM footer
  // (appended at send time by appendCanspamFooter — reconstructed
  // deterministically here so what the recipient saw is shown).

  const logs = db.query(
    `${LOG_COLUMNS} ORDER BY sl.created_at DESC, sl.id DESC LIMIT 200`
  ).all(merchantId) as Array<{
    id: number; status: string; provider_message: string; sent_at: string;
    resend_message_id: string | null; opened_at: string | null; open_count: number; clicked_at: string | null; click_count: number;
    task_id: number; stage: number; draft_subject: string; draft_body: string; invoice_id: number;
    merchant_id: number; customer_name: string; customer_email: string; amount_cents: number; currency: string; due_date: string; stripe_invoice_id: string;
    sender_name: string | null;
  }>;

  // The footer is deterministic (process.env.BASE_URL / BUSINESS_ADDRESS +
  // merchant + customer scope): reconstruct it exactly as the send appended it.
  const sentBodyFor = (log: typeof logs[number]): string => {
    const body = String(log.draft_body ?? "").trimEnd();
    return body ? appendCanspamFooter(body, log.merchant_id, log.customer_email) : "";
  };
  const fromFor = (log: typeof logs[number]): string =>
    buildFromAddress(process.env.FROM_EMAIL || "noreply@stripecollectionscopilot.com", log.sender_name);
  const replyToFor = (log: typeof logs[number]): string | undefined =>
    trackedReplyToForTask({ invoice_id: log.invoice_id } as { invoice_id: number });

  // Resend open/click engagement (migration 034 / /webhook/resend-events).
  // PRO-TIER FEATURE (owner 9/2): the engagement pill is displayed ONLY for
  // active Pro subscribers (and dev-flagged Pro merchants). Data collection is
  // un-gated — the webhook keeps recording opened_at/open_count/clicked_at/
  // click_count for every send — but free/Standard merchants see nothing in
  // this slot: a bare "—" (no "locked", no "upgrade", no hint that tracking
  // exists). The sell for the feature lives on the landing page, not as a
  // teaser inside the product.
  //   - no resend_message_id → "No data" (stub/legacy rows — honest, unlike a
  //     fabricated "Not opened"; a send without a Resend id was never tracked)
  //   - resend id, no opens yet → "Not opened"
  //   - opened_at set   → "Opened" (title shows the timestamp; count when >1)
  //   - clicked_at set  → "Opened & clicked" (a click implies an open)
  // Lightweight pill next to each row — no new page, no JS. Colors via the
  // chip-engagement-* classes in list-page.html.
  const isPro = isActiveProSubscriber(db, merchantId);
  const engagementPayload = (log: typeof logs[number]): { label: string; cls: string; title: string } | null => {
    if (!log.resend_message_id) return null;
    if (log.clicked_at) {
      return { label: "Opened & clicked", cls: "chip-engagement-clicked", title: `Clicked ${log.clicked_at} — opened ${log.opened_at ?? "n/a"}` };
    }
    if (log.opened_at) {
      return { label: "Opened", cls: "chip-engagement-opened", title: `Opened ${log.opened_at}${log.open_count > 1 ? ` (${log.open_count} opens)` : ""}` };
    }
    return { label: "Not opened", cls: "chip-engagement-none", title: "No opens recorded yet" };
  };
  const engagement = (log: typeof logs[number]): string => {
    if (!isPro) return '<span class="cell-muted">—</span>';
    const p = engagementPayload(log);
    if (!p) {
      return '<span class="chip chip-engagement chip-engagement-none" title="No engagement data for this send">No data</span>';
    }
    return `<span class="chip chip-engagement ${p.cls}" title="${esc(p.title)}">${esc(p.label)}</span>`;
  };

  let rows = "";
  if (logs.length === 0) {
    rows =
      `<div class="empty"><strong>No sent reminders yet</strong>` +
      "When reminders are sent, they'll show up here with their delivery details." +
      "</div>";
  } else {
    for (const log of logs) {
      const isStub = String(log.provider_message).includes("[STUB SEND]");
      const body = sentBodyFor(log);
      const from = fromFor(log);
      const replyTo = replyToFor(log);
      const detail =
        `<button type="button" class="email-toggle" data-id="${log.id}" aria-expanded="false">View email</button>` +
        `<div class="email-body" id="emailbody-${log.id}" hidden>` +
          `<dl class="email-meta">` +
            `<div class="meta-row"><dt>From</dt><dd>${esc(from)}</dd></div>` +
            (replyTo ? `<div class="meta-row"><dt>Reply-To</dt><dd>${esc(replyTo)}</dd></div>` : "") +
            `<div class="meta-row"><dt>Subject</dt><dd>${log.draft_subject ? esc(log.draft_subject) : '<span class="cell-muted">—</span>'}</dd></div>` +
          `</dl>` +
          `<pre class="email-pre">${body ? esc(body) : '<span class="cell-muted">(no body recorded for this send)</span>'}</pre>` +
        `</div>`;
      rows +=
        "<tr" + (isStub ? ' class="row-test"' : "") + ">" +
          `<td class="cell-toggle">${detail}</td>` +
          `<td><div class="cell-strong">${esc(log.customer_name || "Unknown customer")}` +
          (isStub ? ` <span class="pill pill-muted">Test send</span>` : "") +
          "</div>" +
          (log.customer_email ? `<div class="cell-muted" style="font-size:0.75rem;">${esc(log.customer_email)}</div>` : "") +
          "</td>" +
          `<td class="cell-amount" data-sort="${log.amount_cents}">${esc(formatMoney(log.amount_cents, log.currency))}</td>` +
          `<td data-sort="${log.stage}">${chip("chip-stage st" + log.stage, "Stage " + log.stage)}</td>` +
          `<td class="cell-muted" data-sort="${esc(log.sent_at)}">${esc(formatDateTime(log.sent_at))}</td>` +
          `<td data-sort="${log.open_count + log.click_count}">${engagement(log)}</td>` +
          `<td data-sort="${esc(log.draft_subject ?? "")}">${log.draft_subject ? esc(log.draft_subject) : '<span class="cell-muted">—</span>'}</td>` +
          `<td>${isStub ? chip("chip-stub", "Test send") : chip("chip-sent", "Sent")}</td>` +
        "</tr>";
    }
    rows = `<div class="table-wrap"><table>
      <thead><tr><th scope="col">Email</th><th scope="col">Customer</th>${thSort("amount", "Amount")}${thSort("stage", "Stage")}${thSort("sent_at", "Sent at")}${thSort("engagement", "Engagement")}${thSort("subject", "Subject")}<th scope="col">Result</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  const engagementSubtitle = isPro
    ? "The Engagement column shows whether a recipient opened or clicked each reminder (via Resend open/click tracking). "
    : "";
  return renderPage(
    "Sent reminders",
    "Reminder emails sent to your customers, newest first. " + engagementSubtitle +
      "Test sends are labeled “Test send”. Open any row to see the full email exactly as sent.",
    "",
    rows
  );
}
