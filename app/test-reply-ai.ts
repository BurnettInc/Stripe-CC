/**
 * Reply-pause D1b — AI classification, reply drafting, conditional send,
 * opt-out, and the /replies review-queue endpoints (owner spec 2026-08-12,
 * items 4–8). Builds on D1a (test-reply-pause.ts keeps its 37 checks green).
 *
 * Strategy (deterministic, NO real OpenAI key — run-suite strips it):
 *   - Pure decision-function tests (decideReplySendPolicy) import the module
 *     directly — the hard rule (payment_claim/dispute NEVER auto-send) is
 *     asserted for every Trust Mode + confidence combination.
 *   - HTTP tests against the booted server verify the webhook → AI-hook wiring
 *     (no key, no mock ⇒ safe fallback: 'other' + confidence 0 ⇒ held) and the
 *     /replies endpoints (list/edit/approve/reject, 401/404/409, ownership).
 *   - Direct-call tests (same shared DB as the server, processReplyAI imported
 *     into the test process) exercise every decision branch via the
 *     REPLY_AI_MOCK_CLASSIFICATION seam ("question:0.95" etc.) — a
 *     module-boundary mock documented in pipeline/reply-ai.ts, read at call
 *     time, never touching the network. Assertions are on the shared DB +
 *     send_logs, so they see exactly what the server would have done.
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-reply-ai.db \
 *     bun run test-reply-ai.ts
 * (server booted with INBOUND_WEBHOOK_TOKEN=test-inbound-token, keys stripped)
 */
import { Database } from "bun:sqlite";
import { processReplyAI, decideReplySendPolicy, HIGH_CONFIDENCE_THRESHOLD } from "./src/pipeline/reply-ai";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-reply-ai.db";
const SESSION = "reply-ai-session";
const MERCHANT = 2; // dedicated merchant with a real email + forward target
const INBOUND_TOKEN = "test-inbound-token"; // must match the run-suite env
const FORWARD_TARGET = "forward-target@example.com";

// ── Determinism: the TEST process must never reach a real provider or OpenAI.
// The run-suite strips these for the SERVER; strip them here too, because the
// direct-call tests execute the pipeline in THIS process.
process.env.OPENAI_API_KEY = "";
process.env.RESEND_API_KEY = "";
process.env.SENDGRID_API_KEY = "";
process.env.REPLY_AI_MOCK_CLASSIFICATION = "";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function db(): Database {
  return new Database(DB_PATH);
}

function replyRow(replyId: number): Record<string, unknown> {
  const d = db();
  const row = d.query("SELECT * FROM inbound_replies WHERE id=?").get(replyId) as Record<string, unknown> | undefined;
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

function latestLogOfType(type: string): { status: string; provider_message: string } | null {
  const d = db();
  const row = d.query("SELECT status, provider_message FROM send_logs WHERE type=? ORDER BY id DESC LIMIT 1").get(type) as { status: string; provider_message: string } | null;
  d.close();
  return row;
}

function logsOfType(type: string): Array<{ status: string; provider_message: string }> {
  const d = db();
  const rows = d.query("SELECT status, provider_message FROM send_logs WHERE type=? ORDER BY id ASC").all(type) as Array<{ status: string; provider_message: string }>;
  d.close();
  return rows;
}

function countUnsubscribes(): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM unsubscribes WHERE merchant_id=?").get(MERCHANT) as { n: number };
  d.close();
  return row.n;
}

/** Seed an overdue invoice for the dedicated merchant. Returns its internal id. */
function seedInvoice(sid: string, opts: { trustOverride?: string | null; taskStatus?: string | null } = {}): number {
  const d = db();
  const due = new Date(Date.now() - 3 * 86400e3).toISOString();
  const r = d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, trust_mode_override) VALUES (?, ?, 'Jane Customer', 'jane@customer.com', 5000, 'usd', ?, 'overdue', ?)",
    [sid, MERCHANT, due, opts.trustOverride ?? null]
  );
  const id = Number(r.lastInsertRowid);
  if (opts.taskStatus) {
    d.run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Subject', 'Body text')", [id, opts.taskStatus]);
  }
  d.close();
  return id;
}

