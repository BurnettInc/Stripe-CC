/**
 * Drafter fallback visibility + template copy test (2026-11-06).
 *
 * Background (verified in production): the OpenAI account behind
 * OPENAI_API_KEY had no credits, so every chat/completions call returned
 * HTTP 429 `insufficient_quota` / `credit_balance_exhausted`. `draftEmail()`
 * swallowed it (`if (!response.ok) return fallbackDraft;` + a bare try/catch),
 * so the product emailed the plain template while looking perfectly healthy —
 * nothing in the logs said the AI was off.
 *
 * What this test proves:
 *   A. formatAmount / usableName — the two copy defects.
 *      A1 USD renders "$27.00" (was a bare "27.00" with no currency at all).
 *      A2 a currency we have no symbol for renders "27.00 SEK" — no guessed
 *         symbol.
 *      A3 EUR/GBP symbols render in front of the amount.
 *      A4/A5 an email address (and "Customer", and "") is never a usable name.
 *   B. The template fallback (the copy every customer receives while AI
 *      drafting is off):
 *      B1 carries "$27.00" and the invoice number + hosted payment link.
 *      B2 signs with merchants.sender_name when it is set.
 *      B3 with sender_name NULL signs "Best regards," and NEVER the merchant's
 *         email address (production merchant 11).
 *      B4 a customer_name that is an EMAIL ADDRESS → "Hi there," and the
 *         address appears nowhere in the body.
 *      B5 an empty customer_name → "Hi there," (stage 1 and stage 2).
 *      B6 still passes the reviewer's hard gates.
 *      B7 no hosted link ⇒ no URL at all (never the merchant dashboard).
 *   C. A failed LLM call logs the reason and still returns a sendable draft:
 *      C1 HTTP 429 insufficient_quota → template draft returned, one structured
 *         console line carrying status/type/code, never the API key.
 *      C2 the same failure is visible through drafterHealth() (status
 *         "degraded", http_status 429, reason credit_balance_exhausted).
 *      C3 a successful call flips it back to "ok".
 *      C4 unparseable / incomplete / dashboard-link model output each fall back
 *         with their own recorded reason.
 *      C5 a 5xx with a non-JSON body records status=500 (no invented type).
 *   D. The admin surface exposes it: GET /admin/data carries `drafting`, and the
 *      admin page renders the "AI drafting is OFF" banner from it.
 *
 * Pure/unit test — no server process, no network (the LLM endpoint is a local
 * Bun.serve stub), no email. Run:
 *   cd app && DB_PATH=/tmp/cc-drafter-health.db bun run test-drafter-health.ts
 */
import { rmSync } from "node:fs";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/cc-drafter-health.db";
rmSync(process.env.DB_PATH, { force: true });
rmSync(`${process.env.DB_PATH}-wal`, { force: true });
rmSync(`${process.env.DB_PATH}-shm`, { force: true });
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.LLM_API_BASE;
// Set BEFORE admin.ts is imported: ADMIN_TOKEN is read at module load.
process.env.ADMIN_TOKEN = "test-admin-token-drafter";

const { draftEmail, drafterHealth, resetDrafterHealth, formatAmount, usableName } = await import("./src/pipeline/drafter");
const { reviewDraft } = await import("./src/pipeline/reviewer");
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

/** Collect console.warn lines so a test can assert on what the drafter logged. */
let warnings: string[] = [];
const realWarn = console.warn;
function captureWarnings(): void {
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };
}
function releaseWarnings(): void { console.warn = realWarn; }

const HOSTED = "https://invoice.stripe.com/i/acct_TESTDRAFTER/live_testdrafter001?s=ap";

// ── Fixtures ──
const db = getDb();
db.run(
  "INSERT INTO merchants (stripe_account_id, email, trust_mode, sender_name) VALUES ('acct_drafter', 'owner@example.com', 'semi', NULL)"
);
const merchantId = Number((db.query("SELECT id FROM merchants WHERE stripe_account_id='acct_drafter'").get() as any).id);

