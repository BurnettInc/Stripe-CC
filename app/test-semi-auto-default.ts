/**
 * Semi-Auto default + pre-connect guard test (2026-10-30).
 *
 * Owner decision: new Stripe connects land in Semi-Auto (trust_mode='semi'),
 * not Draft Mode, so a trial merchant who never clicks "approve" still gets a
 * first reminder. Guardrail: an invoice that was ALREADY overdue when the
 * merchant connected must NEVER auto-send — it is pinned to
 * invoices.trust_mode_override='draft' during the install backfill and stays a
 * draft until the merchant approves it. Invoices that fall due AFTER connect are
 * chased automatically from stage 1.
 *
 * What this proves (all against the real code paths, no server, no network,
 * no email — the sender falls back to its log-only stub with no provider keys):
 *   B1. A brand-new merchant from findOrCreateMerchant() has trust_mode='semi'.
 *   B2. Install backfill (connectCutoff = connect time): an invoice already
 *       overdue at connect gets trust_mode_override='draft'; an invoice due
 *       after connect gets no override. heldForApproval=1.
 *   B3. Task creation for that pre-connect overdue invoice: the draft is
 *       reviewed and NOT sent — task stays 'reviewed', no send_logs success.
 *       The block comes from the OVERRIDE, not from pause/trial: the merchant
 *       is unpaused, connected, and inside its free trial (so the send gates
 *       would all have allowed it).
 *   B4. An invoice that goes overdue AFTER connect DOES auto-send stage 1 in
 *       Semi-Auto (task 'sent' + send_logs success row).
 *   B5. An existing Draft Mode merchant is unaffected: still 'draft', its
 *       overdue invoice still waits for approval, nothing sent.
 *   B6. A merchant's own explicit override is never overwritten by backfill.
 *   B7. The recurring sync backfill (no connectCutoff) never applies the guard.
 *
 * Run: cd app && bun run test-semi-auto-default.ts
 */
import { rmSync } from "node:fs";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-semiauto.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "";

const { getDb } = await import("./src/db");
const { findOrCreateMerchant, backfillMerchantInvoices } = await import("./src/routes/oauth-app-install");
const { createTaskForOverdueInvoice } = await import("./src/pipeline/watcher");
const { hasActiveSubscription } = await import("./src/db");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const db = getDb();
const DAY = 86400;

