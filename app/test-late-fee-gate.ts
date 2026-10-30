/**
 * Late-fee gate regression test (2026-10-30).
 *
 * Production reminder_task 71 (merchant 9, 2026-10-24) shipped a draft body
 * containing the sentence:
 *
 *   "A late fee of none may apply per your payment terms."
 *
 * The drafter violated its own rule 9 (the prompt's "none" placeholder leaked
 * into the copy) and the reviewer approved it. With Semi-Auto as the default
 * for new trials, a sentence like that would reach merchants' CUSTOMERS with no
 * human in the loop, so the gate must reject it — not just the prompt.
 *
 * What this test proves:
 *   A1. The exact offending string is REJECTED when no late fee is configured.
 *   A2. A clean draft (no fee sentence) with no fee configured is approved.
 *   A3. An explicit NEGATION ("we do not charge a late fee") is allowed — a
 *       merchant editing a draft by hand must not be blocked for that.
 *   A4. A configured fee + the exact fragment from late-fee.ts is approved.
 *   A5. A configured fee + a wrong/missing amount is rejected (unchanged math
 *       guarantee).
 *   A6. "late fee of none" is rejected even when a fee IS configured (the
 *       placeholder is never legitimate).
 *   A7. The template-fallback drafter emits NO late-fee sentence when the
 *       merchant's late_fee_type is 'none' (source fix, not just the gate).
 *   A8. The stage-2/3 template fallback still emits the fee sentence when a
 *       flat fee IS configured, and the reviewer approves it.
 *
 * Pure/unit test — no server, no network, no email. Run:
 *   cd app && DB_PATH=/tmp/cc-latefee.db bun run test-late-fee-gate.ts
 */
import { rmSync } from "node:fs";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-latefee.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;

const { reviewDraft } = await import("./src/pipeline/reviewer");
const { draftEmail } = await import("./src/pipeline/drafter");
const { getDb } = await import("./src/db");

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

const INVOICE = {
  id: 1,
  stripe_invoice_id: "in_TESTLATEFEE001",
  merchant_id: 1,
  customer_name: "Jenny Rosen",
  customer_email: "customer@example.com",
  amount_cents: 10500,
  currency: "usd",
  due_date: "2025-09-18",
  status: "overdue",
} as any;
const LINK = `https://dashboard.stripe.com/invoices/${INVOICE.stripe_invoice_id}`;
const CLEAN_BODY = `Hi Jenny,\n\nInvoice ${INVOICE.stripe_invoice_id} for 105.00 was due on 2025-09-18. It is now 401 days past due — is there anything blocking payment on your end?\n\nHere's the payment link: ${LINK}\n\nThanks!`;

console.log("── A. Late-fee reviewer gate ──");

// A1 — the exact production defect.
const OFFENDING = `${CLEAN_BODY}\n\nA late fee of none may apply per your payment terms.`;
const r1 = reviewDraft({ subject: "Reminder: Invoice #in_TESTLATEFEE001", body: OFFENDING }, INVOICE, {
  lateFeeText: null,
});
check(
  "A1 exact offending string 'A late fee of none may apply per your payment terms.' is REJECTED",
  r1.approved === false && r1.issues.some((i) => /late fee/i.test(i)),
  `approved=${r1.approved} issues=${JSON.stringify(r1.issues)}`
);

// A1b — same sentence, no opts at all (fail-closed: unknown fee config).
const r1b = reviewDraft({ subject: "Reminder", body: OFFENDING }, INVOICE);
check("A1b offending string rejected even without explicit opts", r1b.approved === false, JSON.stringify(r1b.issues));

// A2 — clean draft, no fee configured.
const r2 = reviewDraft({ subject: "Reminder: Invoice #in_TESTLATEFEE001", body: CLEAN_BODY }, INVOICE, {
  lateFeeText: null,
});
check("A2 clean draft with no fee configured is approved", r2.approved === true, JSON.stringify(r2.issues));

// A3 — explicit negation is allowed (merchant-edited copy).
const NEGATED = `${CLEAN_BODY}\n\nThere is no late fee on this invoice.`;
const r3 = reviewDraft({ subject: "Reminder", body: NEGATED }, INVOICE, { lateFeeText: null });
check("A3 explicit negation ('no late fee') is allowed", r3.approved === true, JSON.stringify(r3.issues));