let invoiceSeq = 0;
/** Insert an invoice row and return it, so draftEmail() runs against real DB state. */
function makeInvoice(over: Record<string, unknown> = {}): any {
  invoiceSeq++;
  const row = {
    stripe_invoice_id: `in_DRAFTER${String(invoiceSeq).padStart(3, "0")}`,
    // Stripe's CUSTOMER-FACING invoice number — the only number reminder copy
    // may quote (the internal id above must never reach a customer).
    invoice_number: `INV-${String(invoiceSeq).padStart(4, "0")}`,
    merchant_id: merchantId,
    customer_name: "Jenny Rosen",
    customer_email: "jenny@example.com",
    amount_cents: 2700,
    currency: "usd",
    due_date: "2026-10-01",
    status: "overdue",
    hosted_invoice_url: HOSTED,
    ...over,
  };
  db.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, hosted_invoice_url, invoice_number) VALUES (?, ?, ?, ?, ?, ?, ?, 'overdue', ?, ?)",
    [row.stripe_invoice_id, row.merchant_id, row.customer_name, row.customer_email, row.amount_cents, row.currency, row.due_date, row.hosted_invoice_url, row.invoice_number]
  );
  return db.query("SELECT * FROM invoices WHERE stripe_invoice_id=?").get(row.stripe_invoice_id) as any;
}

function task(inv: any, stage: number): any {
  return { id: 5000 + inv.id * 10 + stage, invoice_id: inv.id, stage, status: "pending", draft_subject: "", draft_body: "" };
}

// ── A. Copy helpers ──
console.log("── A. Amount formatting + usable names ──");

check('A1 USD renders "$27.00" (not a bare "27.00")', formatAmount(2700, "usd") === "$27.00", formatAmount(2700, "usd"));
check("A2 a currency with no known symbol renders '27.00 SEK' (no guessed symbol)", formatAmount(2700, "sek") === "27.00 SEK", formatAmount(2700, "sek"));
check('A3 EUR renders "€27.00"', formatAmount(2700, "eur") === "€27.00", formatAmount(2700, "eur"));
check('A3b GBP renders "£27.00"', formatAmount(2700, "gbp") === "£27.00", formatAmount(2700, "gbp"));
check("A3c currency code is case-insensitive", formatAmount(2700, "USD") === "$27.00", formatAmount(2700, "USD"));
check("A3d no currency at all still renders the amount", formatAmount(2700, null) === "27.00", formatAmount(2700, null));
check("A4 an EMAIL ADDRESS is never a usable name", usableName("jenny@example.com") === null);
check('A4b "Customer" is not a usable name', usableName("Customer") === null);
check("A4c empty/whitespace is not a usable name", usableName("   ") === null && usableName(null) === null);
check("A5 a real name passes through", usableName("  Jenny Rosen ") === "Jenny Rosen");

// ── B. Template fallback copy ──
console.log("── B. Template fallback (AI drafting off) ──");
captureWarnings();

const invUsd = makeInvoice();
const stage1 = await draftEmail(task(invUsd, 1), invUsd, undefined, db);
check('B1 stage-1 fallback carries "$27.00"', stage1.body.includes("$27.00"), stage1.body);
check("B1b the body no longer says 'for 27.00' with no currency", !/\bfor 27\.00\b/.test(stage1.body), stage1.body);
check("B1c the body names the CUSTOMER-FACING invoice number", stage1.body.includes(invUsd.invoice_number), stage1.body);
check("B1c2 …and never Stripe's internal id", !stage1.body.includes(invUsd.stripe_invoice_id), stage1.body);
check("B1c3 the subject carries the invoice number, not the internal id", stage1.subject.includes(invUsd.invoice_number) && !stage1.subject.includes(invUsd.stripe_invoice_id), stage1.subject);
check("B1d the body carries the invoice's hosted payment link", stage1.body.includes(HOSTED), stage1.body);

const invSek = makeInvoice({ currency: "sek" });
const sekDraft = await draftEmail(task(invSek, 2), invSek, undefined, db);
check("B1e a currency with no symbol renders '27.00 SEK'", sekDraft.body.includes("27.00 SEK"), sekDraft.body);

