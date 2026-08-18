/**
 * Reply detection v1 — deterministic keyword/pattern classification (owner
 * 8/18). Builds on the reply-pause pipeline: the inbound webhook still pauses
 * + cancels on ANY reply; this suite verifies the NEW detection layer stores a
 * classification + extracted date + actionable merchant flag on every captured
 * reply, and surfaces them in the notification email / /replies queue / /tasks
 * payload — WITHOUT changing any existing safety behavior.
 *
 * Two layers:
 *   (a) UNIT — pure classifyReplyDetect() / replyActionFlag() / detectLabel()
 *       imported directly (no server, no network): every category + edge →
 *       ambiguous, plus the honesty-guard cases ("pay attention" must NOT be a
 *       payment claim).
 *   (b) E2E — HTTP against the booted server (INBOUND_WEBHOOK_TOKEN set, keys
 *       stripped): webhook → row classified + flagged + paused; the flag is in
 *       the merchant notification; /replies carries the detect columns; the
 *       AI classification column is untouched by the deterministic layer
 *       (still 'other' + confidence 0 without a key — the safe hold).
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-reply-detect.db \
 *     bun run test-reply-detect.ts
 */
import { Database } from "bun:sqlite";
import { classifyReplyDetect, replyActionFlag, detectLabel } from "./src/pipeline/reply-detect";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-reply-detect.db";
const SESSION = "reply-detect-session";
const MERCHANT = 2; // dedicated merchant with a real email + forward target
const INBOUND_TOKEN = "test-inbound-token"; // must match the run-suite env

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function db(): Database {
  return new Database(DB_PATH);
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

function latestNotify(): { status: string; provider_message: string } | null {
  const d = db();
  const row = d.query("SELECT status, provider_message FROM send_logs WHERE type='merchant_notification' ORDER BY id DESC LIMIT 1").get() as { status: string; provider_message: string } | null;
  d.close();
  return row;
}

/** Seed a fresh invoice for the dedicated merchant. Returns its internal id. */
function seedInvoice(sid: string, opts: { taskStatus?: string | null } = {}): number {
  const d = db();
  const due = new Date(Date.now() - 3 * 86400e3).toISOString();
  const r = d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, 'Jane Customer', 'jane@customer.com', 5000, 'usd', ?, 'overdue')",
    [sid, MERCHANT, due]
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
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, sender_name, reply_to) VALUES (?, 'acct_reply', 'merchant@example.com', 'draft', 'Reply Co', 'forward-target@example.com')",
    [MERCHANT]
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [SESSION, MERCHANT]);
  d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, tier, status) VALUES (1, ?, 'sub_rdetect', 'pro', 'active')", [MERCHANT]);
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

function postInbound(sequenceId: string, body: string, key: string, subject?: string): Promise<Response> {
  return fetch(`${BASE}/inbound/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INBOUND_TOKEN}` },
    body: JSON.stringify({ sequence_id: sequenceId, from_email: "jane@customer.com", from_name: "Jane Customer", subject, body, provider_message_id: key }),
  });
}

/** Unit-level: a single classification assertion with an optional date check. */
function unitCase(
  label: string,
  text: string,
  expected: string,
  dateSubstr?: string,
): void {
  const res = classifyReplyDetect(text);
  const okCls = res.classification === expected;
  const okDate = dateSubstr === undefined || (res.extracted_date !== null && res.extracted_date.toLowerCase().includes(dateSubstr));
  check(`(u) ${label} → ${expected}`, okCls && okDate, JSON.stringify(res));
}

