/**
 * Sign-off / unfilled-placeholder regression test (2026-11-10).
 *
 * Reproduced live against production, invoice 356: with merchants.sender_name
 * NULL (every merchant but one), the model ended each draft with the literal
 * prompt scaffolding
 *
 *   "Best regards,\n\n[Your Name]\n[Your Business Name]"
 *
 * and the reviewer approved that draft class ({"approved":true,"issues":[]}).
 * With Semi-Auto the default, such a draft auto-sends to the merchant's CUSTOMER.
 *
 * What this test proves:
 *   A. The prompt: the model is given ONE exact sign-off to copy (no name when
 *      the merchant has none, the merchant's name when they do) and is told
 *      never to write a bracketed placeholder.
 *   B. The drafter safety net: a model draft carrying any unfilled bracketed
 *      placeholder is dropped, recorded (reason=unfilled_placeholder) and the
 *      complete template is used instead; a clean model draft passes through.
 *   C. The reviewer hard gate: the exact invoice-356 body is REJECTED, and the
 *      same body with the placeholders replaced is approved. The template
 *      fallback is approved (so the gate cannot block the safe path).
 *
 * Pure/unit test — no server process, no real network (the LLM endpoint is a
 * local Bun.serve stub), no email. Run:
 *   cd app && DB_PATH=/tmp/cc-signoff.db bun run test-signoff-placeholder.ts
 */
import { rmSync } from "node:fs";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-signoff.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.LLM_API_BASE;

const { draftEmail, drafterHealth, resetDrafterHealth } = await import("./src/pipeline/drafter");
const { reviewDraft, unfilledPlaceholderIssue } = await import("./src/pipeline/reviewer");
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

const HOSTED = "https://invoice.stripe.com/i/acct_SIGNOFF/live_signoff001?s=ap";
const db = getDb();
db.run(
  "INSERT INTO merchants (stripe_account_id, email, trust_mode, sender_name) VALUES ('acct_signoff', 'owner@example.com', 'semi', NULL)"
);
const merchantId = Number((db.query("SELECT id FROM merchants WHERE stripe_account_id='acct_signoff'").get() as any).id);

let invoiceSeq = 0;
function makeInvoice(over: Record<string, unknown> = {}): any {
  invoiceSeq++;
  const row: any = {
    stripe_invoice_id: `in_SIGNOFF${String(invoiceSeq).padStart(3, "0")}`,
    merchant_id: merchantId,
    customer_name: "Jenny Rosen",
    customer_email: "jenny@example.com",
    amount_cents: 2700,
    currency: "usd",
    due_date: "2026-10-01",
    hosted_invoice_url: HOSTED,
    ...over,
  };
  db.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, hosted_invoice_url) VALUES (?, ?, ?, ?, ?, ?, ?, 'overdue', ?)",
    [row.stripe_invoice_id, row.merchant_id, row.customer_name, row.customer_email, row.amount_cents, row.currency, row.due_date, row.hosted_invoice_url]
  );
  return db.query("SELECT * FROM invoices WHERE stripe_invoice_id=?").get(row.stripe_invoice_id) as any;
}
function task(inv: any, stage: number): any {
  return { id: 7000 + inv.id * 10 + stage, invoice_id: inv.id, stage, status: "pending", draft_subject: "", draft_body: "" };
}

/** The exact production body from invoice 356 (merchant sender_name NULL). */
const INVOICE_356_BODY = `Hi there,\n\nJust a quick nudge that invoice #in_SIGNOFF001 for $27.00 was due on 2026-10-01.\n\nNo worries if it's already on the way — here's the link if you need it:\n${HOSTED}\n\nBest regards,\n\n[Your Name]\n[Your Business Name]`;

// ── A. The prompt carries the exact sign-off + the no-placeholder rule ──
console.log("── A. Prompt: exact sign-off, no placeholders ──");

type Mode = "ok" | "placeholder";
let mode: Mode = "ok";
let lastSystem = "";
const CLEAN_BODY = `Hi Jenny,\n\nInvoice in_CLEAN for $27.00 was due on 2026-10-01.\n\nPay here: ${HOSTED}\n\nBest regards,`;
const llm = Bun.serve({
  port: 0,
  async fetch(req) {
    const payload = (await req.json()) as { messages?: Array<{ content?: string }> };
    lastSystem = payload.messages?.[0]?.content ?? "";
    const body = mode === "placeholder" ? INVOICE_356_BODY : CLEAN_BODY;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ subject: "Reminder", body }) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },
});
process.env.LLM_API_BASE = `http://127.0.0.1:${llm.port}/v1`;
process.env.OPENAI_API_KEY = "sk-test-signoff-key";

