/**
 * Customer payment link regression test (2026-11-06).
 *
 * THE DEFECT: every reminder the Drafter wrote paid via
 * `https://dashboard.stripe.com/invoices/<stripe_invoice_id>`. That URL is the
 * MERCHANT'S OWN Stripe dashboard — a customer who clicks it hits a Stripe
 * login wall and cannot pay. All 13 reminders ever sent carried it, and the app
 * had never stored Stripe's real customer-facing link at all.
 *
 * THE FIX: invoices.hosted_invoice_url (+ invoice_pdf) is persisted from every
 * Stripe invoice object at sync time, the drafter/reply copy uses it, and when
 * it is NULL the copy carries NO payment URL at all (never the dashboard link).
 * The reviewer rejects any draft containing dashboard.stripe.com, whatever the
 * upstream code does.
 *
 * What this test proves:
 *   A1. upsertInvoice stores hosted_invoice_url + invoice_pdf on INSERT.
 *   A2. A re-sync with a NEW hosted_invoice_url overwrites the stored one
 *       (Stripe can rotate the page).
 *   A3. A re-sync that carries NO link never wipes the stored one (a voided or
 *       legacy payload must not break the reminder).
 *   B1. The drafter's template fallback (no LLM key) contains the hosted link
 *       and never the dashboard link, at every stage.
 *   B2. With hosted_invoice_url NULL the draft contains NO URL AT ALL.
 *   C1. The reviewer REJECTS any draft containing dashboard.stripe.com
 *       (subject or body), whatever the invoice's stored link.
 *   C2. merchantDashboardUrlIssue() — the send-time guard helper — flags it.
 *   C3. A draft carrying the invoice's hosted link is approved.
 *   C4. A draft with NO link is approved when the invoice has no hosted link
 *       (the reminder still works as a reminder).
 *   C5. A draft that omits the hosted link while the invoice HAS one is rejected.
 *   D1. Source guard: neither drafter.ts nor reply-ai.ts builds a
 *       dashboard.stripe.com URL any more.
 *   E1-E6. Rotated hosted link (2026-11-07): a stale same-account token is
 *       rewritten to the invoice's current one and NOTHING else in the draft
 *       changes; a draft with no link is never given one; another account's
 *       link is never adopted; the dashboard link is never touched.
 *   E7-E13. The invoice-sync sweep + the single-task send-path repair: the
 *       reviewer rejects the stale draft BEFORE, approves it AFTER, a sent task
 *       is never rewritten, the sweep is idempotent.
 *
 * Pure/unit test — no server, no network, no email, no production DB. Run:
 *   cd app && bun run test-hosted-payment-link.ts
 */
import { readFileSync, rmSync } from "node:fs";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-hosted-link.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY; // force the deterministic template fallback

const { getDb, upsertInvoice, paymentLinkFor, invoiceNumberFor } = await import("./src/db");
const { draftEmail } = await import("./src/pipeline/drafter");
const { reviewDraft, merchantDashboardUrlIssue } = await import("./src/pipeline/reviewer");
const { refreshHostedLinkText, repairStaleHostedLinks, repairTaskHostedLink } = await import(
  "./src/pipeline/hosted-link-repair"
);

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
db.run(
  "INSERT INTO merchants (stripe_account_id, email, trust_mode) VALUES ('acct_hostedlink', 'm@example.com', 'semi')"
);
const merchantId = Number(
  (db.query("SELECT id FROM merchants WHERE stripe_account_id='acct_hostedlink'").get() as { id: number }).id
);

const HOSTED = "https://invoice.stripe.com/i/acct_hostedlink/live_hostedlink?s=ap";
const PDF = "https://pay.stripe.com/invoice/acct_hostedlink/live_hostedlink/pdf";
const DASHBOARD = "https://dashboard.stripe.com/invoices/";

