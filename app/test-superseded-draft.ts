/**
 * Superseded-draft visibility (2026-11-10) — pure unit suite, no server, no email.
 *
 * THE DEFECT: `createReminderTask` (src/db.ts) cancels the invoice's open tasks
 * to prevent duplicate sends. That includes a `reviewed` draft — one the
 * merchant has been shown as approved and "Ready to send", possibly hand-edited.
 * The cancel emitted no log line, no audit row and no notification, so the draft
 * vanished without trace. Production proof: reminder_task 72 (stage 1,
 * `reviewed`, never sent) on invoice 356 was cancelled at 2026-11-09 19:55:55
 * when the invoice crossed 7 days overdue, and only task 74's creation time
 * showed anything had happened.
 *
 * THIS SUITE PROVES:
 *   (a) superseding a `reviewed` draft writes ONE send_logs audit row, attached
 *       to the REPLACED task, of type 'superseded', status 'skipped', naming the
 *       replaced task id, its stage and the replacing task id + stage;
 *   (b) a log line is emitted naming both tasks;
 *   (c) the ladder's behaviour is UNCHANGED — the old task is 'cancelled', the
 *       new task exists at the requested stage, and nothing is emailed (no
 *       send_logs row of type 'reminder');
 *   (d) superseding tasks that were never 'reviewed' (pending/drafted) writes no
 *       superseded row — no audit noise for drafts no human ever saw as ready;
 *   (e) `annotateSupersededDrafts` surfaces the replaced draft on the replacing
 *       task row (task_id + stage + when), returns an empty list for a
 *       superseded task itself and for an invoice that never lost a draft, and
 *       is READ-ONLY (adds no rows, changes no status);
 *   (f) the merchant markup renders that surface on the same card as the
 *       stranded-draft note (/messages `supersededNoteFor`).
 *
 * Run: cd app && DB_PATH=/tmp/cc-superseded.db bun run test-superseded-draft.ts
 */
import { rmSync, readFileSync } from "node:fs";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-superseded.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;

const { getDb, ensureDefaultMerchant, upsertInvoice, createReminderTask } = await import("./src/db");
const { annotateSupersededDrafts } = await import("./src/pipeline/draft-readiness");

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
const merchant = db.query("SELECT id FROM merchants ORDER BY id LIMIT 1").get() as { id: number };
const merchantId = merchant.id;

function makeInvoice(suffix: string): number {
  return upsertInvoice(db, {
    stripe_invoice_id: `in_superseded_${suffix}`,
    merchant_id: merchantId,
    customer_name: "Dana Buyer",
    customer_email: "dana@example.com",
    amount_cents: 2700,
    currency: "usd",
    due_date: "2026-11-02",
    status: "overdue",
    livemode: 1,
  });
}

function setStatus(taskId: number, status: string): void {
  db.run("UPDATE reminder_tasks SET status=? WHERE id=?", [status, taskId]);
}

function supersededRows(taskId: number): Array<{ id: number; status: string; provider_message: string; type: string }> {
  return db
    .query("SELECT id, type, status, provider_message FROM send_logs WHERE reminder_task_id=? AND type='superseded'")
    .all(taskId) as Array<{ id: number; status: string; provider_message: string; type: string }>;
}

// ── (a)(b)(c) the production case: a reviewed stage-1 draft, ladder advances ──
const invoiceId = makeInvoice("356");
const stage1 = createReminderTask(db, invoiceId, 1);
db.run("UPDATE reminder_tasks SET status='reviewed', draft_subject='Invoice due', draft_body='Please pay.' WHERE id=?", [stage1]);

const logged: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
  realLog(...args);
};
const stage2 = createReminderTask(db, invoiceId, 2);
console.log = realLog;

const oldTask = db.query("SELECT status, stage FROM reminder_tasks WHERE id=?").get(stage1) as { status: string; stage: number };
const newTask = db.query("SELECT status, stage FROM reminder_tasks WHERE id=?").get(stage2) as { status: string; stage: number };

