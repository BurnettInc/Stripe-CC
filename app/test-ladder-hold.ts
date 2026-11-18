/**
 * Ladder hold — owner decision 2026-11-16.
 *
 * THE DEFECT THIS REPLACES: `createReminderTask` (src/db.ts) cancelled an
 * invoice's open tasks at every stage boundary to prevent duplicate sends —
 * including a `reviewed` draft, one the merchant had been shown as approved and
 * "Ready to send" and may have hand-edited. PR #254 made that destruction
 * observable; it fired again in production on 2026-11-16 (tasks 75 and 76,
 * reviewed and unsent, cancelled and replaced by task 85 on invoice 365).
 *
 * THE RULE NOW: an unsent `reviewed` draft HOLDS the ladder. No task is
 * created, nothing is cancelled, no status is rewritten, no email is sent. The
 * hold is recorded once per attempt (a send_logs row of type 'ladder_held' on
 * each blocking draft + one log line) and reported to the caller as a null
 * task id.
 *
 * THIS SUITE PROVES:
 *   (1) a reviewed draft survives a stage boundary untouched (status, subject,
 *       body) and no second task appears for that invoice;
 *   (2) the hold is recorded as ONE 'ladder_held' row per attempt on the
 *       blocking draft — and never as 'reminder' or 'superseded';
 *   (3) one log line names the invoice, the stage that wanted to fire and the
 *       blocking task id(s);
 *   (4) holding is not permanent — once the draft is sent (or cancelled by the
 *       merchant) the next attempt creates the new stage task normally;
 *   (5) the duplicate-send guard still works (a `sent` task is still
 *       cancelled/replaced) and a clean invoice's stage-1 task is unaffected;
 *   (6) the escalation-advance pass survives a hold — it counts it, keeps
 *       going, advances other invoices, and never throws.
 *
 * Run: cd app && DB_PATH=/tmp/cc-ladder-hold.db bun run test-ladder-hold.ts
 */
import { rmSync } from "node:fs";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-ladder-hold.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;

const { getDb, ensureDefaultMerchant, upsertInvoice, createReminderTask } = await import("./src/db");
const { runEscalationAdvancePass } = await import("./src/pipeline/scheduler");

let pass = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

const db = getDb();
ensureDefaultMerchant(db);
const merchantId = (db.query("SELECT id FROM merchants ORDER BY id LIMIT 1").get() as { id: number }).id;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
}

let seq = 0;
function makeInvoice(dueDate = daysAgo(3)): number {
  seq++;
  return upsertInvoice(db, {
    stripe_invoice_id: `in_hold_${seq}`,
    merchant_id: merchantId,
    customer_name: `Hold Customer ${seq}`,
    customer_email: `hold${seq}@example.com`,
    amount_cents: 30000,
    currency: "usd",
    due_date: dueDate,
    status: "overdue",
    livemode: 1,
  });
}

function setStatus(taskId: number, status: string): void {
  db.run("UPDATE reminder_tasks SET status=? WHERE id=?", [status, taskId]);
}

function taskRows(invoiceId: number): Array<{ id: number; stage: number; status: string; draft_subject: string | null; draft_body: string | null }> {
  return db
    .query("SELECT id, stage, status, draft_subject, draft_body FROM reminder_tasks WHERE invoice_id=? ORDER BY id")
    .all(invoiceId) as Array<{ id: number; stage: number; status: string; draft_subject: string | null; draft_body: string | null }>;
}

function logRows(taskId: number, type: string): Array<{ id: number; status: string; provider_message: string }> {
  return db
    .query("SELECT id, status, provider_message FROM send_logs WHERE reminder_task_id=? AND type=?")
    .all(taskId, type) as Array<{ id: number; status: string; provider_message: string }>;
}

function captureLogs<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    realLog(...args);
  };
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = realLog;
  }
}

// ── (1)(2)(3) the production case: a reviewed stage-1 draft, ladder advances ──
const invoiceA = makeInvoice(daysAgo(0));
const stage1 = createReminderTask(db, invoiceA, 1) as number;
db.run(
  "UPDATE reminder_tasks SET status='reviewed', draft_subject='Invoice due', draft_body='Please pay.' WHERE id=?",
  [stage1]
);

const first = captureLogs(() => createReminderTask(db, invoiceA, 2));
check("(1) the hold reports itself to the caller (no task id invented)", first.result === null, `result=${String(first.result)}`);

const afterHold = taskRows(invoiceA);
check("(1) exactly one task still exists for the invoice", afterHold.length === 1, JSON.stringify(afterHold));
check("(1) the reviewed draft is NOT cancelled", afterHold[0]?.status === "reviewed", afterHold[0]?.status);
check("(1) the reviewed draft's subject survives", afterHold[0]?.draft_subject === "Invoice due", String(afterHold[0]?.draft_subject));
check("(1) the reviewed draft's body survives", afterHold[0]?.draft_body === "Please pay.", String(afterHold[0]?.draft_body));