function baseParams(stripeInvoiceId: string, extra: Record<string, unknown> = {}) {
  return {
    stripe_invoice_id: stripeInvoiceId,
    merchant_id: merchantId,
    customer_name: "Jenny Rosen",
    customer_email: "customer@example.com",
    amount_cents: 2700,
    currency: "usd",
    due_date: "2026-10-01",
    status: "overdue",
    ...extra,
  } as Parameters<typeof upsertInvoice>[1];
}

console.log("── A. Persistence at sync time ──");

// A1 — INSERT stores both links.
const invId = upsertInvoice(db, baseParams("in_HOSTED001", { hosted_invoice_url: HOSTED, invoice_pdf: PDF }));
const row1 = db.query("SELECT * FROM invoices WHERE id=?").get(invId) as any;
check(
  "A1 upsertInvoice stores hosted_invoice_url + invoice_pdf on INSERT",
  row1.hosted_invoice_url === HOSTED && row1.invoice_pdf === PDF,
  JSON.stringify({ hosted: row1.hosted_invoice_url, pdf: row1.invoice_pdf })
);

// A2 — a re-sync with a rotated link updates the stored one.
const HOSTED_ROTATED = "https://invoice.stripe.com/i/acct_hostedlink/live_rotated?s=ap";
upsertInvoice(db, baseParams("in_HOSTED001", { hosted_invoice_url: HOSTED_ROTATED, invoice_pdf: PDF }));
const row2 = db.query("SELECT * FROM invoices WHERE id=?").get(invId) as any;
check(
  "A2 a re-sync with a new hosted_invoice_url updates the stored row",
  row2.hosted_invoice_url === HOSTED_ROTATED,
  JSON.stringify({ hosted: row2.hosted_invoice_url })
);

// A3 — a re-sync with NO link (voided / legacy payload) must not wipe it.
upsertInvoice(db, baseParams("in_HOSTED001", { status: "void" }));
const row3 = db.query("SELECT * FROM invoices WHERE id=?").get(invId) as any;
check(
  "A3 a re-sync with no link keeps the stored hosted_invoice_url",
  row3.hosted_invoice_url === HOSTED_ROTATED,
  JSON.stringify({ hosted: row3.hosted_invoice_url, status: row3.status })
);

// A4 — paymentLinkFor is the single source of truth for copy.
check("A4 paymentLinkFor returns the stored link", paymentLinkFor(row3) === HOSTED_ROTATED);
check("A5 paymentLinkFor returns null for an empty/absent link", paymentLinkFor({ hosted_invoice_url: null }) === null);

// A6/A7 — the customer-facing invoice number (Stripe's invoice.number) is
// stored at sync, and a later payload WITHOUT one never wipes it: Stripe
// assigns the number at finalization, so early payloads carry null.
const numId = upsertInvoice(db, baseParams("in_HOSTED004", { invoice_number: "INV-0042" }));
const numRow = db.query("SELECT * FROM invoices WHERE id=?").get(numId) as any;
check("A6 upsertInvoice stores invoice_number on INSERT", numRow.invoice_number === "INV-0042", JSON.stringify({ number: numRow.invoice_number }));
upsertInvoice(db, baseParams("in_HOSTED004"));
const numRow2 = db.query("SELECT * FROM invoices WHERE id=?").get(numId) as any;
check("A7 a re-sync with no number keeps the stored invoice_number", numRow2.invoice_number === "INV-0042", JSON.stringify({ number: numRow2.invoice_number }));
check("A8 invoiceNumberFor returns the stored number", invoiceNumberFor(numRow2) === "INV-0042", String(invoiceNumberFor(numRow2)));
check(
  "A8b invoiceNumberFor never returns Stripe's internal id, and null when there is none",
  invoiceNumberFor({ invoice_number: "in_HOSTED004" }) === null && invoiceNumberFor({ invoice_number: null }) === null
);

console.log("── B. Drafter output ──");