// A3b — an invented fee amount with no fee configured is rejected.
const INVENTED = `${CLEAN_BODY}\n\nA late fee of $25.00 may apply per your payment terms.`;
const r3b = reviewDraft({ subject: "Reminder", body: INVENTED }, INVOICE, { lateFeeText: null });
check("A3b invented late-fee amount with no fee configured is rejected", r3b.approved === false, JSON.stringify(r3b.issues));

// A4 — configured fee, exact fragment present.
const FEE = "$25.00";
const WITH_FEE = `${CLEAN_BODY}\n\nA late fee of ${FEE} may apply per your payment terms.`;
const r4 = reviewDraft({ subject: "Reminder", body: WITH_FEE }, INVOICE, { lateFeeText: FEE });
check("A4 configured fee + exact fragment is approved", r4.approved === true, JSON.stringify(r4.issues));

// A5 — configured fee, missing fragment.
const r5 = reviewDraft({ subject: "Reminder", body: CLEAN_BODY }, INVOICE, { lateFeeText: FEE });
check("A5 configured fee + missing fragment is rejected", r5.approved === false, JSON.stringify(r5.issues));

// A6 — placeholder rejected even with a configured fee.
const BOTH = `${CLEAN_BODY}\n\nA late fee of none may apply per your payment terms.\n\nA late fee of ${FEE} may apply per your payment terms.`;
const r6 = reviewDraft({ subject: "Reminder", body: BOTH }, INVOICE, { lateFeeText: FEE });
check("A6 'late fee of none' rejected even when a fee is configured", r6.approved === false, JSON.stringify(r6.issues));

// A6b — the send-time helper used by POST /tasks/:id/approve (stored drafts
// reviewed before this gate existed, e.g. production reminder_task 71).
const { placeholderLateFeeIssue } = await import("./src/pipeline/reviewer");
check(
  "A6b placeholderLateFeeIssue() flags the offending string",
  typeof placeholderLateFeeIssue(OFFENDING) === "string"
);
check("A6c placeholderLateFeeIssue() passes a clean draft", placeholderLateFeeIssue(CLEAN_BODY) === null);
check(
  "A6d placeholderLateFeeIssue() passes a legitimate fee sentence",
  placeholderLateFeeIssue(WITH_FEE) === null
);

console.log("── B. Drafter source fix (template fallback) ──");
const db = getDb();
db.run("INSERT INTO merchants (stripe_account_id, email, trust_mode, late_fee_type, late_fee_value) VALUES ('acct_latefee', 'm@example.com', 'semi', 'none', 0)");
const merchantId = Number((db.query("SELECT id FROM merchants WHERE stripe_account_id='acct_latefee'").get() as any).id);
db.run(
  "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'overdue')",
  [INVOICE.stripe_invoice_id, merchantId, INVOICE.customer_name, INVOICE.customer_email, INVOICE.amount_cents, "usd", INVOICE.due_date]
);
const invoiceId = Number((db.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(INVOICE.stripe_invoice_id) as any).id);
const inv = db.query("SELECT * FROM invoices WHERE id=?").get(invoiceId) as any;

function task(stage: number) {
  return {
    id: 900 + stage,
    invoice_id: invoiceId,
    stage,
    status: "pending",
    draft_subject: "",
    draft_body: "",
  } as any;
}

// A7 — late_fee_type 'none' at stage 3: no fee sentence at all.
const d3 = await draftEmail(task(3), inv, "Acme Co", db);
const feeMention3 = /late[\s-]+fee/i.test(`${d3.subject}\n${d3.body}`);
check("A7 stage-3 fallback draft with late_fee_type='none' mentions NO late fee", feeMention3 === false, d3.body);
const r7 = reviewDraft(d3, inv, { lateFeeText: null });
check("A7b that stage-3 fallback draft is approved by the reviewer", r7.approved === true, JSON.stringify(r7.issues));

// A8 — flat fee configured: sentence appears and is approved.
db.run("UPDATE merchants SET late_fee_type='flat', late_fee_value=25 WHERE id=?", [merchantId]);
const d3fee = await draftEmail(task(3), inv, "Acme Co", db);
const hasFee = d3fee.body.includes("A late fee of $25.00 may apply per your payment terms.");
check("A8 stage-3 fallback with a flat fee still emits the fee sentence", hasFee, d3fee.body);
const r8 = reviewDraft(d3fee, inv, { lateFeeText: "$25.00" });
check("A8b that fee draft is approved by the reviewer", r8.approved === true, JSON.stringify(r8.issues));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail === 0 ? 0 : 1);
