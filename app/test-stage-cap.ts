/**
 * Stage cap + pacing — owner decision 2026-11-18.
 *
 * THE DEFECT THIS REPLACES: every one of merchant 12's eight first-ever drafts
 * went out labelled stage 3, "Final notice", because the stage came from
 * days-overdue alone (`getEscalationStage`). No reminder had ever been sent for
 * those invoices; one customer received three "Final notice" emails plus a
 * "Friendly reminder" inside four seconds. Copy that claims a notice the
 * customer never received is misleading and costs the merchant credibility
 * with their own customer.
 *
 * THE RULE NOW: `resolveContactStage` (src/pipeline/escalation.ts) is the one
 * helper every task-creating path uses. It caps the stage at
 * min(requested, reminders actually sent + 1) — the merchant's per-invoice
 * `stage_override` included — and paces a new notice so it cannot go out sooner
 * than the ladder's own gap after the last successful send.
 *
 * THIS SUITE PROVES:
 *   (1) 60 days overdue with ZERO sends yields a stage-1 draft whose subject and
 *       body never say "final notice";
 *   (2) 1 → 2 → 3 happens only after each prior notice was actually sent, and
 *       only the stage-3 copy says "final";
 *   (3) the pacing rule defers the next notice until the ladder's gap elapses;
 *   (4) an explicit stage_override cannot claim more than sentCount + 1;
 *   (5) all three task-creating paths (watcher, escalation-advance,
 *       POST /tasks/resume) go through the shared helper.
 *
 * Run: cd app && DB_PATH=/tmp/cc-stage-cap.db bun run test-stage-cap.ts
 */
import { rmSync } from "node:fs";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-stage-cap.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;

const { getDb, upsertInvoice, getInvoiceById, createReminderTask, logSend } = await import("./src/db");
const { createTaskForOverdueInvoice } = await import("./src/pipeline/watcher");
const { runEscalationAdvancePass } = await import("./src/pipeline/scheduler");
const { resolveContactStage, getContactHistory, noticeGapDays } = await import("./src/pipeline/escalation");

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

const DAY_MS = 24 * 60 * 60 * 1000;
const db = getDb();
// A Draft-mode merchant outside its trial window: nothing auto-sends, so every
// assertion below is about the stage the DRAFT was written at.
db.run(
  "INSERT INTO merchants (stripe_account_id, email, trust_mode, created_at) VALUES ('acct_stage_cap', 'stagecap@example.com', 'draft', datetime('now','-90 days'))"
);
const merchantId = (db.query("SELECT id FROM merchants ORDER BY id DESC LIMIT 1").get() as { id: number }).id;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().split("T")[0];
}

let seq = 0;
function makeInvoice(overdueDays: number, stageOverride: number | null = null): number {
  seq++;
  const id = upsertInvoice(db, {
    stripe_invoice_id: `in_stage_${seq}`,
    merchant_id: merchantId,
    customer_name: `Customer ${seq}`,
    customer_email: `customer${seq}@example.com`,
    amount_cents: 30000,
    currency: "usd",
    due_date: daysAgo(overdueDays),
    status: "overdue",
    livemode: 1,
  });
  if (stageOverride !== null) {
    db.run("UPDATE invoices SET stage_override=? WHERE id=?", [stageOverride, id]);
  }
  return id;
}

/** Record that notice `stage` really reached this customer `sentDaysAgo` days ago. */
function recordSentNotice(invoiceId: number, stage: number, sentDaysAgo: number): number {
  const taskId = createReminderTask(db, invoiceId, stage) as number;
  db.run("UPDATE reminder_tasks SET status='sent', sent_at=? WHERE id=?", [
    new Date(Date.now() - sentDaysAgo * DAY_MS).toISOString(),
    taskId,
  ]);
  logSend(db, taskId, "success", `reminder sent (stage ${stage})`, "reminder", null, new Date(Date.now() - sentDaysAgo * DAY_MS));
  return taskId;
}