// sender_name set → signed with it.
db.run("UPDATE merchants SET sender_name='Acme Studio' WHERE id=?", [merchantId]);
const invNamed = makeInvoice();
const namedDraft = await draftEmail(task(invNamed, 2), invNamed, undefined, db);
check("B2 sender_name set → the sign-off uses that name", namedDraft.body.includes("Acme Studio"), namedDraft.body);
check("B2b sender_name set → no neutral 'Best regards,' fallback", !namedDraft.body.includes("Best regards,"), namedDraft.body);

// sender_name NULL → neutral sign-off, never the merchant's email address.
db.run("UPDATE merchants SET sender_name=NULL WHERE id=?", [merchantId]);
const invNoName = makeInvoice();
const noNameDraft = await draftEmail(task(invNoName, 2), invNoName, undefined, db);
check("B3 sender_name NULL → ends with a neutral 'Best regards,'", noNameDraft.body.trimEnd().endsWith("Best regards,"), noNameDraft.body);
check("B3b sender_name NULL → the body does NOT contain the merchant's email address", !noNameDraft.body.includes("owner@example.com"), noNameDraft.body);
const hintEmailDraft = await draftEmail(task(invNoName, 3), invNoName, "owner@example.com", db);
check("B3c an email passed as a name hint is refused (never signed with an address)", !hintEmailDraft.body.includes("owner@example.com"), hintEmailDraft.body);
check("B3d …and that draft still ends with 'Best regards,'", hintEmailDraft.body.trimEnd().endsWith("Best regards,"), hintEmailDraft.body);

// customer_name that is an email address.
const invEmailName = makeInvoice({ customer_name: "jenny@example.com" });
const emailNameDraft = await draftEmail(task(invEmailName, 2), invEmailName, undefined, db);
check("B4 customer_name that is an EMAIL ADDRESS → opens 'Hi there,'", emailNameDraft.body.startsWith("Hi there,"), emailNameDraft.body);
check("B4b the customer's email address appears nowhere in the body", !emailNameDraft.body.includes("jenny@example.com"), emailNameDraft.body);
const emailNameStage1 = await draftEmail(task(invEmailName, 1), invEmailName, undefined, db);
check("B4c stage 1 with an email customer_name also opens 'Hi there,'", emailNameStage1.body.startsWith("Hi there,"), emailNameStage1.body);

// customer_name empty.
const invNoNameCust = makeInvoice({ customer_name: "" });
const noCustDraft = await draftEmail(task(invNoNameCust, 2), invNoNameCust, undefined, db);
check("B5 empty customer_name → opens 'Hi there,'", noCustDraft.body.startsWith("Hi there,"), noCustDraft.body);
const noCustStage1 = await draftEmail(task(invNoNameCust, 1), invNoNameCust, undefined, db);
check("B5b stage 1 with an empty customer_name opens 'Hi there,'", noCustStage1.body.startsWith("Hi there,"), noCustStage1.body);
const namedStage1 = await draftEmail(task(invUsd, 1), invUsd, undefined, db);
check("B5c a real customer_name is still addressed by name", namedStage1.body.startsWith("Hey Jenny Rosen"), namedStage1.body);

// The gates must still pass on the new copy.
for (const stage of [1, 2, 3]) {
  const inv = makeInvoice();
  const d = await draftEmail(task(inv, stage), inv, undefined, db);
  const r = reviewDraft(d, inv, { lateFeeText: null });
  check(`B6 stage ${stage} fallback still passes the reviewer's hard gates`, r.approved === true, JSON.stringify(r.issues));
}