// B1 — every stage's template fallback carries the hosted link, never the dashboard.
const liveInvId = upsertInvoice(db, baseParams("in_HOSTED002", { hosted_invoice_url: HOSTED, invoice_pdf: PDF }));
const liveInv = db.query("SELECT * FROM invoices WHERE id=?").get(liveInvId) as any;
for (const stage of [1, 2, 3]) {
  const task = { id: 900 + stage, invoice_id: liveInvId, stage, status: "pending", draft_subject: "", draft_body: "" } as any;
  const d = await draftEmail(task, liveInv, "Acme Co", db);
  check(
    `B1 stage ${stage} draft contains the Stripe-hosted payment link`,
    d.body.includes(HOSTED),
    d.body
  );
  check(
    `B1b stage ${stage} draft contains NO dashboard.stripe.com URL`,
    !/dashboard\.stripe\.com/i.test(`${d.subject}\n${d.body}`),
    d.body
  );
}

// B2 — no hosted link stored → NO URL at all (never a fallback).
const bareInvId = upsertInvoice(db, baseParams("in_HOSTED003", { invoice_number: "INV-0003" }));
const bareInv = db.query("SELECT * FROM invoices WHERE id=?").get(bareInvId) as any;
check("B2 the row really has no hosted link", bareInv.hosted_invoice_url === null);
for (const stage of [1, 2, 3]) {
  const task = { id: 800 + stage, invoice_id: bareInvId, stage, status: "pending", draft_subject: "", draft_body: "" } as any;
  const d = await draftEmail(task, bareInv, "Acme Co", db);
  check(
    `B2b stage ${stage} draft with hosted_invoice_url NULL contains NO URL at all`,
    !/https?:\/\//i.test(`${d.subject}\n${d.body}`),
    d.body
  );
  check(
    `B2c stage ${stage} draft with hosted_invoice_url NULL still names the invoice + amount`,
    d.body.includes("INV-0003") && !d.body.includes("in_HOSTED003") && d.body.includes("27.00"),
    d.body
  );
}

console.log("── C. Reviewer hard gate ──");

const CLEAN_HOSTED = `Hi Jenny,\n\nInvoice in_HOSTED002 for 27.00 was due on 2026-10-01. You can pay here: ${HOSTED}\n\nThanks!`;

// C1 — the dashboard link is rejected, in the body and in the subject.
const bodyDash = reviewDraft({ subject: "Reminder", body: `${CLEAN_HOSTED}\n\nOr pay at ${DASHBOARD}in_HOSTED002` }, liveInv);
check(
  "C1 reviewer REJECTS a draft whose body contains dashboard.stripe.com",
  bodyDash.approved === false && bodyDash.issues.some((i) => /dashboard/i.test(i)),
  JSON.stringify(bodyDash.issues)
);
const subjectDash = reviewDraft({ subject: `Pay at ${DASHBOARD}in_HOSTED002`, body: CLEAN_HOSTED }, liveInv);
check(
  "C1b reviewer REJECTS a draft whose SUBJECT contains dashboard.stripe.com",
  subjectDash.approved === false && subjectDash.issues.some((i) => /dashboard/i.test(i)),
  JSON.stringify(subjectDash.issues)
);
const dashNoHostedInvoice = reviewDraft({ subject: "Reminder", body: `Pay at ${DASHBOARD}in_HOSTED003` }, bareInv);
check(
  "C1c dashboard link rejected even when the invoice has no hosted link (no fallback is ever valid)",
  dashNoHostedInvoice.approved === false,
  JSON.stringify(dashNoHostedInvoice.issues)
);

// C2 — the send-time helper used by POST /tasks/:id/approve.
check("C2 merchantDashboardUrlIssue() flags the dashboard link", typeof merchantDashboardUrlIssue(`${DASHBOARD}in_1`) === "string");
check("C2b merchantDashboardUrlIssue() passes the hosted link", merchantDashboardUrlIssue(CLEAN_HOSTED) === null);

// C3 — the hosted link is approved.
const okHosted = reviewDraft({ subject: "Reminder: Invoice #in_HOSTED002", body: CLEAN_HOSTED }, liveInv, { lateFeeText: null });
check("C3 a draft carrying the invoice's hosted link is approved", okHosted.approved === true, JSON.stringify(okHosted.issues));