/** Insert a fresh 'captured' reply row directly (as the webhook would). Returns the row id. */
function insertCapturedReply(invoiceId: number, body: string, key: string): number {
  const d = db();
  const r = d.run(
    "INSERT INTO inbound_replies (merchant_id, invoice_id, sequence_key, received_at, from_email, from_name, subject, body, idempotency_key, reply_status) VALUES (?, ?, ?, ?, 'jane@customer.com', 'Jane Customer', 'Re: Friendly Reminder', ?, ?, 'captured')",
    [MERCHANT, invoiceId, String(invoiceId), new Date().toISOString(), body, key]
  );
  d.close();
  return Number(r.lastInsertRowid);
}

function seed(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, sender_name, reply_to) VALUES (?, 'acct_reply', 'merchant@example.com', 'full', 'Reply Co', ?)",
    [MERCHANT, FORWARD_TARGET]
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [SESSION, MERCHANT]);
  d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, tier, status) VALUES (1, ?, 'sub_replyai', 'pro', 'active')", [MERCHANT]);
  d.run("DELETE FROM inbound_replies");
  d.run("DELETE FROM send_logs");
  d.run("DELETE FROM reminder_tasks");
  d.run("DELETE FROM invoices WHERE merchant_id=?", [MERCHANT]);
  d.run("DELETE FROM unsubscribes WHERE merchant_id=?", [MERCHANT]);
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

