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

// ── GET /past-due — past-due invoices ──

export function handlePastDuePage(db: Database, merchantId: number): Response {
  const overdue = db.query(
    "SELECT * FROM invoices WHERE merchant_id=? AND status='overdue' ORDER BY due_date ASC, id ASC"
  ).all(merchantId) as Array<{
    id: number; stripe_invoice_id: string; customer_name: string; customer_email: string;
    amount_cents: number; currency: string; due_date: string; status: string; created_at: string;
  }>;
  const total = (db.query("SELECT COUNT(*) AS n FROM invoices WHERE merchant_id=?").get(merchantId) as { n: number }).n;
  const paid = (db.query("SELECT COUNT(*) AS n FROM invoices WHERE merchant_id=? AND status='paid'").get(merchantId) as { n: number }).n;

  const summary =
    `<span class="summary-chip">${overdue.length} overdue</span>` +
    `<span class="summary-chip neutral">${paid} paid</span>` +
    `<span class="summary-chip neutral">${total} invoices total</span>`;

  let rows = "";
  if (overdue.length === 0) {
    rows =
      `<div class="empty"><strong>No past-due invoices</strong>` +
      `Newly overdue invoices will appear here automatically. You're all caught up.</div>`;
  } else {
    for (const inv of overdue) {
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
          `<td class="cell-amount">${esc(formatMoney(inv.amount_cents, inv.currency))}</td>` +
          `<td class="cell-muted">${esc(formatDate(inv.due_date))}</td>` +
          `<td class="cell-strong">${days != null ? days + (days === 1 ? " day" : " days") : "—"}</td>` +
          `<td>${stageChip}</td>` +
          `<td class="cell-muted" style="font-size:0.75rem;">${reminders > 0 ? reminders + " reminder" + (reminders === 1 ? "" : "s") : "no reminders yet"}</td>` +
        "</tr>";
    }
    rows = `<div class="table-wrap"><table>
      <thead><tr><th>Customer</th><th>Amount</th><th>Due date</th><th>Days overdue</th><th>Stage</th><th>Reminders</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  return renderPage(
    "Past-due invoices",
    "Overdue invoices CollectionsCopilot is tracking for you — most overdue first.",
    summary,
    rows
  );
}

// ── GET /reminders — sent-reminder history ──

export function handleRemindersPage(db: Database, merchantId: number): Response {
  const logs = db.query(`
    SELECT sl.id, sl.status, sl.provider_message, sl.created_at AS sent_at,
           rt.id AS task_id, rt.stage, rt.draft_subject,
           i.customer_name, i.customer_email, i.amount_cents, i.currency, i.due_date, i.stripe_invoice_id
    FROM send_logs sl
    JOIN reminder_tasks rt ON sl.reminder_task_id = rt.id
    JOIN invoices i ON rt.invoice_id = i.id
    WHERE sl.type='reminder' AND sl.status='success' AND i.merchant_id=?
    ORDER BY sl.created_at DESC, sl.id DESC
    LIMIT 200
  `).all(merchantId) as Array<{
    id: number; status: string; provider_message: string; sent_at: string;
    task_id: number; stage: number; draft_subject: string;
    customer_name: string; customer_email: string; amount_cents: number; currency: string; due_date: string; stripe_invoice_id: string;
  }>;

  const total = logs.length;
  // Real sends = rows whose provider message is not a [STUB SEND] (test-mode
  // stub). Matches /stats emailsSent. Never counts a stub as a real send.
  const real = logs.filter((l) => !String(l.provider_message).includes("[STUB SEND]")).length;

  const summary =
    `<span class="summary-chip">${total} sent</span>` +
    `<span class="summary-chip neutral">${real} real ${real === 1 ? "send" : "sends"}${total > real ? " (test sends excluded)" : ""}</span>`;

  let rows = "";
  if (logs.length === 0) {
    rows =
      `<div class="empty"><strong>No sent reminders yet</strong>` +
      `When reminders are sent, they'll show up here with their delivery details.</div>`;
  } else {
    for (const log of logs) {
      const isStub = String(log.provider_message).includes("[STUB SEND]");
      rows +=
        "<tr>" +
          `<td><div class="cell-strong">${esc(log.customer_name || "Unknown customer")}</div>` +
          (log.customer_email ? `<div class="cell-muted" style="font-size:0.75rem;">${esc(log.customer_email)}</div>` : "") +
          "</td>" +
          `<td class="cell-amount">${esc(formatMoney(log.amount_cents, log.currency))}</td>` +
          `<td>${chip("chip-stage st" + log.stage, "Stage " + log.stage)}</td>` +
          `<td class="cell-muted">${esc(formatDateTime(log.sent_at))}</td>` +
          `<td>${log.draft_subject ? esc(log.draft_subject) : '<span class="cell-muted">—</span>'}</td>` +
          `<td>${isStub ? chip("chip-stub", "Test send") : chip("chip-sent", "Sent")}</td>` +
        "</tr>";
    }
    rows = `<div class="table-wrap"><table>
      <thead><tr><th>Customer</th><th>Amount</th><th>Stage</th><th>Sent at</th><th>Subject</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  return renderPage(
    "Sent reminders",
    "Reminder emails sent to your customers, newest first.",
    summary,
    rows
  );
}