// C4 — no link required when the invoice has no hosted page.
const okNoLink = reviewDraft(
  { subject: "Reminder: Invoice #in_HOSTED003", body: "Hi Jenny,\n\nInvoice in_HOSTED003 for 27.00 was due on 2026-10-01.\n\nThanks!" },
  bareInv,
  { lateFeeText: null }
);
check("C4 a draft with no link is approved when the invoice has no hosted link", okNoLink.approved === true, JSON.stringify(okNoLink.issues));

// C5 — but a draft that DROPS the hosted link the invoice does have is rejected.
const missingHosted = reviewDraft(
  { subject: "Reminder: Invoice #in_HOSTED002", body: "Hi Jenny,\n\nInvoice in_HOSTED002 for 27.00 was due on 2026-10-01.\n\nThanks!" },
  liveInv,
  { lateFeeText: null }
);
check(
  "C5 a draft missing the invoice's hosted link is rejected",
  missingHosted.approved === false && missingHosted.issues.some((i) => /hosted payment link/i.test(i)),
  JSON.stringify(missingHosted.issues)
);

console.log("── D. Source guard ──");
for (const file of ["src/pipeline/drafter.ts", "src/pipeline/reply-ai.ts"]) {
  const src = readFileSync(new URL(file, import.meta.url), "utf-8");
  // Prose mentions of the host (the prompt rules that forbid it) are fine —
  // what must never come back is an actual dashboard URL literal.
  check(`${file} no longer builds a dashboard.stripe.com URL`, !/https?:\/\/dashboard\.stripe\.com/i.test(src));
}

console.log("── E. Rotated hosted link self-heal (2026-11-07) ──");

// THE DEFECT: Stripe ROTATES the hosted payment page (same account, NEW page
// token). The 15-minute sync refreshes invoices.hosted_invoice_url, so the
// invoice row moves on while a stored draft keeps the previous token — and the
// reviewer demands THIS invoice's current link, so a perfectly good draft is
// rejected as "missing hosted payment link" (production reminder_task 72,
// merchant 11, $27.00). The repair rewrites the stale token in place.
const HOSTED_OLD = "https://invoice.stripe.com/i/acct_hostedlink/live_oldtoken?s=ap";
const FOREIGN = "https://invoice.stripe.com/i/acct_othermerchant/live_foreign?s=ap";

function goodBody(sid: string, url: string | null): string {
  return (
    `Hi Jenny,\n\nInvoice ${sid} for 27.00 was due on 2026-10-01 and is still open.\n` +
    (url ? `You can pay it here: ${url}\n` : "") +
    `\nBest regards,\nAcme Billing`
  );
}
function insertTask(invoiceId: number, status: string, body: string, subject: string): number {
  const r = db.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, ?, ?)",
    [invoiceId, status, subject, body],
  );
  return Number(r.lastInsertRowid);
}
function taskRow(id: number): { status: string; draft_subject: string; draft_body: string } {
  return db.query("SELECT status, draft_subject, draft_body FROM reminder_tasks WHERE id=?").get(id) as {
    status: string;
    draft_subject: string;
    draft_body: string;
  };
}

// E1 — the pure rewrite: the stale token becomes the current one, and NOTHING
// else in the draft changes.
const staleBody = goodBody("in_HOSTED010", HOSTED_OLD);
const rw = refreshHostedLinkText(staleBody, HOSTED);
check(
  "E1 stale hosted link rewritten to the invoice's current one",
  rw.changed && rw.replaced === 1 && rw.text.includes(HOSTED),
  rw.text
);
check("E1b the draft is otherwise byte-identical", rw.text.replace(HOSTED, HOSTED_OLD) === staleBody, rw.text);
check("E1c the old token is gone", !rw.text.includes(HOSTED_OLD));