const heldRows = logRows(stage1, "ladder_held");
check("(2) one 'ladder_held' audit row on the blocking draft", heldRows.length === 1, `rows=${heldRows.length}`);
check("(2) the audit row status is 'skipped' (nothing was sent)", heldRows[0]?.status === "skipped", String(heldRows[0]?.status));
const heldMsg = heldRows[0]?.provider_message ?? "";
check("(2) the audit row names the stage that wanted to fire", heldMsg.includes("stage 2"), heldMsg);
check("(2) the audit row names the blocking draft", heldMsg.includes(`task ${stage1}`), heldMsg);
check("(2) no reminder-type row was written (nothing emailed)", logRows(stage1, "reminder").length === 0);
check("(2) no superseded row was written (nothing replaced)", logRows(stage1, "superseded").length === 0);

check(
  "(3) one log line names the invoice, the stage and the blocking task",
  first.lines.some((l) => l.includes("ladder held for invoice " + invoiceA) && l.includes("stage 2") && l.includes(String(stage1))),
  first.lines.join(" | ")
);

// A second attempt (the next daily pass) records its own hold and still
// creates nothing — visible without flooding task rows.
const second = captureLogs(() => createReminderTask(db, invoiceA, 2));
check("(2) a repeat attempt holds again", second.result === null, String(second.result));
check("(2) each attempt leaves one audit row (2 attempts → 2 rows)", logRows(stage1, "ladder_held").length === 2, `rows=${logRows(stage1, "ladder_held").length}`);
check("(2) no task was ever created by a held attempt", taskRows(invoiceA).length === 1, JSON.stringify(taskRows(invoiceA)));

// ── (4) the hold lifts: the merchant SENDS the draft ──
setStatus(stage1, "sent");
const afterSend = createReminderTask(db, invoiceA, 2);
check("(4) after the draft is sent the next stage task is created", typeof afterSend === "number", String(afterSend));
const afterResume = taskRows(invoiceA);
check("(4) the new task exists at stage 2", afterResume.some((t) => t.id === afterSend && t.stage === 2 && t.status === "pending"), JSON.stringify(afterResume));
check("(5) the duplicate-send guard still replaced the sent task", afterResume.find((t) => t.id === stage1)?.status === "cancelled", afterResume.find((t) => t.id === stage1)?.status);

// ── (4) the hold lifts: the merchant CANCELS the draft ──
const invoiceB = makeInvoice(daysAgo(0));
const b1 = createReminderTask(db, invoiceB, 1) as number;
db.run("UPDATE reminder_tasks SET status='reviewed' WHERE id=?", [b1]);
check("(4) a reviewed draft holds", createReminderTask(db, invoiceB, 2) === null);
setStatus(b1, "cancelled");
const b2 = createReminderTask(db, invoiceB, 2);
check("(4) after the merchant cancels the draft the ladder resumes", typeof b2 === "number", String(b2));
check("(4) the resumed task lands at stage 2", taskRows(invoiceB).some((t) => t.id === b2 && t.stage === 2), JSON.stringify(taskRows(invoiceB)));

// ── (5) creation on a clean invoice is untouched (Semi-Auto stage 1 path) ──
const invoiceClean = makeInvoice(daysAgo(0));
const cleanTask = createReminderTask(db, invoiceClean, 1);
check("(5) a clean invoice still gets its stage-1 task", typeof cleanTask === "number", String(cleanTask));

// ── (6) the escalation-advance pass survives the hold ──
// invoiceC: 10 days overdue (auto stage 2) with a reviewed stage-1 draft → HOLD.
const invoiceC = makeInvoice(daysAgo(10));
const c1 = createReminderTask(db, invoiceC, 1) as number;
db.run("UPDATE reminder_tasks SET status='reviewed', draft_subject='Still due', draft_body='Please pay now.' WHERE id=?", [c1]);
// invoiceD: 30 days overdue (auto stage 3) with a pending stage-1 task → ADVANCES.
const invoiceD = makeInvoice(daysAgo(30));
createReminderTask(db, invoiceD, 1);

// Make the earlier fixtures inert for the pass (already at their latest stage).
db.run("UPDATE invoices SET due_date=? WHERE id IN (?, ?)", [daysAgo(0), invoiceA, invoiceB]);

let passError: unknown = null;
let advanceResult: Awaited<ReturnType<typeof runEscalationAdvancePass>> | null = null;
const passLogs: string[] = [];
try {
  advanceResult = await runEscalationAdvancePass(db, { log: (m: string) => passLogs.push(m) });
} catch (err: unknown) {
  passError = err;
}
check("(6) the escalation pass never throws on a hold", passError === null, passError instanceof Error ? passError.message : String(passError));
check("(6) the pass counted the hold", (advanceResult?.skipped.held ?? 0) === 1, JSON.stringify(advanceResult?.skipped));
check("(6) the pass kept going and advanced another invoice", (advanceResult?.advanced ?? 0) >= 1, JSON.stringify(advanceResult));
check("(6) the held invoice still has exactly its one reviewed draft", taskRows(invoiceC).length === 1 && taskRows(invoiceC)[0].status === "reviewed", JSON.stringify(taskRows(invoiceC)));
check("(6) the held draft's body is untouched by the pass", taskRows(invoiceC)[0].draft_body === "Please pay now.", String(taskRows(invoiceC)[0].draft_body));
check("(6) the other invoice advanced to stage 3", taskRows(invoiceD).some((t) => t.stage === 3), JSON.stringify(taskRows(invoiceD)));
check("(6) the pass summary mentions the hold", passLogs.some((l) => l.includes("held (unsent reviewed draft)")), passLogs.join(" | "));

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
