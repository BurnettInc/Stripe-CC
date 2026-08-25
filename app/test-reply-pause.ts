/**
 * Reply-pause + inbound reply webhook tests (D1a backend, owner 2026-08-12).
 *
 * Covers:
 *   (a) reminder sends ALWAYS carry the tracked Reply-To reply+{invoice}@
 *       replies.getcollectionscopilot.com — the merchant's reply_to (now the
 *       reply FORWARD target) never appears in a Reply-To header;
 *   (b) inbound webhook happy path: row inserted (reply_status 'captured' —
 *       advanced to 'pending_approval' by the D1b AI hook when no key is set),
 *       invoice paused, open tasks cancelled, reply forwarded to the forward
 *       target + merchant notified, 200 fast;
 *   (b3) a second DIFFERENT reply on an already reply-paused invoice is
 *       captured but never re-pauses / re-cancels;
 *   (c) duplicate webhook (same idempotency key — provider_message_id and
 *       derived) → 200 no-op, no double row/pause/forward/notify;
 *   (d) unknown sequence → 200 no-op, no row;
 *   (e) reply on an already-paid invoice → captured but NOT paused, task kept;
 *   (f) stale overdue webhook after reply-pause → skipped, no new task;
 *   (g) resume clears the pause and re-opens the sequence (fresh drafted task
 *       that can be processed again);
 *   (h) resume idempotent (no-op success), 400 on bad body, 404 on unknown /
 *       foreign invoice;
 *   (i) unauthenticated resume → 401;
 *   (j) inbound webhook with no / wrong token → 403.
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-reply-pause.db), like
 * every other suite. The server MUST be booted with
 * INBOUND_WEBHOOK_TOKEN=test-inbound-token (see /tmp/run-suite.sh reply-pause)
 * and the provider keys stripped (log-only mode).
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-reply-pause.db bun run test-reply-pause.ts
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-reply-pause.db";
const SESSION = "reply-pause-session";
const MERCHANT = 2; // dedicated merchant with a real email + forward target
const INBOUND_TOKEN = "test-inbound-token"; // must match the run-suite env
const TRACKED_DOMAIN = "replies.getcollectionscopilot.com";
const FORWARD_TARGET = "forward-target@example.com";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function db(): Database {
  return new Database(DB_PATH);
}

function countRepliesForInvoice(invoiceId: number): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM inbound_replies WHERE invoice_id=?").get(invoiceId) as { n: number };
  d.close();
  return row.n;
}

function replyRow(invoiceId: number): Record<string, unknown> {
  const d = db();
  const row = d.query("SELECT * FROM inbound_replies WHERE invoice_id=? ORDER BY id DESC LIMIT 1").get(invoiceId) as Record<string, unknown> | undefined;
  d.close();
  return row ?? {};
}

function invoiceRow(invoiceId: number): Record<string, unknown> {
  const d = db();
  const row = d.query("SELECT * FROM invoices WHERE id=?").get(invoiceId) as Record<string, unknown> | undefined;
  d.close();
  return row ?? {};
}

function openTasks(invoiceId: number): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=? AND status IN ('pending','drafted','reviewed')").get(invoiceId) as { n: number };
  d.close();
  return row.n;
}

function countLogType(type: string): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE type=?").get(type) as { n: number };
  d.close();
  return row.n;
}

/** Seed a fresh invoice for the dedicated merchant. Returns its internal id. */
function seedInvoice(sid: string, opts: { status?: string; daysOverdue?: number; paused?: boolean; taskStatus?: string | null } = {}): number {
  const d = db();
  const due = new Date(Date.now() - (opts.daysOverdue ?? 3) * 86400e3).toISOString();
  const r = d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, reply_paused_at) VALUES (?, ?, 'Jane Customer', 'jane@customer.com', 5000, 'usd', ?, ?, ?)",
    [sid, MERCHANT, due, opts.status ?? "overdue", opts.paused ? new Date().toISOString() : null]
  );
  const id = Number(r.lastInsertRowid);
  if (opts.taskStatus) {
    d.run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Subject', 'Body text')", [id, opts.taskStatus]);
  }
  d.close();
  return id;
}