// E2 — already current ⇒ no write at all.
const noop = refreshHostedLinkText(goodBody("in_HOSTED010", HOSTED), HOSTED);
check("E2 a draft already carrying the current link is unchanged", noop.changed === false && noop.replaced === 0);

// E3 — a draft with NO link is never given one (C5 must keep rejecting it).
const noLinkBody = goodBody("in_HOSTED010", null);
const noLinkRw = refreshHostedLinkText(noLinkBody, HOSTED);
check("E3 a draft with NO link is not given one", noLinkRw.changed === false && noLinkRw.text === noLinkBody);

// E4 — a link belonging to a DIFFERENT Stripe account is never adopted.
const foreignRw = refreshHostedLinkText(goodBody("in_HOSTED010", FOREIGN), HOSTED);
check("E4 another account's hosted link is left alone", foreignRw.changed === false && foreignRw.text.includes(FOREIGN));

// E5 — no current link on the invoice ⇒ nothing to repair to.
const nullRw = refreshHostedLinkText(staleBody, null);
check("E5 no current link on the invoice ⇒ draft untouched", nullRw.changed === false && nullRw.text === staleBody);

// E6 — the sentence around the URL survives byte for byte.
const punctRw = refreshHostedLinkText(`Pay here: (${HOSTED_OLD}). Thanks!`, HOSTED);
check("E6 surrounding punctuation is preserved", punctRw.text === `Pay here: (${HOSTED}). Thanks!`, punctRw.text);

// E7 — the sweep the invoice-sync pass runs.
const staleInvId = upsertInvoice(db, baseParams("in_HOSTED010", { hosted_invoice_url: HOSTED }));
const staleInv = db.query("SELECT * FROM invoices WHERE id=?").get(staleInvId) as any;
const staleSubject = "Reminder: invoice in_HOSTED010 is overdue";
const staleTaskId = insertTask(staleInvId, "reviewed", staleBody, staleSubject);
const foreignInvId = upsertInvoice(db, baseParams("in_HOSTED011", { hosted_invoice_url: HOSTED }));
const foreignTaskId = insertTask(foreignInvId, "reviewed", goodBody("in_HOSTED011", FOREIGN), "Reminder: invoice in_HOSTED011");
const noLinkInvId = upsertInvoice(db, baseParams("in_HOSTED012", { hosted_invoice_url: HOSTED }));
const noLinkTaskId = insertTask(noLinkInvId, "reviewed", goodBody("in_HOSTED012", null), "Reminder: invoice in_HOSTED012");
const sentInvId = upsertInvoice(db, baseParams("in_HOSTED013", { hosted_invoice_url: HOSTED }));
const sentTaskId = insertTask(sentInvId, "sent", goodBody("in_HOSTED013", HOSTED_OLD), "Reminder: invoice in_HOSTED013");
const dashInvId = upsertInvoice(db, baseParams("in_HOSTED014", { hosted_invoice_url: HOSTED }));
const dashBody = `Hi Jenny,\n\nInvoice in_HOSTED014 for 27.00 was due on 2026-10-01.\nPay here: ${DASHBOARD}in_HOSTED014\n`;
const dashTaskId = insertTask(dashInvId, "reviewed", dashBody, "Reminder: invoice in_HOSTED014");

// E7a — before the repair the gate rejects the stale draft: this IS the bug.
const beforeRepair = reviewDraft({ subject: staleSubject, body: staleBody }, staleInv, { lateFeeText: null });
check(
  "E7a the reviewer rejects the stale draft BEFORE the repair (the production defect)",
  beforeRepair.approved === false && beforeRepair.issues.some((i) => /hosted payment link/i.test(i)),
  JSON.stringify(beforeRepair.issues)
);