const inv = makeInvoice();
await draftEmail(task(inv, 1), inv, undefined, db);

check("A1 with sender_name NULL the prompt gives the model the exact sign-off", lastSystem.includes("Best regards,"), lastSystem.slice(-900));
check("A2 …and never an empty sign-off slot", !/\{sign_off\}/.test(lastSystem), lastSystem.slice(-900));
check('A3 …and forbids bracketed placeholders by name ("[Your Name]")', lastSystem.includes("[Your Name]") && lastSystem.includes("[Your Business Name]"), lastSystem.slice(-900));
check("A4 …with a rule that the body must end on that sign-off", /SIGN-OFF/.test(lastSystem) && /NEVER write a placeholder/i.test(lastSystem));

db.run("UPDATE merchants SET sender_name='Acme Studio' WHERE id=?", [merchantId]);
const invNamed = makeInvoice();
await draftEmail(task(invNamed, 2), invNamed, undefined, db);
check("A5 with a sender_name set, the exact sign-off names the merchant", /Sign-off[\s\S]{0,200}Acme Studio/.test(lastSystem) || lastSystem.includes("Acme Studio"), lastSystem.slice(-900));
db.run("UPDATE merchants SET sender_name=NULL WHERE id=?", [merchantId]);

// ── B. Drafter safety net ──
console.log("── B. Drafter safety net ──");

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };

mode = "placeholder";
resetDrafterHealth();
const netDraft = await draftEmail(task(inv, 1), inv, undefined, db);
console.warn = realWarn;

check("B1 a model draft with [Your Name] is dropped", !/\[[^\]]+\]/.test(netDraft.body), netDraft.body);
check("B2 …and the template draft is used instead (complete, sendable)", netDraft.body.includes(inv.stripe_invoice_id) && netDraft.body.includes("$27.00") && netDraft.body.includes(HOSTED), netDraft.body);
check("B3 …signed with the neutral sign-off, no name invented", netDraft.body.trim().endsWith("Best regards,"), netDraft.body);
check("B4 …and the fallback is recorded as unfilled_placeholder", drafterHealth().last_fallback?.reason === "unfilled_placeholder", JSON.stringify(drafterHealth().last_fallback));
check("B5 …with one log line naming the reason", warnings.some((w) => w.includes("[drafter] LLM unavailable — using template fallback:") && w.includes("unfilled_placeholder")), warnings.join(" | "));
check("B6 the template draft itself carries no bracketed placeholder", unfilledPlaceholderIssue(netDraft.body) === null, netDraft.body);
check("B7 …and passes the reviewer", reviewDraft(netDraft, inv, { lateFeeText: null }).approved === true, JSON.stringify(reviewDraft(netDraft, inv, { lateFeeText: null }).issues));

mode = "ok";
resetDrafterHealth();
const clean = await draftEmail(task(inv, 1), inv, undefined, db);
check("B8 a clean model draft is still used as-is (no over-blocking)", clean.body === CLEAN_BODY && drafterHealth().status === "ok", clean.body);

// ── C. Reviewer hard gate ──
console.log("── C. Reviewer hard gate ──");

const rejected = reviewDraft({ subject: "Reminder: Invoice #in_SIGNOFF001", body: INVOICE_356_BODY }, inv, { lateFeeText: null });
check("C1 the exact invoice-356 body ([Your Name]) is REJECTED", rejected.approved === false, JSON.stringify(rejected));
check("C2 …with a placeholder issue naming the token", rejected.issues.some((i) => i.includes("Unfilled placeholder") && i.includes("[Your Name]")), JSON.stringify(rejected.issues));

const fixed = reviewDraft(
  { subject: "Reminder: Invoice #in_SIGNOFF001", body: INVOICE_356_BODY.replace(/\n\n\[Your Name\]\n\[Your Business Name\]$/, "\n\nBest regards,") },
  inv,
  { lateFeeText: null }
);
check("C3 the same body with the placeholders removed is approved", fixed.approved === true, JSON.stringify(fixed.issues));

check("C4 [Your Business Name] alone is rejected", reviewDraft({ subject: "Reminder", body: `${INVOICE_356_BODY.replace("[Your Name]\n", "")}` }, inv, { lateFeeText: null }).issues.some((i) => i.includes("[Your Business Name]")));
check("C5 {{name}}-style tokens are rejected too", unfilledPlaceholderIssue("Best regards,\n\n{{sender_name}}") !== null);
check("C6 a plain, bracketed-free sign-off is not flagged", unfilledPlaceholderIssue("Best regards,\n\nAcme Studio") === null);

llm.stop(true);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail === 0 ? 0 : 1);