// No hosted link → no URL at all.
const invNoLink = makeInvoice({ hosted_invoice_url: null });
const noLinkDraft = await draftEmail(task(invNoLink, 2), invNoLink, undefined, db);
check("B7 no hosted link → no URL in the body", !/https?:\/\//i.test(noLinkDraft.body), noLinkDraft.body);
check("B7b no hosted link → never dashboard.stripe.com", !/dashboard\.stripe\.com/i.test(noLinkDraft.body), noLinkDraft.body);
check("B7c no hosted link → still names the invoice and the amount", noLinkDraft.body.includes(invNoLink.invoice_number) && noLinkDraft.body.includes("$27.00"), noLinkDraft.body);

// Stripe assigns invoice.number at FINALIZATION, so an invoice can legitimately
// have none yet: the copy then OMITS the number entirely — it must never fall
// back to the internal id (the defect this change exists for).
const invNoNumber = makeInvoice({ invoice_number: null });
const noNumberDraft = await draftEmail(task(invNoNumber, 1), invNoNumber, undefined, db);
check(
  "B7d no invoice number yet → the copy omits it and never prints the internal id",
  !noNumberDraft.subject.includes(invNoNumber.stripe_invoice_id) &&
    !noNumberDraft.body.includes(invNoNumber.stripe_invoice_id) &&
    noNumberDraft.body.includes("your invoice") &&
    noNumberDraft.body.includes("$27.00"),
  `${noNumberDraft.subject} | ${noNumberDraft.body}`
);

// The no-key path is recorded too (that IS "AI drafting is off").
check(
  "B8 an unset OPENAI_API_KEY is logged as a fallback reason",
  warnings.some((w) => w.includes("[drafter] LLM unavailable — using template fallback:") && w.includes("no_api_key")),
  warnings.join(" | ")
);
check("B8b …and reported by drafterHealth() as degraded", drafterHealth().status === "degraded" && drafterHealth().key_configured === false, JSON.stringify(drafterHealth()));

// ── C. A failed LLM call logs why, and still returns a draft ──
console.log("── C. LLM failure logging ──");

type Mode = "quota" | "ok" | "dashboard" | "garbage" | "html500";
let mode: Mode = "quota";
const MODEL_BODY = `Hi Jenny,\n\nInvoice in_MODEL for $27.00 was due on 2026-10-01.\n\nYou can pay here: ${HOSTED}\n\nThanks!`;
const llm = Bun.serve({
  port: 0,
  fetch() {
    if (mode === "quota") {
      return new Response(
        JSON.stringify({
          error: { message: "You have no credits remaining. Please check your plan and billing details.", type: "insufficient_quota", code: "credit_balance_exhausted" },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    if (mode === "html500") return new Response("<html>502 bad gateway</html>", { status: 500 });
    const content =
      mode === "garbage"
        ? "Sure! Here is your email: (not json)"
        : mode === "dashboard"
          ? JSON.stringify({ subject: "Reminder", body: `Pay at https://dashboard.stripe.com/invoices/${HOSTED}` })
          : JSON.stringify({ subject: "Model subject", body: MODEL_BODY });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  },
});
process.env.LLM_API_BASE = `http://127.0.0.1:${llm.port}/v1`;
const TEST_KEY = "sk-test-drafter-health-key";
process.env.OPENAI_API_KEY = TEST_KEY;

resetDrafterHealth();
captureWarnings();
const invLLM = makeInvoice();
const failed = await draftEmail(task(invLLM, 2), invLLM, undefined, db);
releaseWarnings();

check("C1 a 429 still returns a draft (drafting never throws, sending never blocks)", typeof failed.body === "string" && failed.body.length > 40, failed.body);
check("C1b the returned draft is the template, complete and sendable", failed.body.includes(invLLM.invoice_number) && failed.body.includes("$27.00") && failed.body.includes(HOSTED), failed.body);
check("C1c the fallback draft passes the reviewer", reviewDraft(failed, invLLM, { lateFeeText: null }).approved === true, JSON.stringify(reviewDraft(failed, invLLM, { lateFeeText: null }).issues));

const failureLine = warnings.find((w) => w.startsWith("[drafter] LLM unavailable — using template fallback:"));
check("C2 one structured log line is emitted for the failure", warnings.length === 1 && Boolean(failureLine), warnings.join(" | "));
check("C2b the log line carries the HTTP status", Boolean(failureLine && failureLine.includes("status=429")), failureLine ?? "");
check("C2c the log line carries the error type", Boolean(failureLine && failureLine.includes("type=insufficient_quota")), failureLine ?? "");
check("C2d the log line carries the error code", Boolean(failureLine && failureLine.includes("code=credit_balance_exhausted")), failureLine ?? "");
check("C2e the log line never contains the API key", !warnings.some((w) => w.includes(TEST_KEY)), warnings.join(" | "));

const healthDegraded = drafterHealth();
check("C3 drafterHealth() reports degraded after the failure", healthDegraded.status === "degraded", JSON.stringify(healthDegraded));
check("C3b …with the HTTP status recorded", healthDegraded.last_fallback?.http_status === 429, JSON.stringify(healthDegraded.last_fallback));
check("C3c …with the provider error code as the reason", healthDegraded.last_fallback?.reason === "credit_balance_exhausted", JSON.stringify(healthDegraded.last_fallback));
check("C3d …and the counters", healthDegraded.fallbacks_total === 1 && healthDegraded.consecutive_fallbacks === 1 && healthDegraded.successes_total === 0, JSON.stringify(healthDegraded));

// A successful call flips it back to ok.
mode = "ok";
const okDraft = await draftEmail(task(invLLM, 2), invLLM, undefined, db);
check("C4 a successful model call returns the model's draft", okDraft.body === MODEL_BODY, okDraft.body);
check("C4b drafterHealth() flips back to ok", drafterHealth().status === "ok", JSON.stringify(drafterHealth()));
check("C4c …and clears the consecutive-fallback count", drafterHealth().consecutive_fallbacks === 0 && drafterHealth().successes_total === 1, JSON.stringify(drafterHealth()));

// Each degraded model output has its own recorded reason.
mode = "dashboard";
captureWarnings();
const dashboardDraft = await draftEmail(task(invLLM, 2), invLLM, undefined, db);
releaseWarnings();
check("C5 a model draft carrying dashboard.stripe.com is dropped with its own reason", drafterHealth().last_fallback?.reason === "merchant_dashboard_link", JSON.stringify(drafterHealth().last_fallback));
check("C5b …and the template was used instead", !/dashboard\.stripe\.com/i.test(dashboardDraft.body) && dashboardDraft.body.includes(invLLM.invoice_number), dashboardDraft.body);

mode = "garbage";
captureWarnings();
await draftEmail(task(invLLM, 2), invLLM, undefined, db);
releaseWarnings();
check("C6 unparseable model output records reason=unparseable_response", drafterHealth().last_fallback?.reason === "unparseable_response", JSON.stringify(drafterHealth().last_fallback));

mode = "html500";
captureWarnings();
await draftEmail(task(invLLM, 2), invLLM, undefined, db);
releaseWarnings();
check("C7 a 5xx with a non-JSON body records status=500", drafterHealth().last_fallback?.http_status === 500, JSON.stringify(drafterHealth().last_fallback));
check("C7b …and invents no error type", drafterHealth().last_fallback?.reason === "http_500", JSON.stringify(drafterHealth().last_fallback));

// ── D. The admin surface exposes it ──
console.log("── D. Admin surface ──");
mode = "quota";
captureWarnings();
await draftEmail(task(invLLM, 2), invLLM, undefined, db);
releaseWarnings();

const { handleAdminData } = await import("./src/routes/admin");
const adminRes = await handleAdminData(db, new Request("http://localhost/admin/data?token=test-admin-token-drafter"));
const adminData = await adminRes.json() as any;
check("D1 GET /admin/data still answers 200", adminRes.status === 200, String(adminRes.status));
check("D2 …and carries a `drafting` health record", Boolean(adminData.drafting) && typeof adminData.drafting.status === "string", JSON.stringify(adminData.drafting));
check("D3 …which reports the current degraded state", adminData.drafting.status === "degraded", JSON.stringify(adminData.drafting));
check("D4 …including the last failure detail", String(adminData.drafting.last_fallback?.detail ?? "").includes("insufficient_quota"), JSON.stringify(adminData.drafting.last_fallback));
check("D5 …and a tracking_since anchor so a restart is visible", typeof adminData.drafting.tracking_since === "string" && adminData.drafting.tracking_since.length > 10, JSON.stringify(adminData.drafting.tracking_since));

const adminHtml = await Bun.file(new URL("./src/ui/admin.html", import.meta.url)).text();
check("D6 the admin page renders the drafting banner", adminHtml.includes('id="draftingBanner"') && adminHtml.includes("function renderDrafting(") && adminHtml.includes("renderDrafting(d);"));
check("D7 …and says plainly that AI drafting is off", adminHtml.includes("AI drafting is OFF"));

llm.stop(true);
releaseWarnings();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail === 0 ? 0 : 1);