const repairedCount = repairStaleHostedLinks(db, merchantId, 1);
check("E7b the sweep repaired exactly the one stale draft", repairedCount === 1, `count=${repairedCount}`);
const repairedRow = taskRow(staleTaskId);
check(
  "E7c the stored body now carries the invoice's CURRENT hosted link",
  repairedRow.draft_body.includes(HOSTED) && !repairedRow.draft_body.includes(HOSTED_OLD),
  repairedRow.draft_body
);
check(
  "E7d the stored body is otherwise byte-identical",
  repairedRow.draft_body.replace(HOSTED, HOSTED_OLD) === staleBody,
  repairedRow.draft_body
);
check("E7e the subject is untouched", repairedRow.draft_subject === staleSubject, repairedRow.draft_subject);
check("E7f the task is still 'reviewed' — nothing was sent", repairedRow.status === "reviewed", repairedRow.status);
const afterRepair = reviewDraft({ subject: repairedRow.draft_subject, body: repairedRow.draft_body }, staleInv, {
  lateFeeText: null,
});
check("E7g the reviewer APPROVES the repaired draft", afterRepair.approved === true, JSON.stringify(afterRepair.issues));

// E8 — idempotent: the second sweep has nothing left to do.
check("E8 a second sweep repairs nothing", repairStaleHostedLinks(db, merchantId, 1) === 0);

// E9 — a draft with NO link stays rejected (C5 behaviour preserved).
const noLinkRow = taskRow(noLinkTaskId);
check("E9 the no-link draft was not rewritten", noLinkRow.draft_body === goodBody("in_HOSTED012", null));
check(
  "E9b the no-link draft is still REJECTED by the reviewer",
  reviewDraft({ subject: noLinkRow.draft_subject, body: noLinkRow.draft_body }, db.query("SELECT * FROM invoices WHERE id=?").get(noLinkInvId) as any, { lateFeeText: null }).approved === false
);

// E10 — another invoice's / another account's hosted link stays rejected.
const foreignRow = taskRow(foreignTaskId);
check("E10 the foreign hosted link was not rewritten", foreignRow.draft_body.includes(FOREIGN), foreignRow.draft_body);
check(
  "E10b the foreign-link draft is still REJECTED by the reviewer",
  reviewDraft({ subject: foreignRow.draft_subject, body: foreignRow.draft_body }, db.query("SELECT * FROM invoices WHERE id=?").get(foreignInvId) as any, { lateFeeText: null }).approved === false
);

// E11 — a SENT task is history: never rewritten.
const sentRow = taskRow(sentTaskId);
check("E11 a sent task keeps its original (stale) body", sentRow.draft_body.includes(HOSTED_OLD), sentRow.draft_body);
check("E11b a sent task stays 'sent'", sentRow.status === "sent", sentRow.status);

// E12 — the dashboard link is never touched, so that hard gate keeps firing.
const dashRow = taskRow(dashTaskId);
check("E12 the dashboard-link draft was not rewritten", dashRow.draft_body === dashBody, dashRow.draft_body);
check(
  "E12b the dashboard-link draft is still REJECTED",
  reviewDraft({ subject: dashRow.draft_subject, body: dashRow.draft_body }, db.query("SELECT * FROM invoices WHERE id=?").get(dashInvId) as any, { lateFeeText: null }).approved === false
);

// E13 — the send path (POST /tasks/:id/approve) repairs one task on its own,
// and refuses to touch a sent one.
const singleInvId = upsertInvoice(db, baseParams("in_HOSTED015", { hosted_invoice_url: HOSTED }));
const singleTaskId = insertTask(singleInvId, "reviewed", goodBody("in_HOSTED015", HOSTED_OLD), "Reminder: invoice in_HOSTED015");
const single = repairTaskHostedLink(db, singleTaskId, HOSTED, () => {});
check("E13 repairTaskHostedLink repairs one stored draft", single === true, `returned=${single}`);
check("E13b the single-task repair used the current link", taskRow(singleTaskId).draft_body.includes(HOSTED));
check("E13c repairTaskHostedLink leaves a sent task alone", repairTaskHostedLink(db, sentTaskId, HOSTED, () => {}) === false);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail === 0 ? 0 : 1);