async function main(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // ══ (u) UNIT — classifier per category + edge → ambiguous ══
  // payment_claim — already paid / in flight / will-pay without a date
  unitCase("already paid", "I already paid this invoice", "payment_claim");
  unitCase("just paid", "I just paid it yesterday", "payment_claim");
  unitCase("payment sent", "The payment was sent last week", "payment_claim");
  unitCase("check in the mail", "The check is in the mail", "payment_claim");
  unitCase("paid in full", "I've paid in full, thanks", "payment_claim");
  unitCase("sent the payment", "I sent the payment this morning", "payment_claim");
  unitCase("wired", "I wired the money already", "payment_claim");
  unitCase("will pay (no date)", "I will pay soon", "payment_claim");
  unitCase("going to pay (no date)", "I'm going to pay the full amount", "payment_claim");
  unitCase("payment on the way", "Payment is on its way", "payment_claim");
  unitCase("can pay", "I can pay the balance now", "payment_claim");

  // promise_to_pay — future commitment WITH a date (date extracted)
  unitCase("pay friday", "I'll pay Friday", "promise_to_pay", "friday");
  unitCase("end of month", "I will pay at the end of the month", "promise_to_pay", "end of the month");
  unitCase("next week", "I'll pay next week, just waiting on my accountant", "promise_to_pay", "next week");
  unitCase("on the 15th", "I'll pay on the 15th", "promise_to_pay", "15th");
  unitCase("end of week", "Payment will be sent by end of week", "promise_to_pay", "end of week");
  unitCase("paying monday", "I'll be paying on Monday", "promise_to_pay", "monday");
  unitCase("before december", "I'll settle this invoice before December", "promise_to_pay", "december");
  unitCase("take care next month", "I'll take care of it next month", "promise_to_pay", "next month");
  unitCase("pay it this week", "I'll pay it this week", "promise_to_pay", "this week");
  unitCase("get it paid by friday", "I'll get this paid by Friday", "promise_to_pay", "friday");
  unitCase("wire on friday", "I'll wire the payment on Friday", "promise_to_pay", "friday");

  // dispute
  unitCase("never got this", "I never got this invoice", "dispute");
  unitCase("not mine", "This isn't mine", "dispute");
  unitCase("overcharged", "You overcharged me", "dispute");
  unitCase("i dispute", "I dispute this charge", "dispute");
  unitCase("unauthorized", "This was an unauthorized charge", "dispute");
  unitCase("didn't order", "I didn't order this", "dispute");
  unitCase("refund", "I need a refund", "dispute");
  unitCase("never received service", "I never received the service", "dispute");
  unitCase("charged twice", "You charged me twice", "dispute");

  // question
  unitCase("when due", "When was this due?", "question");
  unitCase("send breakdown", "Can you send me the breakdown?", "question");
  unitCase("what is balance", "What is my balance?", "question");
  unitCase("explain late fee", "Please explain the late fee", "question");
  unitCase("is there late fee", "Is there a late fee on this?", "question");
  unitCase("wondering", "I was wondering how much I owe", "question");
  unitCase("subject only (no signal)", "Re: Friendly Reminder", "ambiguous");

  // ambiguous — everything else + honesty-guard edges
  unitCase("ok thanks", "ok thanks", "ambiguous");
  unitCase("empty", "", "ambiguous");
  unitCase("talk soon", "sounds good, talk soon", "ambiguous");
  unitCase("pay attention trap", "I will pay attention to this matter", "ambiguous");
  unitCase("paid attention trap", "I paid attention to your email", "ambiguous");
  unitCase("please call me", "please call me", "ambiguous");
  unitCase("gibberish", "asdf qwer zxcv", "ambiguous");
  unitCase("not paying", "I will not pay this", "ambiguous"); // "will pay" absent ("not" between)

  // ══ (u) flag copy — exact owner-approved text ══
  check("(u) payment_claim flag text", replyActionFlag("payment_claim", null) === "Customer says they paid — verify in Stripe, then close or resume.", replyActionFlag("payment_claim", null));
  check("(u) promise_to_pay flag text with date", replyActionFlag("promise_to_pay", "Friday") === "Customer promises payment by Friday — resume after that date if still unpaid.", replyActionFlag("promise_to_pay", "Friday"));
  check("(u) promise_to_pay flag text without date", replyActionFlag("promise_to_pay", null) === "Customer promises payment — resume after the promised date if still unpaid.", replyActionFlag("promise_to_pay", null));
  check("(u) dispute flag text", replyActionFlag("dispute", null) === "Customer disputes the invoice — handle personally; sequence stays paused.", replyActionFlag("dispute", null));
  check("(u) question flag text", replyActionFlag("question", null) === "Customer asked a question — reply directly; sequence paused.", replyActionFlag("question", null));
  check("(u) ambiguous flag text", replyActionFlag("ambiguous", null) === "Couldn't classify — review the reply.", replyActionFlag("ambiguous", null));
  check("(u) detectLabel mapping", detectLabel("payment_claim") === "payment claim" && detectLabel("promise_to_pay") === "promise to pay" && detectLabel("dispute") === "dispute" && detectLabel("question") === "question" && detectLabel("ambiguous") === "ambiguous", "labels");

  // ══ (e) E2E — webhook → classified + flagged + paused; surfaces ══
  seed();

  // (e1) payment_claim
  {
    const invId = seedInvoice("rd_e1", { taskStatus: "reviewed" });
    const res = await postInbound(String(invId), "I already paid this invoice", "msg-rd-e1");
    const body = await res.json();
    const row = replyRow(invId);
    const inv = invoiceRow(invId);
    check("(e1) webhook 200 captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(e1) row detect_classification=payment_claim", row.detect_classification === "payment_claim", JSON.stringify(row.detect_classification));
    check("(e1) row action_flag = verify-in-Stripe flag", row.action_flag === "Customer says they paid — verify in Stripe, then close or resume.", String(row.action_flag));
    check("(e1) invoice reply_paused_at set + tasks cancelled", typeof inv.reply_paused_at === "string" && openTasks(invId) === 0, `paused=${inv.reply_paused_at} open=${openTasks(invId)}`);
    // AI column untouched by the deterministic layer (no key → safe hold 'other')
    check("(e1) AI classification column still 'other' (deterministic layer additive)", row.classification === "other" && row.confidence === 0, JSON.stringify({ c: row.classification, conf: row.confidence }));
    // merchant notification subject carries the label (observable in stub log)
    const notify = latestNotify();
    check("(e1) merchant notification carries the detected label", notify !== null && String(notify.provider_message).includes("(payment claim)"), notify?.provider_message ?? "none");
  }

  // (e2) promise_to_pay with extracted date
  {
    const invId = seedInvoice("rd_e2", { taskStatus: "reviewed" });
    const res = await postInbound(String(invId), "I'll pay Friday, thanks for the reminder", "msg-rd-e2");
    const body = await res.json();
    const row = replyRow(invId);
    check("(e2) captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(e2) detect_classification=promise_to_pay", row.detect_classification === "promise_to_pay", String(row.detect_classification));
    check("(e2) extracted date contains 'friday'", typeof row.detect_extracted_date === "string" && String(row.detect_extracted_date).toLowerCase().includes("friday"), String(row.detect_extracted_date));
    check("(e2) flag references the promised date", String(row.action_flag).includes("by Friday") && String(row.action_flag).includes("resume after that date"), String(row.action_flag));
  }

  // (e3) ambiguous
  {
    const invId = seedInvoice("rd_e3", { taskStatus: "reviewed" });
    const res = await postInbound(String(invId), "ok thanks", "msg-rd-e3");
    const body = await res.json();
    const row = replyRow(invId);
    check("(e3) captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(e3) detect_classification=ambiguous", row.detect_classification === "ambiguous", String(row.detect_classification));
    check("(e3) flag = couldn't classify", row.action_flag === "Couldn't classify — review the reply.", String(row.action_flag));
  }

  // (e4) dispute
  {
    const invId = seedInvoice("rd_e4", { taskStatus: "reviewed" });
    const res = await postInbound(String(invId), "I dispute this charge — I never got the service", "msg-rd-e4");
    const body = await res.json();
    const row = replyRow(invId);
    check("(e4) captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(e4) detect_classification=dispute", row.detect_classification === "dispute", String(row.detect_classification));
    check("(e4) flag = handle personally", row.action_flag === "Customer disputes the invoice — handle personally; sequence stays paused.", String(row.action_flag));
  }

  // (e5) question
  {
    const invId = seedInvoice("rd_e5", { taskStatus: "reviewed" });
    const res = await postInbound(String(invId), "Can you send me the breakdown?", "msg-rd-e5");
    const body = await res.json();
    const row = replyRow(invId);
    check("(e5) captured + paused", res.status === 200 && body.status === "captured" && body.paused === true, JSON.stringify(body));
    check("(e5) detect_classification=question", row.detect_classification === "question", String(row.detect_classification));
    check("(e5) flag = reply directly", row.action_flag === "Customer asked a question — reply directly; sequence paused.", String(row.action_flag));
  }

  // (e6) classification from the subject (whole message in the subject)
  {
    const invId = seedInvoice("rd_e6", { taskStatus: "reviewed" });
    const res = await postInbound(String(invId), "", "msg-rd-e6", "Re: Invoice — I already paid this");
    const body = await res.json();
    const row = replyRow(invId);
    check("(e6) captured + classified from subject", res.status === 200 && body.status === "captured" && row.detect_classification === "payment_claim", JSON.stringify({ b: body, c: row.detect_classification }));
  }

  // (e7) /replies review queue carries the detect columns + flag
  {
    const list = await af("/replies?status=all");
    const rows = await list.json() as Array<Record<string, unknown>>;
    const withDetect = rows.filter((r) => r.detect_classification !== undefined && r.action_flag !== undefined && r.detect_extracted_date !== undefined);
    check("(e7) GET /replies rows carry detect_classification + action_flag + detect_extracted_date", list.status === 200 && withDetect.length >= 6, `status=${list.status} with=${withDetect.length} total=${rows.length}`);
    const claim = rows.find((r) => r.detect_classification === "payment_claim");
    check("(e7) a payment_claim row exposes the exact flag", claim !== undefined && claim.action_flag === "Customer says they paid — verify in Stripe, then close or resume.", JSON.stringify(claim?.action_flag));
  }

  // (e8) /tasks payload exposes the flag for the dashboard chip (task rows on a
  // reply-paused invoice surface reply_detect_classification + reply_action_flag)
  {
    const invId = seedInvoice("rd_e8", { taskStatus: "reviewed" });
    await postInbound(String(invId), "I'll pay next week", "msg-rd-e8");
    const all = await af("/tasks?status=all");
    const rows = await all.json() as Array<Record<string, unknown>>;
    const withFlag = rows.filter((t) => t.reply_action_flag && String(t.reply_action_flag).includes("resume after that date"));
    check("(e8) /tasks?status=all rows carry reply_action_flag for the pause chip", all.status === 200 && withFlag.length >= 1, `rows=${rows.length} withFlag=${withFlag.length}`);
  }

  // (e9) safety invariant: payment_claim NEVER auto-sends (no reply_send log),
  // and the pause is exactly the existing behavior (any reply pauses).
  {
    const sendBefore = (d: Database) => (d.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='reply_send'").get() as { n: number }).n;
    const before = sendBefore(db());
    const invId = seedInvoice("rd_e9", { taskStatus: "reviewed" });
    await postInbound(String(invId), "I already paid this", "msg-rd-e9");
    const after = sendBefore(db());
    check("(e9) no auto-send on payment_claim (hard rule intact)", after === before, `before=${before} after=${after}`);
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
