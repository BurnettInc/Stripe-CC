import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Server-side rendered list pages for the dashboard's drill-down links:
//   GET /past-due  — past-due (overdue) invoices
//   GET /reminders — sent-reminder history
// Both use the same session-cookie auth as every other dashboard route (the
// caller — index.ts — runs requireSession() before invoking these) and render
// the shared list-page shell (app/src/ui/list-page.html) with the dashboard's
// design tokens, so the pages look like the dashboard they came from.
//
// Both pages are filterable via query params and sortable client-side:
//   /past-due?status=all|overdue|paid|refunded|disputed  (default overdue)
//   /reminders?type=all|real                             (default all)
// The summary chips are real <a> tabs (work without JS — server-side
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
    emptyBody: "Invoices appear here once CollectionsCopilot starts tracking them.",
  },
  {
    key: "overdue", chipLabel: "Overdue",
    title: "Past-due invoices",
    subtitle: "Overdue invoices CollectionsCopilot is tracking for you — most overdue first.",
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
  }>;

  let rows = "";
  if (invoices.length === 0) {
    rows =
      `<div class="empty"><strong>${esc(view.emptyHead)}</strong>` +
      `${esc(view.emptyBody)}</div>`;
  } else {
    for (const inv of invoices) {
      // Most recent reminder task for this invoice (stage badge + reminder count).
      const taskRow = db.query(
        "SELECT stage, COUNT(*) AS reminders FROM reminder_tasks WHERE invoice_id=? GROUP BY stage ORDER BY created_at DESC, id DESC LIMIT 1"
      ).get(inv.id) as { stage: number; reminders: number } | null;
      const stage = taskRow?.stage ?? null;
      const reminders = taskRow?.reminders ?? 0;
      const days = daysOverdue(inv.due_date);
      const stageChip = stage
        ? `<span class="chip chip-stage st${stage}">Stage ${stage}</span>`
        : '<span class="cell-muted">—</span>';
      rows +=
        "<tr>" +
          `<td><div class="cell-strong">${esc(inv.customer_name || "Unknown customer")}</div>` +
          (inv.customer_email ? `<div class="cell-muted" style="font-size:0.75rem;">${esc(inv.customer_email)}</div>` : "") +
          "</td>" +
          `<td class="cell-amount" data-sort="${inv.amount_cents}">${esc(formatMoney(inv.amount_cents, inv.currency))}</td>` +
          `<td class="cell-muted" data-sort="${esc(inv.due_date)}">${esc(formatDate(inv.due_date))}</td>` +
          `<td class="cell-strong" data-sort="${days ?? ""}">${days != null ? days + (days === 1 ? " day" : " days") : "—"}</td>` +
          `<td data-sort="${stage ?? ""}">${stageChip}</td>` +
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
         rt.id AS task_id, rt.stage, rt.draft_subject,
         i.customer_name, i.customer_email, i.amount_cents, i.currency, i.due_date, i.stripe_invoice_id
  FROM send_logs sl
  JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
  JOIN invoices i ON rt.invoice_id = i.id
  WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=?`;
// Matches GET /stats emailsSent: a "real send" is any successful reminder
// send whose provider_message is not a test-mode [STUB SEND]. A stub can
// never count as a real send (the no-fake-sends rule); stubs still appear in
// the "All sends" view, clearly labeled "Test send".
const REAL_ONLY_FILTER = " AND sl.provider_message NOT LIKE '%[STUB SEND]%'";

export function handleRemindersPage(db: Database, merchantId: number, typeParam: string = "all"): Response {
  const realOnly = typeParam === "real";

  const countAll = (db.query(`SELECT COUNT(*) AS n FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id JOIN invoices i ON rt.invoice_id = i.id WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=?`).get(merchantId) as { n: number }).n;
  const countReal = (db.query(`SELECT COUNT(*) AS n FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id JOIN invoices i ON rt.invoice_id = i.id WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=?${REAL_ONLY_FILTER}`).get(merchantId) as { n: number }).n;

  const summary =
    chipLink("/reminders?type=all", `All sends · ${countAll}`, !realOnly) +
    chipLink("/reminders?type=real", `${countReal} real ${countReal === 1 ? "send" : "sends"}`, realOnly) +
    (countAll > countReal ? `<span class="summary-note">test sends excluded from real sends</span>` : "");

  const logs = db.query(
    `${LOG_COLUMNS}${realOnly ? REAL_ONLY_FILTER : ""} ORDER BY sl.created_at DESC, sl.id DESC LIMIT 200`
  ).all(merchantId) as Array<{
    id: number; status: string; provider_message: string; sent_at: string;
    task_id: number; stage: number; draft_subject: string;
    customer_name: string; customer_email: string; amount_cents: number; currency: string; due_date: string; stripe_invoice_id: string;
  }>;

  let rows = "";
  if (logs.length === 0) {
    const stubOnly = realOnly && countAll > 0;
    rows =
      `<div class="empty"><strong>${stubOnly ? "No real sends yet" : "No sent reminders yet"}</strong>` +
      (stubOnly
        ? "Test-mode stub sends are excluded from this view — switch to “All sends” to see them."
        : "When reminders are sent, they'll show up here with their delivery details.") +
      "</div>";
  } else {
    for (const log of logs) {
      const isStub = String(log.provider_message).includes("[STUB SEND]");
      rows +=
        "<tr>" +
          `<td><div class="cell-strong">${esc(log.customer_name || "Unknown customer")}</div>` +
          (log.customer_email ? `<div class="cell-muted" style="font-size:0.75rem;">${esc(log.customer_email)}</div>` : "") +
          "</td>" +
          `<td class="cell-amount" data-sort="${log.amount_cents}">${esc(formatMoney(log.amount_cents, log.currency))}</td>` +
          `<td data-sort="${log.stage}">${chip("chip-stage st" + log.stage, "Stage " + log.stage)}</td>` +
          `<td class="cell-muted" data-sort="${esc(log.sent_at)}">${esc(formatDateTime(log.sent_at))}</td>` +
          `<td data-sort="${esc(log.draft_subject ?? "")}">${log.draft_subject ? esc(log.draft_subject) : '<span class="cell-muted">—</span>'}</td>` +
          `<td>${isStub ? chip("chip-stub", "Test send") : chip("chip-sent", "Sent")}</td>` +
        "</tr>";
    }
    rows = `<div class="table-wrap"><table>
      <thead><tr><th scope="col">Customer</th>${thSort("amount", "Amount")}${thSort("stage", "Stage")}${thSort("sent_at", "Sent at")}${thSort("subject", "Subject")}<th scope="col">Result</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  return renderPage(
    realOnly ? "Real sends" : "Sent reminders",
    realOnly
      ? "Reminder emails actually delivered to your customers, newest first."
      : "Reminder emails sent to your customers, newest first. Test sends are labeled “Test send”.",
    summary,
    rows
  );
}