check("(c) ladder unchanged: replaced draft is cancelled", oldTask.status === "cancelled", `status=${oldTask.status}`);
check("(c) ladder unchanged: new task exists at the requested stage", newTask.stage === 2 && newTask.status === "pending", JSON.stringify(newTask));

const rows = supersededRows(stage1);
check("(a) exactly one superseded audit row on the replaced task", rows.length === 1, `rows=${rows.length}`);
const row = rows[0];
check("(a) audit row status is 'skipped' (nothing was sent)", row?.status === "skipped", `status=${row?.status}`);
const msg = row?.provider_message ?? "";
check("(a) audit row names the replaced task", msg.includes(`task ${stage1}`), msg);
check("(a) audit row names the replaced stage", msg.includes("Stage 1 draft"), msg);
check("(a) audit row names the replacing task", msg.includes(`task ${stage2}`), msg);
check("(a) audit row names the replacing stage", msg.includes("stage 2 reminder"), msg);
check("(c) nothing was emailed — no reminder-type log row", (
  db.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='reminder'").get() as { n: number }
).n === 0);

check("(b) a log line names both tasks", logged.some((l) =>
  l.includes(`superseded reviewed draft task ${stage1}`) && l.includes(`task ${stage2}`)), logged.join(" | "));

// ── (d) tasks no human ever saw as 'ready' stay quiet ──
const invoiceB = makeInvoice("quiet");
const pendingB = createReminderTask(db, invoiceB, 1);
createReminderTask(db, invoiceB, 2);
check("(d) a 'pending' task supersede writes no audit row", supersededRows(pendingB).length === 0);

const invoiceC = makeInvoice("drafted");
const draftedC = createReminderTask(db, invoiceC, 1);
setStatus(draftedC, "drafted");
createReminderTask(db, invoiceC, 2);
check("(d) a 'drafted' task supersede writes no audit row", supersededRows(draftedC).length === 0);

// ── (e) the read-only merchant surface ──
const invoiceD = makeInvoice("untouched");
const loneTask = createReminderTask(db, invoiceD, 1);

const rowsToAnnotate = [
  { id: stage2, invoice_id: invoiceId, stage: 2 },
  { id: stage1, invoice_id: invoiceId, stage: 1 },
  { id: loneTask, invoice_id: invoiceD, stage: 1 },
];
const before = (db.query("SELECT COUNT(*) AS n FROM send_logs").get() as { n: number }).n;
const annotated = annotateSupersededDrafts(db, rowsToAnnotate);
const after = (db.query("SELECT COUNT(*) AS n FROM send_logs").get() as { n: number }).n;

const onReplacement = annotated[0].superseded_draft;
check("(e) the replacing task reports the draft it replaced", onReplacement.length === 1 && onReplacement[0].task_id === stage1, JSON.stringify(onReplacement));
check("(e) it reports the replaced stage", onReplacement[0]?.stage === 1, JSON.stringify(onReplacement));
check("(e) it reports when", typeof onReplacement[0]?.at === "string" && onReplacement[0].at.length >= 10, JSON.stringify(onReplacement));
check("(e) a superseded task does not report itself", annotated[1].superseded_draft.length === 0, JSON.stringify(annotated[1].superseded_draft));
check("(e) an invoice that never lost a draft reports none", annotated[2].superseded_draft.length === 0, JSON.stringify(annotated[2].superseded_draft));
check("(e) the derivation is read-only (no send_logs rows added)", before === after, `${before} -> ${after}`);
check("(e) the derivation changes no task status", (
  db.query("SELECT status FROM reminder_tasks WHERE id=?").get(stage2) as { status: string }
).status === "pending");

// ── (f) merchant markup carries the surface next to the stranded-draft note ──
const messagesHtml = readFileSync(new URL("./src/ui/messages.html", import.meta.url), "utf-8");
check("(f) /messages renders a note for a superseded draft", messagesHtml.includes("function supersededNoteFor(t)"));
check("(f) /messages reads the server's superseded_draft field", messagesHtml.includes("t.superseded_draft"));
check("(f) the note is rendered on the task card", messagesHtml.includes("attentionNoteFor(t) + supersededNoteFor(t)"));

realLog(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
