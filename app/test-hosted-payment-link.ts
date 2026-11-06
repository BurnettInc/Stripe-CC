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

const { getDb, upsertInvoice, paymentLinkFor } = await import("./src/db");
const { draftEmail } = await import("./src/pipeline/drafter");
const { reviewDraft, merchantDashboardUrlIssue } = await import("./src/pipeline/reviewer");

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
const bareInvId = upsertInvoice(db, baseParams("in_HOSTED003"));
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
    d.body.includes("in_HOSTED003") && d.body.includes("27.00"),
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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail === 0 ? 0 : 1);
