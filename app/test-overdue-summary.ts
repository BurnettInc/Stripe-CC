/**
 * Overdue-summary + manual pause/resume endpoint tests (drawer feature).
 *
 * Covers:
 *   (a) GET /overdue/summary unauthenticated → 401 (with CORS headers for
 *       Origin: null — the drawer's sandboxed iframe);
 *   (b) summary with an empty account → 200, zeroed shape;
 *   (c) summary shape with seeded data: counts + per-invoice status
 *       (active / paused / awaiting_approval), pause_reason, sorting by days
 *       overdue desc, exclusions (paid / disputed / refunded / opted-out),
 *       sent-task invoices listed 'active' but excluded from counts.active,
 *       cancelled-task invoices active-again, recent_reminders capped at 5;
 *   (d) POST /tasks/pause: 400 malformed, 404 unknown/foreign, 200 pause
 *       (manually_paused_at set, open tasks parked to 'paused');
 *   (e) watcher guard: re-fired invoice.overdue for a manually-paused invoice
 *       is skipped ("manually-paused"), no new task created;
 *   (f) pause idempotent: second pause → 200 no-op;
 *   (g) POST /tasks/resume: clears manual (+ reply) pause, parks cancelled,
 *       re-opens a fresh drafted/reviewed task at the current escalation
 *       stage, does NOT auto-send;
 *   (h) resume idempotent → 200 no-op; resume clears BOTH pause types and
 *       reports `cleared`;
 *   (i) /process guard: a paused invoice's task cannot be processed (400).
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-overdue-summary.db),
 * like every other suite. The server MUST be booted with the provider keys
 * stripped (log-only mode — see /tmp/run-suite.sh overdue-summary).
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-overdue-summary.db bun run test-overdue-summary.ts
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-overdue-summary.db";
const SESSION = "summary-session";
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}
function invoiceRow(invoiceId: number): Record<string, unknown> {
  const d = db();
  const row = d.query("SELECT * FROM invoices WHERE id=?").get(invoiceId) as Record<string, unknown> | undefined;
  d.close();
  return row ?? {};
}
function tasksFor(invoiceId: number): Array<Record<string, unknown>> {
  const d = db();
  const rows = d.query("SELECT id, status, stage FROM reminder_tasks WHERE invoice_id=? ORDER BY id DESC").all(invoiceId) as Array<Record<string, unknown>>;
  d.close();
  return rows;
}
function openTasks(invoiceId: number): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=? AND status IN ('pending','drafted','reviewed')").get(invoiceId) as { n: number };
  d.close();
  return row.n;
}
function countReminderSends(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='reminder' AND status='success'").get() as { n: number };
  d.close();
  return row.n;
}
const authHeaders = { "Content-Type": "application/json", Cookie: `session=${SESSION}` };
async function af(path: string, init: RequestInit = {}, headers: Record<string, string> = authHeaders): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
}

/** Seed session + active Pro subscription for the default merchant (id 1). */
function seedSessionAndSub(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.run(
    "INSERT OR REPLACE INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (1, 'sub_summary', 'pro', 'active')",
  );
  d.close();
}

/**
 * Seed an overdue invoice for merchant 1. Returns its internal id.
 * opts: taskStatus (insert a task with this status), paused ('reply'|'manual'|
 * 'both'|null to set the corresponding flag), daysOverdue, status, dispute,
 * refund, optOut.
 */
function seedInvoice(sid: string, opts: {
  daysOverdue?: number; taskStatus?: string | null; paused?: "reply" | "manual" | "both" | null;
  status?: string; dispute?: boolean; refund?: boolean; optOut?: boolean;
} = {}): number {
  const d = db();
  const due = new Date(Date.now() - (opts.daysOverdue ?? 3) * 86400e3).toISOString();
  const replyPaused = opts.paused === "reply" || opts.paused === "both" ? new Date().toISOString() : null;
  const manualPaused = opts.paused === "manual" || opts.paused === "both" ? new Date().toISOString() : null;
  const r = d.run(
    `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency,
                           due_date, status, dispute_id, refund_id, reply_paused_at, manually_paused_at, reply_opt_out_at)
     VALUES (?, 1, 'Jane Customer', 'jane@customer.com', 5000, 'usd', ?, ?, ?, ?, ?, ?, ?)`,
    [sid, due, opts.status ?? "overdue", opts.dispute ? "dp_1" : null, opts.refund ? "re_1" : null, replyPaused, manualPaused, opts.optOut ? "opt_1" : null],
  );
  const id = Number(r.lastInsertRowid);
  if (opts.taskStatus) {
    d.run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Subject', 'Body text')", [id, opts.taskStatus]);
  }
  d.close();
  return id;
}