async function main(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  seed();

  // ══ (a) Pure decision function — the conditional-send rules + HARD RULE ══
  {
    const invoice = { status: "overdue", dispute_id: null, refund_id: null, reply_opt_out_at: null };
    const paidInvoice = { status: "paid", dispute_id: null, refund_id: null, reply_opt_out_at: null };
    const disputedInvoice = { status: "overdue", dispute_id: "dp_1", refund_id: null, reply_opt_out_at: null };

    const pc = decideReplySendPolicy("payment_claim", 0.99, "full", invoice);
    check("(a1) HARD RULE: payment_claim NEVER auto-sends even in Full Auto @ 0.99", pc.action === "hold" && pc.reason.includes("never auto-sends"), JSON.stringify(pc));
    const dp = decideReplySendPolicy("dispute", 0.99, "full", invoice);
    check("(a2) HARD RULE: dispute NEVER auto-sends even in Full Auto @ 0.99", dp.action === "hold" && dp.reason.includes("never auto-sends"), JSON.stringify(dp));
    const qOk = decideReplySendPolicy("question", 0.95, "full", invoice);
    check("(a3) question + high confidence + Full Auto → auto_send", qOk.action === "auto_send", JSON.stringify(qOk));
    const qLow = decideReplySendPolicy("question", 0.5, "full", invoice);
    check("(a4) question + LOW confidence + Full Auto → hold", qLow.action === "hold" && qLow.reason.includes("confidence"), JSON.stringify(qLow));
    const qDraft = decideReplySendPolicy("question", 0.95, "draft", invoice);
    check("(a5) question + high confidence + Draft → hold", qDraft.action === "hold" && qDraft.reason.includes("draft"), JSON.stringify(qDraft));
    const qSemi = decideReplySendPolicy("question", 0.95, "semi", invoice);
    check("(a6) question + high confidence + Semi → hold", qSemi.action === "hold" && qSemi.reason.includes("semi"), JSON.stringify(qSemi));
    const opt = decideReplySendPolicy("opt_out", 0.5, "draft", invoice);
    check("(a7) opt_out → opt_out regardless of trust/confidence", opt.action === "opt_out", JSON.stringify(opt));
    const oth = decideReplySendPolicy("other", 0.99, "full", invoice);
    check("(a8) other + high confidence + Full Auto → hold", oth.action === "hold", JSON.stringify(oth));
    const qPaid = decideReplySendPolicy("question", 0.95, "full", paidInvoice);
    check("(a9) question + full + high conf on PAID invoice → hold (stopped)", qPaid.action === "hold" && qPaid.reason.includes("stopped"), JSON.stringify(qPaid));
    const qDisp = decideReplySendPolicy("question", 0.95, "full", disputedInvoice);
    check("(a10) question + full + high conf on DISPUTED invoice → hold (stopped)", qDisp.action === "hold" && qDisp.reason.includes("stopped"), JSON.stringify(qDisp));
    check("(a11) threshold constant sanity", HIGH_CONFIDENCE_THRESHOLD === 0.8, `threshold=${HIGH_CONFIDENCE_THRESHOLD}`);
  }

  // ══ (b) HTTP: webhook fallback (no key, no mock) → safe hold ══
  let fallbackReplyId = 0;
  {
    const invId = seedInvoice("rai_b", { taskStatus: "reviewed" });
    const res = await postInbound({
      sequence_id: String(invId),
      received_at: "2026-08-12T15:00:00Z",
      from_email: "jane@customer.com",
      body: "Can you send me the breakdown?",
      provider_message_id: "msg-rai-b",
    });
    const body = await res.json();
    const d = db();
    const row = d.query("SELECT id FROM inbound_replies WHERE idempotency_key='msg-rai-b'").get() as { id: number } | null;
    d.close();
    fallbackReplyId = row?.id ?? 0;
    const r = replyRow(fallbackReplyId);
    const inv = invoiceRow(invId);
    check("(b) webhook 200 captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(b) NO key → safe hold: classification other, confidence 0, pending_approval", r.reply_status === "pending_approval" && r.classification === "other" && r.confidence === 0, JSON.stringify(r));
    check("(b) template draft still present (approve/edit usable)", typeof r.draft_reply_body === "string" && (r.draft_reply_body as string).length > 0, JSON.stringify(r.draft_reply_body));
    check("(b) invoice paused by the reply", typeof inv.reply_paused_at === "string", JSON.stringify(inv));
    check("(b) original reply forwarded (reply_forward log)", countLogType("reply_forward") >= 1, `n=${countLogType("reply_forward")}`);
  }

  // ══ (c) question + high confidence + Full Auto → auto-sent + owner copy ══
  {
    const invId = seedInvoice("rai_c");
    const replyId = insertCapturedReply(invId, "When exactly was this due?", "key-c");
    const sendBefore = countLogType("reply_send");
    const ownerBefore = countLogType("reply_owner_copy");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "question:0.95";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const r = replyRow(replyId);
    const owner = latestLogOfType("reply_owner_copy");
    check("(c) question+0.95+Full Auto → auto_sent outcome", outcome?.status === "auto_sent" && outcome?.action === "auto_send", JSON.stringify(outcome));
    check("(c) row auto_sent + handled_at + classification/confidence persisted", r.reply_status === "auto_sent" && typeof r.handled_at === "string" && r.classification === "question" && r.confidence === 0.95, JSON.stringify(r));
    check("(c) customer send logged (reply_send success)", countLogType("reply_send") === sendBefore + 1 && latestLogOfType("reply_send")?.status === "success",
      `n=${countLogType("reply_send")} last=${JSON.stringify(latestLogOfType("reply_send"))}`);
    check("(c) owner copy sent marked 'Sent automatically' to the forward target", countLogType("reply_owner_copy") === ownerBefore + 1 && owner?.status === "success" && (owner.provider_message.includes("Sent automatically") && owner.provider_message.includes(FORWARD_TARGET)),
      `n=${countLogType("reply_owner_copy")} owner=${JSON.stringify(owner)}`);
    // idempotency: re-processing a non-captured row is a no-op (no double send)
    const sendBefore2 = countLogType("reply_send");
    const again = await processReplyAI(db(), replyId);
    check("(c) re-process of auto_sent row → noop, no double send", again === null && countLogType("reply_send") === sendBefore2, `again=${JSON.stringify(again)}`);
  }

  // ══ (d) question + high confidence + Draft override → held ══
  {
    const invId = seedInvoice("rai_d", { trustOverride: "draft" });
    const replyId = insertCapturedReply(invId, "When is the new date?", "key-d");
    const sendBefore = countLogType("reply_send");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "question:0.95";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const r = replyRow(replyId);
    check("(d) question+0.95+Draft → held (pending_approval)", outcome?.status === "pending_approval" && outcome?.action === "hold", JSON.stringify(outcome));
    check("(d) no send logged", countLogType("reply_send") === sendBefore, `n=${countLogType("reply_send")}`);
    check("(d) draft persisted for the review queue", typeof r.draft_reply_body === "string" && (r.draft_reply_body as string).length > 0, JSON.stringify(r.draft_reply_body));
  }

  // ══ (e) question + high confidence + Semi override → held ══
  {
    const invId = seedInvoice("rai_e", { trustOverride: "semi" });
    const replyId = insertCapturedReply(invId, "Can I have more time?", "key-e");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "question:0.95";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    check("(e) question+0.95+Semi → held (pending_approval)", outcome?.status === "pending_approval" && outcome?.action === "hold", JSON.stringify(outcome));
  }

  // ══ (f) question + LOW confidence + Full Auto → held ══
  {
    const invId = seedInvoice("rai_f");
    const replyId = insertCapturedReply(invId, "Is this invoice right?", "key-f");
    const sendBefore = countLogType("reply_send");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "question:0.5";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const r = replyRow(replyId);
    check("(f) question+0.5+Full Auto → held (low confidence)", outcome?.status === "pending_approval" && outcome?.action === "hold" && r.reply_status === "pending_approval", JSON.stringify(outcome));
    check("(f) no send logged", countLogType("reply_send") === sendBefore, `n=${countLogType("reply_send")}`);
  }

  // ══ (g) HARD RULE E2E: payment_claim + Full Auto + 0.95 → held, NO send ══
  {
    const invId = seedInvoice("rai_g");
    const replyId = insertCapturedReply(invId, "I already paid this — check your records.", "key-g");
    const sendBefore = countLogType("reply_send");
    const ownerBefore = countLogType("reply_owner_copy");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "payment_claim:0.95";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const r = replyRow(replyId);
    check("(g) payment_claim+0.95+Full Auto → held (pending_approval, hard rule)", outcome?.status === "pending_approval" && outcome?.action === "hold" && String(outcome?.reason).includes("never auto-send"), JSON.stringify(outcome));
    check("(g) row held, classification persisted", r.reply_status === "pending_approval" && r.classification === "payment_claim", JSON.stringify(r));
    check("(g) NO new send log (hard rule enforced at send path)", countLogType("reply_send") === sendBefore && countLogType("reply_owner_copy") === ownerBefore,
      `reply_send=${countLogType("reply_send")} owner_copy=${countLogType("reply_owner_copy")}`);
  }

  // ══ (h) HARD RULE E2E: dispute + Full Auto + 0.95 → held, NO send ══
  {
    const invId = seedInvoice("rai_h");
    const replyId = insertCapturedReply(invId, "I dispute this charge — the service was never delivered.", "key-h");
    const sendBefore = countLogType("reply_send");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "dispute:0.95";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const r = replyRow(replyId);
    check("(h) dispute+0.95+Full Auto → held (pending_approval, hard rule)", outcome?.status === "pending_approval" && outcome?.action === "hold" && String(outcome?.reason).includes("never auto-send"), JSON.stringify(outcome));
    check("(h) row held, classification persisted", r.reply_status === "pending_approval" && r.classification === "dispute", JSON.stringify(r));
    check("(h) NO send log (hard rule enforced at send path)", countLogType("reply_send") === sendBefore, `reply_send=${countLogType("reply_send")}`);
  }

  // ══ (i) opt_out → per-invoice flag + scoped confirmation + tasks cancelled, NOT account-level ══
  {
    const invId = seedInvoice("rai_i", { taskStatus: "reviewed" });
    const replyId = insertCapturedReply(invId, "Please stop emailing me about this invoice.", "key-i");
    const tasksBefore = openTasks(invId);
    const unsubBefore = countUnsubscribes();
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "opt_out:0.95";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const r = replyRow(replyId);
    const inv = invoiceRow(invId);
    const optLogs = logsOfType("reply_optout");
    check("(i) opt_out → handled outcome", outcome?.status === "handled" && outcome?.action === "opt_out", JSON.stringify(outcome));
    check("(i) invoices.reply_opt_out_at set (per-invoice)", typeof inv.reply_opt_out_at === "string", JSON.stringify(inv));
    check("(i) reminder tasks cancelled", tasksBefore === 1 && openTasks(invId) === 0, `before=${tasksBefore} after=${openTasks(invId)}`);
    check("(i) scoped confirmation sent (reply_optout log success)", optLogs.some((l) => l.status === "success" && l.provider_message.includes("Reply sent to jane@customer.com")), JSON.stringify(optLogs));
    check("(i) confirmation copy is SCOPED per-invoice, not generic unsubscribe",
      optLogs.some((l) => l.provider_message.includes("You won't receive further reminders about invoice #rai_i")), JSON.stringify(optLogs));
    check("(i) reply row handled + handled_at", r.reply_status === "handled" && typeof r.handled_at === "string", JSON.stringify(r));
    check("(i) NOT an account-level opt-out (unsubscribes table untouched)", countUnsubscribes() === unsubBefore, `unsub=${countUnsubscribes()}`);
  }

  // ══ (j) other / ambiguous → held ══
  {
    const invId = seedInvoice("rai_j");
    const replyId = insertCapturedReply(invId, "ok thanks", "key-j");
    const sendBefore = countLogType("reply_send");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "other:0.4";
    const outcome = await processReplyAI(db(), replyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    check("(j) other → held (pending_approval)", outcome?.status === "pending_approval" && outcome?.action === "hold" && replyRow(replyId).reply_status === "pending_approval", JSON.stringify(outcome));
    check("(j) no send logged", countLogType("reply_send") === sendBefore, `n=${countLogType("reply_send")}`);
  }

  // ══ (k) /replies review queue endpoints ══
  let heldReplyId = 0;
  let held2ReplyId = 0;
  {
    // Two fresh held rows (via the direct pipeline with a low-confidence question).
    const invA = seedInvoice("rai_k1");
    heldReplyId = insertCapturedReply(invA, "Which date was it due again?", "key-k1");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "question:0.5";
    await processReplyAI(db(), heldReplyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";
    const invB = seedInvoice("rai_k2");
    held2ReplyId = insertCapturedReply(invB, "Is there a late fee?", "key-k2");
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "question:0.5";
    await processReplyAI(db(), held2ReplyId);
    process.env.REPLY_AI_MOCK_CLASSIFICATION = "";

    // GET /replies — actionable list with invoice info
    const list = await af("/replies");
    const rows = await list.json() as Array<Record<string, unknown>>;
    const mine = rows.filter((r) => r.id === heldReplyId || r.id === held2ReplyId);
    check("(k) GET /replies lists actionable replies", list.status === 200 && mine.length === 2, `status=${list.status} mine=${mine.length} total=${rows.length}`);
    check("(k) list rows carry classification/confidence/draft + invoice info",
      mine.length === 2 && mine.every((r) => r.reply_status === "pending_approval" && r.classification === "question" && typeof r.draft_reply_body === "string" && typeof r.stripe_invoice_id === "string" && typeof r.customer_name === "string"),
      JSON.stringify(mine));

    // GET /replies?status=all includes processed rows (auto_sent from (c))
    const all = await af("/replies?status=all");
    const allRows = await all.json() as Array<Record<string, unknown>>;
    check("(k) ?status=all includes processed rows", all.status === 200 && allRows.some((r) => r.reply_status === "auto_sent") && allRows.length > rows.length, `all=${allRows.length} actionable=${rows.length}`);

    // edit → updates draft; captured→pending_approval
    const editRes = await af(`/replies/${heldReplyId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "Re: edited", body: "Edited reply body text" }) });
    const editBody = await editRes.json();
    check("(k) POST /replies/{id}/edit updates the draft", editRes.status === 200 && editBody.draft_reply_body === "Edited reply body text" && editBody.draft_reply_subject === "Re: edited", JSON.stringify(editBody));

    // edit a raw captured row (no draft yet) → 400
    const invC = seedInvoice("rai_k3");
    const rawReplyId = insertCapturedReply(invC, "raw", "key-k3");
    const editRaw = await af(`/replies/${rawReplyId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("(k) edit with no body → 400", editRaw.status === 400, `status=${editRaw.status}`);

    // approve with EDITED fields → sends edited content, row 'sent'
    const sendBefore = countLogType("reply_send");
    const approveRes = await af(`/replies/${heldReplyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: "Re: final", body: "Final reply — yes it was due 2026-08-09." }) });
    const approveBody = await approveRes.json();
    const sentRow = replyRow(heldReplyId);
    check("(k) approve with edited fields → 200 sent", approveRes.status === 200 && approveBody.ok === true, JSON.stringify(approveBody));
    check("(k) row sent + handled_at + edited content persisted", sentRow.reply_status === "sent" && typeof sentRow.handled_at === "string" && sentRow.draft_reply_body === "Final reply — yes it was due 2026-08-09." && sentRow.draft_reply_subject === "Re: final", JSON.stringify(sentRow));
    check("(k) approve logged a reply_send", countLogType("reply_send") === sendBefore + 1, `n=${countLogType("reply_send")}`);

    // approve a held row with NO body in request → sends the stored draft
    const sendBefore2 = countLogType("reply_send");
    const approveDraft = await af(`/replies/${held2ReplyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("(k) approve with no body sends the stored draft", approveDraft.status === 200 && replyRow(held2ReplyId).reply_status === "sent" && countLogType("reply_send") === sendBefore2 + 1,
      `status=${approveDraft.status} row=${JSON.stringify(replyRow(held2ReplyId))}`);

    // approve a raw captured row with no draft → 400
    const approveRaw = await af(`/replies/${rawReplyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("(k) approve with no draft/body → 400", approveRaw.status === 400, `status=${approveRaw.status}`);

    // reject → 'rejected'
    const rejectRes = await af(`/replies/${rawReplyId}/reject`, { method: "POST" });
    check("(k) reject → 200 rejected + handled_at", rejectRes.status === 200 && replyRow(rawReplyId).reply_status === "rejected" && typeof replyRow(rawReplyId).handled_at === "string",
      `status=${rejectRes.status} row=${JSON.stringify(replyRow(rawReplyId))}`);

    // terminal 409s
    const t1 = await af(`/replies/${heldReplyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const t2 = await af(`/replies/${rawReplyId}/reject`, { method: "POST" });
    const t3 = await af(`/replies/${rawReplyId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "x" }) });
    check("(k) approve on sent reply → 409", t1.status === 409, `status=${t1.status}`);
    check("(k) reject on rejected reply → 409", t2.status === 409, `status=${t2.status}`);
    check("(k) edit on rejected reply → 409", t3.status === 409, `status=${t3.status}`);

    // ownership: a reply for merchant 1 must 404 from the merchant-2 session
    const d = db();
    d.run("INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, amount_cents, due_date, status) VALUES ('rai_foreign', 1, 'Other', 100, datetime('now'), 'overdue')");
    const foreignInv = Number(d.query("SELECT id FROM invoices WHERE stripe_invoice_id='rai_foreign'").get()!.id);
    const fr = d.run("INSERT INTO inbound_replies (merchant_id, invoice_id, sequence_key, received_at, from_email, body, idempotency_key, reply_status) VALUES (1, ?, 'x', datetime('now'), 'x@y.com', 'hi', 'key-foreign', 'pending_approval')", [foreignInv]);
    d.close();
    const foreignReplyId = Number(fr.lastInsertRowid);
    const f1 = await af(`/replies/${foreignReplyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const f2 = await af(`/replies/${foreignReplyId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "x" }) });
    const f3 = await af(`/replies/${foreignReplyId}/reject`, { method: "POST" });
    check("(k) foreign reply approve/edit/reject → 404 (ownership enforced)", f1.status === 404 && f2.status === 404 && f3.status === 404, `a=${f1.status} e=${f2.status} r=${f3.status}`);

    // unauthenticated → 401
    const u1 = await fetch(`${BASE}/replies`);
    const u2 = await fetch(`${BASE}/replies/${heldReplyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("(k) unauthenticated GET /replies → 401", u1.status === 401, `status=${u1.status}`);
    check("(k) unauthenticated approve → 401", u2.status === 401, `status=${u2.status}`);
  }

  // ══ (l) resume-after-handled composes (handled reply → resume re-opens the sequence) ══
  {
    const invId = seedInvoice("rai_l", { taskStatus: "reviewed" });
    await postInbound({ sequence_id: String(invId), from_email: "jane@customer.com", body: "When is this due?", provider_message_id: "msg-rai-l" });
    const d = db();
    const row = d.query("SELECT id FROM inbound_replies WHERE idempotency_key='msg-rai-l'").get() as { id: number } | null;
    d.close();
    const replyId = row?.id ?? 0;
    const r = replyRow(replyId);
    check("(l) setup: webhook reply held (fallback other → pending_approval)", r.reply_status === "pending_approval" && r.classification === "other", JSON.stringify(r));

    // approve it → handled ('sent')
    const appr = await af(`/replies/${replyId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    check("(l) approve the held reply → sent", appr.status === 200 && replyRow(replyId).reply_status === "sent", `status=${appr.status} row=${JSON.stringify(replyRow(replyId))}`);

    // resume the paused sequence → fresh drafted task
    const resume = await af("/tasks/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: invId }) });
    const rb = await resume.json();
    const inv = invoiceRow(invId);
    check("(l) resume after handled reply re-opens the sequence", resume.status === 200 && rb.ok === true && rb.task_created === true && inv.reply_paused_at === null,
      `status=${resume.status} body=${JSON.stringify(rb)}`);
    const taskId = rb.task_id ?? 0;
    const t = db().query("SELECT status, draft_body FROM reminder_tasks WHERE id=?").get(taskId) as { status: string; draft_body: string } | null;
    check("(l) resumed task is reviewed with a draft", t !== null && t.status === "reviewed" && t.draft_body.length > 0, JSON.stringify(t));
  }

  // ══ (m) /tasks payload now carries the reply columns (PR #56 chip contract) ══
  {
    const tasks = await af("/tasks");
    const rows = await tasks.json() as Array<Record<string, unknown>>;
    const withReplyCols = rows.filter((t) => typeof t.reply_paused_at === "string" || typeof t.reply_opt_out_at === "string" || t.reply_status !== undefined);
    check("(m) /tasks rows expose reply_paused_at / reply_status for the pause-reason chips",
      tasks.status === 200 && withReplyCols.length > 0, `rows=${rows.length} withReplyCols=${withReplyCols.length}`);
  }

  // ══ (n) webhook still 403s without the token (D1a contract intact) ══
  {
    const res = await postInbound({ sequence_id: "1", from_email: "x@y.com", body: "hi" }, "");
    check("(n) inbound webhook without token → 403", res.status === 403, `status=${res.status}`);
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