function latestTask(invoiceId: number) {
  return db
    .query("SELECT * FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(invoiceId) as { id: number; stage: number; status: string; draft_subject: string | null; draft_body: string | null } | null;
}

function taskCount(invoiceId: number): number {
  return (db.query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=?").get(invoiceId) as { n: number }).n;
}

function saysFinal(task: { draft_subject: string | null; draft_body: string | null } | null): boolean {
  return `${task?.draft_subject ?? ""}\n${task?.draft_body ?? ""}`.toLowerCase().includes("final");
}

async function advance() {
  return runEscalationAdvancePass(db, { log: () => {} });
}

// ════════════════════════════════════════════════════════════════════════
// (1) 60 days overdue, nothing ever sent → stage 1, never "final notice"
// ════════════════════════════════════════════════════════════════════════
{
  const invoiceId = makeInvoice(60);
  const created = await createTaskForOverdueInvoice(db, getInvoiceById(db, invoiceId)!);
  const task = latestTask(invoiceId);
  check("(1) a task was created for the 60-day invoice", typeof created.taskId === "number", JSON.stringify(created));
  check("(1) the draft is at stage 1, not stage 3", task?.stage === 1, `stage=${task?.stage}`);
  check("(1) the subject is the stage-1 prefix", (task?.draft_subject ?? "").startsWith("Quick reminder"), String(task?.draft_subject));
  check("(1) the subject never says 'final'", !(task?.draft_subject ?? "").toLowerCase().includes("final"), String(task?.draft_subject));
  check("(1) the body never says 'final notice'", !saysFinal(task), String(task?.draft_body));
  check("(1) nothing was sent for it", getContactHistory(db, invoiceId).sentCount === 0);
  // Park the invoice so later passes do not re-examine it.
  db.run("UPDATE invoices SET status='paid' WHERE id=?", [invoiceId]);
}

// ════════════════════════════════════════════════════════════════════════
// (2) 1 → 2 → 3 only after each prior notice was really sent
// ════════════════════════════════════════════════════════════════════════
{
  const invoiceId = makeInvoice(60);
  recordSentNotice(invoiceId, 1, 40); // notice 1 went out 40 days ago (6-day gap elapsed)

  const r1 = await advance();
  const t2 = latestTask(invoiceId);
  check("(2) after notice 1 the next draft is stage 2", t2?.stage === 2, `stage=${t2?.stage} advanced=${r1.advanced}`);
  check("(2) the stage-2 subject is 'Following up'", (t2?.draft_subject ?? "").startsWith("Following up"), String(t2?.draft_subject));
  check("(2) the stage-2 copy never says 'final'", !saysFinal(t2), String(t2?.draft_body));

  // Notice 2 really goes out 20 days ago; the ladder's 15-day gap
  // (20 − 6 + 1) has since elapsed, so stage 3 may follow.
  db.run("UPDATE reminder_tasks SET status='sent', sent_at=? WHERE id=?", [
    new Date(Date.now() - 20 * DAY_MS).toISOString(),
    t2!.id,
  ]);
  logSend(db, t2!.id, "success", "reminder sent (stage 2)", "reminder", null, new Date(Date.now() - 20 * DAY_MS));

  await advance();
  const t3 = latestTask(invoiceId);
  check("(2) only after TWO real sends does stage 3 appear", t3?.stage === 3, `stage=${t3?.stage}`);
  check("(2) the stage-3 subject is 'Final notice'", (t3?.draft_subject ?? "").startsWith("Final notice"), String(t3?.draft_subject));
  check("(2) the stage-3 body says 'final notice'", (t3?.draft_body ?? "").toLowerCase().includes("final notice"), String(t3?.draft_body));
  check(
    "(2) the ladder never skipped a stage",
    (db.query("SELECT stage FROM reminder_tasks WHERE invoice_id=? ORDER BY id").all(invoiceId) as { stage: number }[])
      .map((t) => t.stage)
      .join(",") === "1,2,3",
    JSON.stringify(db.query("SELECT stage, status FROM reminder_tasks WHERE invoice_id=? ORDER BY id").all(invoiceId))
  );
  check("(2) exactly two reminders were actually sent before stage 3 appeared", getContactHistory(db, invoiceId).sentCount === 2, `sent=${getContactHistory(db, invoiceId).sentCount}`);
  db.run("UPDATE invoices SET status='paid' WHERE id=?", [invoiceId]);
}

// ════════════════════════════════════════════════════════════════════════
// (3) pacing — the next notice waits for the ladder's gap
// ════════════════════════════════════════════════════════════════════════
{
  // Notice 1 sent YESTERDAY on a 60-day-old invoice: the customer would get
  // stage 2 the day after stage 1 without the pacing rule.
  const invoiceId = makeInvoice(60);
  recordSentNotice(invoiceId, 1, 1);

  const decision = resolveContactStage(db, invoiceId, { requestedStage: 3 });
  check("(3) the helper reports the notice as paced", decision.paced === true, JSON.stringify(decision));
  check("(3) the pacing gap is the ladder's stage-1 spacing (6 days)", decision.gapDays === 6, `gap=${decision.gapDays}`);
  check("(3) a next-eligible timestamp is reported", typeof decision.nextEligibleAt === "string", String(decision.nextEligibleAt));

  const before = taskCount(invoiceId);
  const r = await advance();
  const after = latestTask(invoiceId);
  check("(3) the advance pass created no task", taskCount(invoiceId) === before, `before=${before} after=${taskCount(invoiceId)}`);
  check("(3) the invoice stays at stage 1", after?.stage === 1, `stage=${after?.stage}`);
  check("(3) the pass counted it as paced", r.skipped.paced === 1, JSON.stringify(r.skipped));

  // Once the gap has elapsed the same invoice advances.
  db.run("UPDATE send_logs SET created_at=? WHERE reminder_task_id=?", [
    new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 19).replace("T", " "),
    after!.id,
  ]);
  await advance();
  const advanced = latestTask(invoiceId);
  check("(3) after the gap elapsed the same invoice advances to stage 2", advanced?.stage === 2, `stage=${advanced?.stage}`);
  db.run("UPDATE invoices SET status='paid' WHERE id=?", [invoiceId]);
}

// ════════════════════════════════════════════════════════════════════════
// (4) a merchant's stage_override cannot claim an unearned notice
// ════════════════════════════════════════════════════════════════════════
{
  // Override pinned to 3 with nothing ever sent → the draft is still stage 1.
  const noSends = makeInvoice(60, 3);
  await createTaskForOverdueInvoice(db, getInvoiceById(db, noSends)!);
  const t = latestTask(noSends);
  check("(4) override 3 with zero sends yields a stage-1 draft", t?.stage === 1, `stage=${t?.stage}`);
  check("(4) that draft never says 'final'", !saysFinal(t), String(t?.draft_body));

  // Override pinned to 3 with exactly one real send → stage 2, never 3.
  const oneSend = makeInvoice(60, 3);
  recordSentNotice(oneSend, 1, 7);
  const decision = resolveContactStage(db, oneSend, { requestedStage: 3 });
  check("(4) override 3 with one send resolves to stage 2", decision.stage === 2, JSON.stringify(decision));
  check("(4) the decision records the cap", decision.capped === true, JSON.stringify(decision));
  const r = await advance();
  const t2 = latestTask(oneSend);
  check("(4) the advanced draft lands at stage 2, not 3", t2?.stage === 2, `stage=${t2?.stage} advanced=${r.advanced}`);
  db.run("UPDATE invoices SET status='paid' WHERE id IN (?, ?)", [noSends, oneSend]);
}

// ════════════════════════════════════════════════════════════════════════
// (5) every task-creating path routes through the shared helper
// ════════════════════════════════════════════════════════════════════════
{
  const { readFileSync } = await import("node:fs");
  for (const [label, path] of [
    ["watcher", "./src/pipeline/watcher.ts"],
    ["escalation-advance", "./src/pipeline/scheduler.ts"],
    ["POST /tasks/resume", "./src/routes/tasks.ts"],
  ] as const) {
    const src = readFileSync(path, "utf8");
    check(`(5) ${label} calls resolveContactStage`, src.includes("resolveContactStage("), path);
  }
  check("(5) the ladder gap after notice 1 is stage1Max", noticeGapDays(1, 6, 20) === 6, String(noticeGapDays(1, 6, 20)));
  check("(5) the ladder gap after notice 2 is stage2Max − stage1Max + 1", noticeGapDays(2, 6, 20) === 15, String(noticeGapDays(2, 6, 20)));
  check("(5) Pro custom thresholds move both gaps", noticeGapDays(1, 10, 20) === 10 && noticeGapDays(2, 10, 20) === 11, `${noticeGapDays(1, 10, 20)}/${noticeGapDays(2, 10, 20)}`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