async function main(): Promise<void> {
  // ── (a) Auth: 401 without session; CORS headers still present for Origin: null ──
  {
    const noSession = await fetch(`${BASE}/overdue/summary`, { headers: { Origin: "null" } });
    check("(a) /overdue/summary without session → 401", noSession.status === 401, `status=${noSession.status}`);
    check("(a) 401 carries Access-Control-Allow-Origin: null", noSession.headers.get("Access-Control-Allow-Origin") === "null",
      `acaoo=${noSession.headers.get("Access-Control-Allow-Origin")}`);
  }

  seedSessionAndSub();

  // ── (b) Empty account → zeroed shape ──
  {
    const res = await af("/overdue/summary");
    const body = await res.json() as {
      counts: { total: number; active: number; paused: number; awaiting_approval: number };
      invoices: unknown[]; recent_reminders: unknown[];
    };
    check("(b) empty summary → 200 with zeroed counts", res.status === 200
      && body.counts.total === 0 && body.counts.active === 0 && body.counts.paused === 0 && body.counts.awaiting_approval === 0
      && Array.isArray(body.invoices) && body.invoices.length === 0
      && Array.isArray(body.recent_reminders) && body.recent_reminders.length === 0, JSON.stringify(body));
    check("(b) summary 200 carries CORS for Origin: null", (await af("/overdue/summary", {}, { ...authHeaders, Origin: "null" })).headers.get("Access-Control-Allow-Origin") === "null");
  }

  // ── (c) Shape with seeded data ──
  let activeNoTaskId = 0; let awaitingId = 0; let sentId = 0; let cancelledId = 0;
  {
    activeNoTaskId = seedInvoice("sum_active", { daysOverdue: 3 });                       // no task → active
    awaitingId = seedInvoice("sum_await", { daysOverdue: 9, taskStatus: "reviewed" });    // reviewed → awaiting_approval
    sentId = seedInvoice("sum_sent", { daysOverdue: 15, taskStatus: "sent" });            // sent → listed active, not in counts.active
    cancelledId = seedInvoice("sum_cancel", { daysOverdue: 21, taskStatus: "cancelled" }); // cancelled → active-again
    seedInvoice("sum_paid", { status: "paid" });                                          // excluded (not overdue)
    seedInvoice("sum_disputed", { daysOverdue: 5, dispute: true });                       // excluded (disputed)
    seedInvoice("sum_refunded", { daysOverdue: 5, refund: true });                        // excluded (refunded)
    seedInvoice("sum_opted", { daysOverdue: 5, optOut: true });                           // excluded (opted out)
    seedInvoice("sum_reply", { daysOverdue: 12, paused: "reply" });                       // reply-paused
    // 6 send_logs for recent_reminders (only 5 returned); all reference
    // invoices that HAVE tasks (reminder_task_id=0 rows drop out of the JOIN)
    const d = db();
    for (const [i, invId] of [awaitingId, sentId, cancelledId, awaitingId, sentId, cancelledId].entries()) {
      const taskId = d.query("SELECT id FROM reminder_tasks WHERE invoice_id=?").get(invId) as { id: number } | null;
      d.run("INSERT INTO send_logs (reminder_task_id, type, status, provider_message) VALUES (?, 'reminder', 'success', ?)",
        [taskId?.id ?? 0, `send-${i}`]);
    }
    d.close();

    const res = await af("/overdue/summary");
    const body = await res.json() as {
      counts: { total: number; active: number; paused: number; awaiting_approval: number };
      invoices: Array<{ id: number; stripe_invoice_id: string; customer_name: string; amount_due: number; currency: string; days_overdue: number; stage: number; status: string; pause_reason: string | null }>;
      recent_reminders: Array<{ invoice_id: number; customer_name: string; amount_due: number; currency: string; stage: number; sent_at: string }>;
    };
    check("(c) total counts only overdue non-stopped invoices (5)", body.counts.total === 5,
      `total=${body.counts.total} invoices=${JSON.stringify(body.invoices.map(i => i.stripe_invoice_id))}`);
    check("(c) active excludes sent-task invoice (2: no-task + cancelled)", body.counts.active === 2, `active=${body.counts.active}`);
    check("(c) paused = 1 (reply)", body.counts.paused === 1, `paused=${body.counts.paused}`);
    check("(c) awaiting_approval = 1 (reviewed)", body.counts.awaiting_approval === 1, `awaiting=${body.counts.awaiting_approval}`);
    const byId = new Map(body.invoices.map((i) => [i.id, i]));
    check("(c) sent-task invoice listed with status 'active' + null pause_reason",
      byId.get(sentId)?.status === "active" && byId.get(sentId)?.pause_reason === null, JSON.stringify(byId.get(sentId)));
    check("(c) cancelled-task invoice listed active (active-again)",
      byId.get(cancelledId)?.status === "active", JSON.stringify(byId.get(cancelledId)));
    check("(c) reviewed-task invoice awaiting_approval with null pause_reason",
      byId.get(awaitingId)?.status === "awaiting_approval" && byId.get(awaitingId)?.pause_reason === null, JSON.stringify(byId.get(awaitingId)));
    const replyRow = body.invoices.find((i) => i.stripe_invoice_id === "sum_reply");
    check("(c) reply-paused invoice paused with pause_reason 'reply'",
      replyRow?.status === "paused" && replyRow?.pause_reason === "reply", JSON.stringify(replyRow));
    check("(c) rows sorted by days overdue desc",
      body.invoices.every((inv, idx) => idx === 0 || body.invoices[idx - 1].days_overdue >= inv.days_overdue),
      JSON.stringify(body.invoices.map((i) => i.days_overdue)));
    check("(c) row shape has all fields", body.invoices.length === 5 && body.invoices.every((i) =>
      typeof i.id === "number" && typeof i.stripe_invoice_id === "string" && typeof i.customer_name === "string"
      && typeof i.amount_due === "number" && typeof i.currency === "string"
      && typeof i.days_overdue === "number" && typeof i.stage === "number"
      && ["active", "paused", "awaiting_approval"].includes(i.status)
      && (i.pause_reason === null || i.pause_reason === "manual" || i.pause_reason === "reply")), JSON.stringify(body.invoices));
    check("(c) recent_reminders capped at 5, newest first", body.recent_reminders.length === 5
      && body.recent_reminders.every((r) => typeof r.invoice_id === "number" && typeof r.amount_due === "number"
        && typeof r.currency === "string" && typeof r.stage === "number" && typeof r.sent_at === "string"), JSON.stringify(body.recent_reminders));
  }

  // ── (d) POST /tasks/pause ──
  let pauseTargetId = 0;
  {
    const bad = await af("/tasks/pause", { method: "POST", headers: authHeaders, body: JSON.stringify({}) });
    check("(d) pause missing invoice_id → 400", bad.status === 400, `status=${bad.status}`);
    const unknown = await af("/tasks/pause", { method: "POST", headers: authHeaders, body: JSON.stringify({ invoice_id: 999999 }) });
    check("(d) pause unknown invoice → 404", unknown.status === 404, `status=${unknown.status}`);
    const unauth = await fetch(`${BASE}/tasks/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: 1 }) });
    check("(d) pause without session → 401", unauth.status === 401, `status=${unauth.status}`);

    pauseTargetId = seedInvoice("sum_pause_target", { daysOverdue: 30, taskStatus: "reviewed" });
    const res = await af("/tasks/pause", { method: "POST", headers: authHeaders, body: JSON.stringify({ invoice_id: pauseTargetId }) });
    const body = await res.json() as { ok: boolean; invoice_id: number; paused: boolean };
    const inv = invoiceRow(pauseTargetId);
    const tasks = tasksFor(pauseTargetId);
    check("(d) pause → 200 {ok, invoice_id, paused:true}", res.status === 200 && body.ok === true && body.invoice_id === pauseTargetId && body.paused === true, JSON.stringify(body));
    check("(d) manually_paused_at set on invoice", typeof inv.manually_paused_at === "string" && inv.manually_paused_at !== "", JSON.stringify(inv));
    check("(d) open reviewed task parked to 'paused'", tasks.length === 1 && tasks[0].status === "paused", JSON.stringify(tasks));
    check("(d) paused task gone from approval inbox", openTasks(pauseTargetId) === 0, `open=${openTasks(pauseTargetId)}`);
    // summary now shows it paused with reason 'manual'
    const summary = await (await af("/overdue/summary")).json() as { invoices: Array<{ id: number; status: string; pause_reason: string | null }> };
    const row = summary.invoices.find((i) => i.id === pauseTargetId);
    check("(d) summary shows manual pause with pause_reason 'manual'", row?.status === "paused" && row?.pause_reason === "manual", JSON.stringify(row));
  }

  // ── (e) Watcher guard: re-fired overdue event must not recreate a task ──
  {
    const inv = invoiceRow(pauseTargetId);
    const res = await fetch(`${BASE}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "invoice.overdue",
        data: { object: { id: inv.stripe_invoice_id, amount_due: 5000, currency: "usd", due_date: Math.floor(Date.now() / 1000) - 30 * 86400, status: "open" } },
      }),
    });
    const body = await res.json() as { action: string };
    check("(e) stale overdue event skipped with manually-paused reason", res.status === 200 && String(body.action).includes("manually-paused"), JSON.stringify(body));
    check("(e) no new task created for the paused invoice", tasksFor(pauseTargetId).length === 1 && tasksFor(pauseTargetId)[0].status === "paused", JSON.stringify(tasksFor(pauseTargetId)));
  }

  // ── (f) Pause idempotent ──
  {
    const again = await af("/tasks/pause", { method: "POST", headers: authHeaders, body: JSON.stringify({ invoice_id: pauseTargetId }) });
    const body = await again.json() as { ok: boolean; paused: boolean };
    check("(f) second pause → 200 no-op, still paused", again.status === 200 && body.ok === true && body.paused === true, JSON.stringify(body));
  }

  // ── (g) Resume: clears manual + reply, re-opens sequence, no auto-send ──
  let resumedTaskId = 0;
  {
    // Give the paused invoice BOTH pause types (reply + manual) to prove both clear.
    db().run("UPDATE invoices SET reply_paused_at=? WHERE id=?", [new Date().toISOString(), pauseTargetId]);
    const res = await af("/tasks/resume", { method: "POST", headers: authHeaders, body: JSON.stringify({ invoice_id: pauseTargetId }) });
    const body = await res.json() as { ok: boolean; paused: boolean; task_created: boolean; task_id: number; stage: number; cleared: string[] };
    const inv = invoiceRow(pauseTargetId);
    resumedTaskId = body.task_id ?? 0;
    check("(g) resume → 200, both pause flags cleared, cleared=['reply','manual']", res.status === 200 && body.ok === true && body.paused === false
      && body.task_created === true && inv.reply_paused_at === null && inv.manually_paused_at === null
      && Array.isArray(body.cleared) && body.cleared.includes("reply") && body.cleared.includes("manual"),
      `body=${JSON.stringify(body)} inv=${JSON.stringify(inv)}`);
    const tasks = tasksFor(pauseTargetId);
    const fresh = tasks.find((t) => t.id === resumedTaskId);
    check("(g) parked 'paused' task cancelled, fresh task created at stage 3 (30d overdue)", tasks.length === 2
      && tasks.some((t) => t.status === "cancelled") && fresh?.status !== undefined, JSON.stringify(tasks));
    const t = db().query("SELECT status, draft_body, stage FROM reminder_tasks WHERE id=?").get(resumedTaskId) as { status: string; draft_body: string; stage: number } | null;
    check("(g) re-opened task is reviewed with a draft (NOT auto-sent)", t !== null && t.status === "reviewed" && t.draft_body.length > 0 && t.stage === 3, JSON.stringify(t));
    check("(g) no reminder was sent by resume", countReminderSends() === 6, `sends=${countReminderSends()}`);
    // /process on the resumed task works (draft mode → reviewed, no send)
    const proc = await af(`/tasks/${resumedTaskId}/process`, { method: "POST", headers: authHeaders });
    const pb = await proc.json() as { task?: { status: string }; trustMode?: string };
    check("(g) resumed task processes normally (draft mode, no send)", proc.status === 200 && pb.task?.status === "reviewed" && pb.trustMode === "draft", `status=${proc.status} ${JSON.stringify(pb)}`);
  }

  // ── (h) Resume idempotent ──
  {
    const again = await af("/tasks/resume", { method: "POST", headers: authHeaders, body: JSON.stringify({ invoice_id: pauseTargetId }) });
    const body = await again.json() as { ok: boolean; task_created: boolean; cleared: string[] };
    check("(h) resume of unpaused invoice → 200 no-op", again.status === 200 && body.ok === true && body.task_created === false && body.cleared.length === 0, JSON.stringify(body));
  }

  // ── (i) /process guard blocks paused invoices ──
  {
    const target = seedInvoice("sum_guard", { daysOverdue: 4, taskStatus: "reviewed" });
    await af("/tasks/pause", { method: "POST", headers: authHeaders, body: JSON.stringify({ invoice_id: target }) });
    const taskId = tasksFor(target)[0].id;
    const proc = await af(`/tasks/${taskId}/process`, { method: "POST", headers: authHeaders });
    check("(i) /process on a paused invoice → 400", proc.status === 400, `status=${proc.status}`);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