function seed(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, sender_name, reply_to, created_at) VALUES (?, 'acct_reply', 'merchant@example.com', 'draft', 'Reply Co', ?, datetime('now', '-40 days'))",
    [MERCHANT, FORWARD_TARGET]
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [SESSION, MERCHANT]);
  d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, tier, status) VALUES (1, ?, 'sub_reply', 'pro', 'active')", [MERCHANT]);
  d.run("DELETE FROM inbound_replies");
  d.run("DELETE FROM send_logs");
  d.run("DELETE FROM reminder_tasks");
  d.run("DELETE FROM invoices WHERE merchant_id=?", [MERCHANT]);
  d.close();
}

async function af(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Cookie", `session=${encodeURIComponent(SESSION)}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}

interface InboundBody {
  sequence_id: string;
  received_at?: string;
  from_email?: string;
  from_name?: string;
  subject?: string;
  body?: string;
  provider_message_id?: string;
}

function postInbound(body: InboundBody, token = INBOUND_TOKEN): Promise<Response> {
  return fetch(`${BASE}/inbound/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function fireOverdueWebhook(stripeInvoiceId: string, daysAgo: number): Promise<Response> {
  const due = Math.floor((Date.now() - daysAgo * 86400e3) / 1000);
  return fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      data: { object: { id: stripeInvoiceId, customer_name: "Jane Customer", customer_email: "jane@customer.com", amount_due: 5000, currency: "usd", due_date: due } },
    }),
  });
}

async function main(): Promise<void> {
  // wait for health
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  seed();

  // ── (a) Sender: tracked Reply-To regardless of merchant reply_to ──
  {
    const invId = seedInvoice("rp_a", { taskStatus: "reviewed" });
    const taskId = (db().query("SELECT id FROM reminder_tasks WHERE invoice_id=?").get(invId) as { id: number }).id;
    const approve = await af(`/tasks/${taskId}/approve`, { method: "POST" });
    const a = await approve.json();
    const d = db();
    const log = d.query("SELECT provider_message FROM send_logs WHERE reminder_task_id=? AND status='success' ORDER BY id DESC LIMIT 1").get(taskId) as { provider_message: string } | null;
    d.close();
    const msg = log?.provider_message || "";
    const tracked = `reply+${invId}@${TRACKED_DOMAIN}`;
    check("(a) approve send carries TRACKED Reply-To reply+{invoice}@{domain}", approve.status === 200 && a.task?.status === "sent" && msg.includes(`Reply-To: ${tracked}`),
      `status=${approve.status} msg=${msg.slice(0, 300)}`);
    check("(a) merchant reply_to never appears in a Reply-To header", !msg.includes(`Reply-To: ${FORWARD_TARGET}`), msg);
  }

  // ── (b) Happy path: capture, pause, cancel tasks, forward, notify ──
  let pausedInvoiceId = 0;
  {
    const invId = seedInvoice("rp_b", { taskStatus: "reviewed" });
    pausedInvoiceId = invId;
    const notifyBefore = countLogType("merchant_notification");
    const res = await postInbound({
      sequence_id: String(invId),
      received_at: "2026-08-12T15:00:00Z",
      from_email: "jane@customer.com",
      from_name: "Jane Customer",
      subject: "Re: Friendly Reminder",
      body: "Hi — I'll pay next week, just waiting on my accountant.",
      provider_message_id: "msg-happy-1",
    });
    const body = await res.json();
    const row = replyRow(invId);
    const inv = invoiceRow(invId);
    const d = db();
    const forward = d.query("SELECT provider_message FROM send_logs WHERE type='reply_forward' ORDER BY id DESC LIMIT 1").get() as { provider_message: string } | null;
    d.close();
    const notifyAfter = countLogType("merchant_notification");

    check("(b) webhook 200 captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(b) inbound_replies row stored with full contract + D1b-processed status", row.id !== undefined && row.merchant_id === MERCHANT && row.invoice_id === invId && row.sequence_key === String(invId) && row.received_at === "2026-08-12T15:00:00Z" && row.from_email === "jane@customer.com" && row.from_name === "Jane Customer" && row.subject === "Re: Friendly Reminder" && row.body === "Hi — I'll pay next week, just waiting on my accountant." && row.idempotency_key === "msg-happy-1" && (row.reply_status === "captured" || row.reply_status === "pending_approval") && row.classification === "other" && row.confidence === 0 && (row.draft_reply_body as string).length > 0, JSON.stringify(row));
    check("(b) invoice reply_paused_at set", typeof inv.reply_paused_at === "string" && inv.reply_paused_at.length > 0, JSON.stringify(inv));
    check("(b) open reminder task cancelled", openTasks(invId) === 0, `open=${openTasks(invId)}`);
    check("(b) reply forwarded to merchant reply_to (forward target)", forward !== null && forward.provider_message.includes(FORWARD_TARGET), forward?.provider_message ?? "no row");
    check("(b) merchant notified (real-email merchant)", notifyAfter === notifyBefore + 1, `before=${notifyBefore} after=${notifyAfter}`);
  }

  // ── (b3) Second DIFFERENT reply on a reply-paused invoice: captured, no re-pause ──
  {
    const inv = invoiceRow(pausedInvoiceId);
    const pausedAt = inv.reply_paused_at as string;
    const res = await postInbound({
      sequence_id: String(pausedInvoiceId),
      from_email: "jane@customer.com",
      body: "Actually, can you send me the breakdown?",
      provider_message_id: "msg-happy-2",
    });
    const body = await res.json();
    const inv2 = invoiceRow(pausedInvoiceId);
    check("(b3) reply captured on already-paused invoice (200, paused:false)", res.status === 200 && body.status === "captured" && body.paused === false, JSON.stringify(body));
    check("(b3) reply_paused_at unchanged (never re-paused)", inv2.reply_paused_at === pausedAt, `before=${pausedAt} after=${inv2.reply_paused_at}`);
    check("(b3) no duplicate row (2 distinct replies stored)", countRepliesForInvoice(pausedInvoiceId) === 2, `n=${countRepliesForInvoice(pausedInvoiceId)}`);
  }

  // ── (c) Duplicate webhook: same idempotency key → 200 no-op ──
  {
    const invId = seedInvoice("rp_c", { taskStatus: "reviewed" });
    const payload = {
      sequence_id: String(invId),
      received_at: "2026-08-12T16:00:00Z",
      from_email: "jane@customer.com",
      body: "Duplicate test",
      provider_message_id: "msg-dup-1",
    };
    const notifyBefore = countLogType("merchant_notification");
    const fwdBefore = countLogType("reply_forward");
    const r1 = await postInbound(payload);
    const b1 = await r1.json();
    const r2 = await postInbound(payload);
    const b2 = await r2.json();
    const inv = invoiceRow(invId);
    check("(c) first delivery captured + paused", r1.status === 200 && b1.status === "captured" && b1.paused === true, JSON.stringify(b1));
    check("(c) duplicate delivery → 200 no-op (ignored/duplicate)", r2.status === 200 && b2.status === "ignored" && b2.reason === "duplicate", JSON.stringify(b2));
    check("(c) no double row", countRepliesForInvoice(invId) === 1, `n=${countRepliesForInvoice(invId)}`);
    check("(c) no double forward/notify", countLogType("reply_forward") === fwdBefore + 1 && countLogType("merchant_notification") === notifyBefore + 1,
      `fwd=${countLogType("reply_forward")} notify=${countLogType("merchant_notification")}`);
    check("(c) pause set exactly once", typeof inv.reply_paused_at === "string", JSON.stringify(inv));

    // derived-key dedupe (no provider_message_id): same seq+received_at+body
    const dPayload = { sequence_id: String(invId), received_at: "2026-08-12T17:00:00Z", from_email: "jane@customer.com", body: "derived key dedupe" };
    const nBefore = countRepliesForInvoice(invId);
    const rd1 = await postInbound(dPayload);
    const bd1 = await rd1.json();
    const rd2 = await postInbound(dPayload);
    const bd2 = await rd2.json();
    check("(c) derived idempotency key: first stored, replay ignored", rd1.status === 200 && bd1.status === "captured" && rd2.status === 200 && bd2.status === "ignored" && bd2.reason === "duplicate" && countRepliesForInvoice(invId) === nBefore + 1,
      `b1=${JSON.stringify(bd1)} b2=${JSON.stringify(bd2)} n=${countRepliesForInvoice(invId)}`);
  }

  // ── (d) Unknown sequence → 200 no-op ──
  {
    const nBefore = countRepliesForInvoice(999999);
    const res = await postInbound({ sequence_id: "999999", from_email: "jane@customer.com", body: "who dis" });
    const body = await res.json();
    check("(d) unknown sequence → 200 no-op (ignored/unknown_sequence)", res.status === 200 && body.status === "ignored" && body.reason === "unknown_sequence", JSON.stringify(body));
    check("(d) no row inserted", countRepliesForInvoice(999999) === nBefore, `n=${countRepliesForInvoice(999999)}`);
  }

  // ── (e) Reply on already-paid invoice: captured, NOT paused, task kept ──
  {
    const invId = seedInvoice("rp_e", { status: "paid", taskStatus: "reviewed" });
    const res = await postInbound({ sequence_id: String(invId), from_email: "jane@customer.com", body: "paid but replying anyway", provider_message_id: "msg-paid-1" });
    const body = await res.json();
    const inv = invoiceRow(invId);
    check("(e) reply on paid invoice captured, paused:false", res.status === 200 && body.status === "captured" && body.paused === false, JSON.stringify(body));
    check("(e) reply_paused_at stays NULL (no pause)", inv.reply_paused_at === null, JSON.stringify(inv));
    check("(e) open task NOT cancelled", openTasks(invId) === 1, `open=${openTasks(invId)}`);
  }

  // ── (f) Stale overdue webhook after reply-pause → skipped ──
  {
    const invId = seedInvoice("rp_f", { paused: true, taskStatus: "cancelled" });
    const sid = (db().query("SELECT stripe_invoice_id FROM invoices WHERE id=?").get(invId) as { stripe_invoice_id: string }).stripe_invoice_id;
    const res = await fireOverdueWebhook(sid, 2);
    const body = await res.json();
    const inv = invoiceRow(invId);
    check("(f) stale overdue event skipped with reply-paused reason", res.status === 200 && String(body.action).includes("reply-paused"), body.action);
    check("(f) no new task created, pause preserved", openTasks(invId) === 0 && inv.reply_paused_at !== null && inv.status === "overdue",
      `open=${openTasks(invId)} paused=${inv.reply_paused_at} status=${inv.status}`);
  }

  // ── (g) Resume: clears pause, re-opens sequence with a fresh drafted task ──
  let resumedInvoiceId = 0;
  let resumedTaskId = 0;
  {
    const invId = seedInvoice("rp_g", { taskStatus: "reviewed" });
    resumedInvoiceId = invId;
    const r1 = await postInbound({ sequence_id: String(invId), from_email: "jane@customer.com", body: "please pause", provider_message_id: "msg-resume-1" });
    const b1 = await r1.json();
    check("(g) setup: reply pauses the sequence", b1.status === "captured" && b1.paused === true, JSON.stringify(b1));

    const res = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: invId }) });
    const body = await res.json();
    const inv = invoiceRow(invId);
    resumedTaskId = body.task_id ?? 0;
    check("(g) resume clears reply_paused_at and re-opens a drafted task", res.status === 200 && body.ok === true && body.paused === false && body.task_created === true && inv.reply_paused_at === null,
      `status=${res.status} body=${JSON.stringify(body)} inv=${JSON.stringify(inv)}`);
    const t = db().query("SELECT status, draft_body FROM reminder_tasks WHERE id=?").get(resumedTaskId) as { status: string; draft_body: string } | null;
    check("(g) resumed task is reviewed with a draft (sequence can draft again)", t !== null && t.status === "reviewed" && t.draft_body.length > 0, JSON.stringify(t));

    const proc = await af(`/tasks/${resumedTaskId}/process`, { method: "POST" });
    const pb = await proc.json();
    check("(g) resumed task processes normally (draft mode: reviewed, no send)", proc.status === 200 && pb.task?.status === "reviewed" && pb.trustMode === "draft", `status=${proc.status} task=${pb.task?.status} trust=${pb.trustMode}`);
  }

  // ── (h) Resume idempotent / 400 / 404 ──
  {
    // idempotent: resume an already-resumed invoice → 200 no-op success
    const again = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: resumedInvoiceId }) });
    const b = await again.json();
    check("(h) resume of unpaused invoice → 200 no-op success", again.status === 200 && b.ok === true && b.task_created === false && String(b.message).includes("not paused"), JSON.stringify(b));

    // resume of an invoice paused but with an open task → no duplicate task
    const invId2 = seedInvoice("rp_h2", { taskStatus: "reviewed" });
    await postInbound({ sequence_id: String(invId2), from_email: "jane@customer.com", body: "hi", provider_message_id: "msg-h2" });
    // task was cancelled by the pause; simulate a merchant-drafted new open task
    db().run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, 'reviewed', 'S', 'B')", [invId2]);
    const resume2 = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: invId2 }) });
    const b2 = await resume2.json();
    check("(h) resume with an open task → no duplicate task created", resume2.status === 200 && b2.ok === true && b2.task_created === false && openTasks(invId2) === 1, JSON.stringify(b2));

    const badBody = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("(h) resume missing invoice_id → 400", badBody.status === 400, `status=${badBody.status}`);

    const unknown = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: 999999 }) });
    check("(h) resume unknown invoice → 404", unknown.status === 404, `status=${unknown.status}`);

    // foreign invoice: owned by merchant 1 (default) → 404 from merchant-2 session
    const d2 = db();
    d2.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, amount_cents, due_date, status, reply_paused_at) VALUES ('rp_foreign', 1, 'Other', 100, datetime('now'), 'overdue', datetime('now'))");
    const foreignId = Number(d2.query("SELECT id FROM invoices WHERE stripe_invoice_id='rp_foreign'").get()!.id);
    d2.close();
    const foreign = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: foreignId }) });
    check("(h) resume foreign invoice → 404 (ownership enforced)", foreign.status === 404, `status=${foreign.status}`);
  }

  // ── (i) Unauthenticated resume → 401 ──
  {
    const res = await fetch(`${BASE}/tasks/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: 1 }) });
    check("(i) unauthenticated resume → 401", res.status === 401, `status=${res.status}`);
  }

  // ── (j) Inbound webhook auth: no token / wrong token → 403 ──
  {
    const noToken = await postInbound({ sequence_id: "1", from_email: "x@y.com", body: "hi" }, "");
    const wrongToken = await postInbound({ sequence_id: "1", from_email: "x@y.com", body: "hi" }, "wrong-token");
    check("(j) inbound webhook without token → 403", noToken.status === 403, `status=${noToken.status}`);
    check("(j) inbound webhook with wrong token → 403", wrongToken.status === 403, `status=${wrongToken.status}`);
  }

  // ── (k) Resume a free merchant with exhausted allowance (watcher-mirror gate) ──
  {
    const d3 = db();
    d3.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, tier, status) VALUES (1, ?, 'sub_reply_free', 'pro', 'cancelled')", [MERCHANT]);
    // exhaust the derived allowance: 5 drafted tasks for this merchant
    d3.run("DELETE FROM reminder_tasks WHERE invoice_id IN (SELECT id FROM invoices WHERE merchant_id=?) AND draft_body='Exhaust'", [MERCHANT]);
    const count = (d3.query("SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=? AND rt.draft_body != ''").get(MERCHANT) as { n: number }).n;
    for (let i = count; i < 5; i++) {
      const sid = `rp_exhaust_${i}`;
      d3.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, amount_cents, due_date, status) VALUES (?, ?, 'X', 100, datetime('now'), 'overdue')", [sid, MERCHANT]);
      const iid = Number(d3.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(sid)!.id);
      d3.run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, 'reviewed', 'S', 'Exhaust')", [iid]);
    }
    d3.close();
    const invId3 = seedInvoice("rp_exhaust_target", { taskStatus: "reviewed" });
    await postInbound({ sequence_id: String(invId3), from_email: "jane@customer.com", body: "pause me", provider_message_id: "msg-exh-1" });
    const resume3 = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: invId3 }) });
    const b3 = await resume3.json();
    check("(k) resume clears pause even when free allowance exhausted (no new task, clear message)", resume3.status === 200 && b3.ok === true && b3.paused === false && b3.task_created === false && String(b3.message).includes("draft allowance"), JSON.stringify(b3));
    // restore pro subscription so nothing downstream is affected
    db().run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, tier, status) VALUES (1, ?, 'sub_reply', 'pro', 'active')", [MERCHANT]);
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
