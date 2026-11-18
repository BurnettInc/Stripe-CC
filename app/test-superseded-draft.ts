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
 * UPDATE 2026-11-16 (owner decision): the ladder now HOLDS on an unsent
 * `reviewed` draft instead of replacing it — no task is created and nothing is
 * cancelled. `superseded` rows are therefore historical only (pre-11/16); the
 * full hold proof lives in test-ladder-hold.ts. This suite keeps the audit and
 * the merchant-facing surface honest:
 *
 * THIS SUITE PROVES:
 *   (a) a `reviewed` draft is NO LONGER superseded — the stage boundary holds,
 *       writes no 'superseded' row and leaves the draft in place;
 *   (b) nothing is emailed and no second task appears for that invoice;
 *   (c) the pre-11/16 'superseded' audit row is still read and surfaced;
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

const { getDb, ensureDefaultMerchant, upsertInvoice, createReminderTask, logSend } = await import("./src/db");
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
// Owner decision 2026-11-16: the ladder HOLDS here. Nothing is created, nothing
// is cancelled, nothing is superseded.
const invoiceId = makeInvoice("356");
const stage1 = createReminderTask(db, invoiceId, 1) as number;
db.run("UPDATE reminder_tasks SET status='reviewed', draft_subject='Invoice due', draft_body='Please pay.' WHERE id=?", [stage1]);

const logged: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
  realLog(...args);
};
const held = createReminderTask(db, invoiceId, 2);
console.log = realLog;

const oldTask = db.query("SELECT status, stage, draft_body FROM reminder_tasks WHERE id=?").get(stage1) as { status: string; stage: number; draft_body: string | null };
const taskCount = (db.query("SELECT COUNT(*) AS n FROM reminder_tasks WHERE invoice_id=?").get(invoiceId) as { n: number }).n;

check("(a) the hold creates no task", held === null, `result=${String(held)}`);
check("(a) the reviewed draft is NOT cancelled", oldTask.status === "reviewed", `status=${oldTask.status}`);
check("(a) the reviewed draft's body is untouched", oldTask.draft_body === "Please pay.", String(oldTask.draft_body));
check("(a) no second task exists for the invoice", taskCount === 1, `count=${taskCount}`);
check("(a) no 'superseded' audit row is written any more", supersededRows(stage1).length === 0, `rows=${supersededRows(stage1).length}`);
check("(b) nothing was emailed — no reminder-type log row", (
  db.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='reminder'").get() as { n: number }
).n === 0);
check("(b) the hold is recorded instead", (
  db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND type='ladder_held'").get(stage1) as { n: number }
).n === 1);
check("(b) a log line names the invoice, stage and blocking draft", logged.some((l) =>
  l.includes(`ladder held for invoice ${invoiceId}`) && l.includes("stage 2") && l.includes(String(stage1))), logged.join(" | "));

// ── (d) tasks no human ever saw as 'ready' stay quiet ──
const invoiceB = makeInvoice("quiet");
const pendingB = createReminderTask(db, invoiceB, 1) as number;
createReminderTask(db, invoiceB, 2);
check("(d) a 'pending' task supersede writes no audit row", supersededRows(pendingB).length === 0);

const invoiceC = makeInvoice("drafted");
const draftedC = createReminderTask(db, invoiceC, 1) as number;
setStatus(draftedC, "drafted");
createReminderTask(db, invoiceC, 2);
check("(d) a 'drafted' task supersede writes no audit row", supersededRows(draftedC).length === 0);

// ── (e) the read-only merchant surface (historical superseded rows) ──
// The ladder no longer supersedes a reviewed draft, so the row that PR #254
// wrote for one is seeded here directly — the merchant surface must still read
// and show the superseded drafts that already exist in production.
const invoiceD = makeInvoice("untouched");
const loneTask = createReminderTask(db, invoiceD, 1) as number;

const invoiceE = makeInvoice("historical");
const replacedE = createReminderTask(db, invoiceE, 1) as number;
setStatus(replacedE, "cancelled");
const replacementE = createReminderTask(db, invoiceE, 2) as number;
logSend(
  db,
  replacedE,
  "skipped",
  `Stage 1 draft (task ${replacedE}) was cancelled unsent when the stage 2 reminder (task ${replacementE}) replaced it at the escalation stage boundary. No email was sent.`,
  "superseded",
);

const rowsToAnnotate = [
  { id: replacementE, invoice_id: invoiceE, stage: 2 },
  { id: replacedE, invoice_id: invoiceE, stage: 1 },
  { id: loneTask, invoice_id: invoiceD, stage: 1 },
];
const before = (db.query("SELECT COUNT(*) AS n FROM send_logs").get() as { n: number }).n;
const annotated = annotateSupersededDrafts(db, rowsToAnnotate);
const after = (db.query("SELECT COUNT(*) AS n FROM send_logs").get() as { n: number }).n;

const onReplacement = annotated[0].superseded_draft;
check("(e) the replacing task reports the draft it replaced", onReplacement.length === 1 && onReplacement[0].task_id === replacedE, JSON.stringify(onReplacement));
check("(e) it reports the replaced stage", onReplacement[0]?.stage === 1, JSON.stringify(onReplacement));
check("(e) it reports when", typeof onReplacement[0]?.at === "string" && onReplacement[0].at.length >= 10, JSON.stringify(onReplacement));
check("(e) a superseded task does not report itself", annotated[1].superseded_draft.length === 0, JSON.stringify(annotated[1].superseded_draft));
check("(e) an invoice that never lost a draft reports none", annotated[2].superseded_draft.length === 0, JSON.stringify(annotated[2].superseded_draft));
check("(e) the derivation is read-only (no send_logs rows added)", before === after, `${before} -> ${after}`);
check("(e) the derivation changes no task status", (
  db.query("SELECT status FROM reminder_tasks WHERE id=?").get(replacementE) as { status: string }
).status === "pending");

// ── (f) merchant markup carries the surface next to the stranded-draft note ──
const messagesHtml = readFileSync(new URL("./src/ui/messages.html", import.meta.url), "utf-8");
check("(f) /messages renders a note for a superseded draft", messagesHtml.includes("function supersededNoteFor(t)"));
check("(f) /messages reads the server's superseded_draft field", messagesHtml.includes("t.superseded_draft"));
check("(f) the note is rendered on the task card", messagesHtml.includes("attentionNoteFor(t) + supersededNoteFor(t)"));

realLog(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