// ── Stripe API stub (install backfill only calls GET /v1/invoices) ──
let stubInvoices: Array<Record<string, unknown>> = [];
let lastStripeUrl = "";
globalThis.fetch = (async (input: any) => {
  lastStripeUrl = String(input);
  return new Response(JSON.stringify({ data: stubInvoices }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

function stripeInvoice(opts: {
  id: string;
  amountDue: number;
  dueUnix: number;
  customerName?: string;
  customerEmail?: string;
  status?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    status: opts.status ?? "open",
    amount_due: opts.amountDue,
    amount_paid: 0,
    currency: "usd",
    created: Math.floor(Date.now() / 1000) - 400 * DAY,
    due_date: opts.dueUnix,
    customer_name: opts.customerName ?? "Jenny Rosen",
    customer_email: opts.customerEmail ?? "customer@example.com",
  };
}
const nowUnix = Math.floor(Date.now() / 1000);
const dueLongAgo = nowUnix - 3 * DAY; // already overdue at connect, but recent enough to be stage 1
const dueSoon = nowUnix + 5 * DAY; // falls due AFTER connect

function merchantRow(id: number): any {
  return db.query("SELECT * FROM merchants WHERE id=?").get(id);
}
function invoiceRow(stripeId: string): any {
  return db.query("SELECT * FROM invoices WHERE stripe_invoice_id=?").get(stripeId);
}
function taskFor(invoiceId: number): any {
  return db.query("SELECT * FROM reminder_tasks WHERE invoice_id=? ORDER BY id DESC LIMIT 1").get(invoiceId);
}
function successSends(taskId: number): number {
  return (db.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=? AND status='success'").get(taskId) as any).n;
}

console.log("── B1. New connects default to Semi-Auto ──");
const newMerchantId = findOrCreateMerchant(db, "acct_new_semi_merchant", "new@example.com", null, "vid-test");
const newMerchant = merchantRow(newMerchantId);
check("B1 brand-new merchant trust_mode === 'semi'", newMerchant.trust_mode === "semi", `got ${newMerchant.trust_mode}`);

console.log("── B2. Install backfill: pre-connect overdue held, post-connect not ──");
stubInvoices = [
  stripeInvoice({ id: "in_PRECONNECT_OVERDUE", amountDue: 10500, dueUnix: dueLongAgo }),
  stripeInvoice({ id: "in_FUTURE_DUE", amountDue: 2700, dueUnix: dueSoon }),
];
const backfill = await backfillMerchantInvoices(db, newMerchantId, "tok_test", {
  livemode: 1,
  connectCutoff: newMerchant.created_at,
});
check("B2a backfill ran against the Stripe invoices endpoint", lastStripeUrl.includes("/invoices?limit=100"), lastStripeUrl);
check("B2b two invoices inserted", backfill.inserted === 2, JSON.stringify(backfill));
check("B2c exactly one invoice held for approval", backfill.heldForApproval === 1, JSON.stringify(backfill));
const preConnect = invoiceRow("in_PRECONNECT_OVERDUE");
const postConnect = invoiceRow("in_FUTURE_DUE");
check("B2d already-overdue-at-connect invoice is trust_mode_override='draft'", preConnect.trust_mode_override === "draft", `got ${preConnect.trust_mode_override}`);
check("B2e invoice due after connect has no override (auto-chase)", postConnect.trust_mode_override === null, `got ${postConnect.trust_mode_override}`);
check("B2f pre-connect invoice stored as 'overdue'", preConnect.status === "overdue", preConnect.status);
check("B2g post-connect invoice stored as 'open'", postConnect.status === "open", postConnect.status);

console.log("── B3. Pre-connect overdue invoice cannot auto-send (blocked at the override) ──");
// Prove the block is the OVERRIDE, not pause / trial / tier:
check("B3a merchant is NOT paused", merchantRow(newMerchantId).paused === 0);
check("B3b merchant is NOT disconnected", merchantRow(newMerchantId).disconnected === 0);
check("B3c merchant has send entitlement (free trial)", hasActiveSubscription(db, newMerchantId) === true);
check("B3d merchant trust_mode is 'semi' (would auto-send stage 1 without the override)", merchantRow(newMerchantId).trust_mode === "semi");

const r3 = await createTaskForOverdueInvoice(db, preConnect, { overdueBefore: 0 });
const t3 = taskFor(preConnect.id);
check("B3e a task WAS created (the invoice is tracked)", typeof r3.taskId === "number", JSON.stringify(r3));
check("B3f task stage is 1", t3?.stage === 1, `stage ${t3?.stage}`);
check("B3g task stayed 'reviewed' — NOT sent", t3?.status === "reviewed", `status ${t3?.status}`);
check("B3h no successful send logged", successSends(t3!.id) === 0);
check("B3i sent_at is null", t3?.sent_at === null || t3?.sent_at === undefined);
check("B3j the draft itself was produced (ready for the merchant to approve)", typeof t3?.draft_body === "string" && t3.draft_body.length > 20);

console.log("── B4. Invoice that goes overdue AFTER connect auto-sends stage 1 ──");
// Simulate the 15-minute sync pass flipping the future-due invoice to overdue.
const laterDue = new Date(Date.now() - 2 * DAY).toISOString().split("T")[0];
db.run("UPDATE invoices SET status='overdue', due_date=? WHERE id=?", [laterDue, postConnect.id]);
const r4 = await createTaskForOverdueInvoice(db, invoiceRow("in_FUTURE_DUE"), { overdueBefore: 1 });
const t4 = taskFor(postConnect.id);
check("B4a task created for the post-connect overdue invoice", typeof r4.taskId === "number", JSON.stringify(r4));
check("B4b stage 1", t4?.stage === 1, `stage ${t4?.stage}`);
check("B4c auto-sent in Semi-Auto (status 'sent')", t4?.status === "sent", `status ${t4?.status}`);
check("B4d a successful send was logged", successSends(t4!.id) === 1);
check("B4e sent_at recorded", typeof t4?.sent_at === "string" && t4.sent_at.length > 0, String(t4?.sent_at));

console.log("── B5. Existing Draft Mode merchant unaffected ──");
const draftMerchantId = findOrCreateMerchant(db, "acct_existing_draft", "drafty@example.com", null, "");
db.run("UPDATE merchants SET trust_mode='draft' WHERE id=?", [draftMerchantId]); // pre-change merchant
db.run(
  "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'overdue')",
  ["in_EXISTING_DRAFT_MERCHANT", draftMerchantId, "Old Customer", "old@example.com", 4200, "usd", laterDue]
);
const draftInv = invoiceRow("in_EXISTING_DRAFT_MERCHANT");
const r5 = await createTaskForOverdueInvoice(db, draftInv, { overdueBefore: 0 });
const t5 = taskFor(draftInv.id);
check("B5a draft merchant's trust_mode is still 'draft'", merchantRow(draftMerchantId).trust_mode === "draft");
check("B5b its overdue invoice gets NO override", draftInv.trust_mode_override === null, `got ${draftInv.trust_mode_override}`);
check("B5c task created but stays 'reviewed'", typeof r5.taskId === "number" && t5?.status === "reviewed", `status ${t5?.status}`);
check("B5d nothing was sent", successSends(t5!.id) === 0);

console.log("── B6. A merchant's own override is never overwritten ──");
const ownMerchantId = findOrCreateMerchant(db, "acct_own_override", "own@example.com", null, "");
stubInvoices = [stripeInvoice({ id: "in_OWN_OVERRIDE", amountDue: 9000, dueUnix: dueLongAgo })];
db.run(
  "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, trust_mode_override) VALUES (?, ?, ?, ?, ?, ?, ?, 'overdue', 'semi')",
  ["in_OWN_OVERRIDE", ownMerchantId, "Jenny Rosen", "customer@example.com", 9000, "usd", "2024-01-01"]
);
const own = await backfillMerchantInvoices(db, ownMerchantId, "tok", { livemode: 1, connectCutoff: merchantRow(ownMerchantId).created_at });
check("B6a explicit 'semi' override preserved", invoiceRow("in_OWN_OVERRIDE").trust_mode_override === "semi", `got ${invoiceRow("in_OWN_OVERRIDE").trust_mode_override}`);
check("B6b not counted as newly held", own.heldForApproval === 0, JSON.stringify(own));

console.log("── B7. Recurring sync backfill (no cutoff) never applies the guard ──");
const syncMerchantId = findOrCreateMerchant(db, "acct_sync_no_cutoff", "sync@example.com", null, "");
stubInvoices = [stripeInvoice({ id: "in_SYNC_NO_CUTOFF", amountDue: 3300, dueUnix: dueLongAgo })];
const syncRun = await backfillMerchantInvoices(db, syncMerchantId, "tok", { livemode: 1 });
check("B7a sync backfill holds nothing", syncRun.heldForApproval === 0, JSON.stringify(syncRun));
check("B7b no override written by the sync pass", invoiceRow("in_SYNC_NO_CUTOFF").trust_mode_override === null, `got ${invoiceRow("in_SYNC_NO_CUTOFF").trust_mode_override}`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail === 0 ? 0 : 1);
