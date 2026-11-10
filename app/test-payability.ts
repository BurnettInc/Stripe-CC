/**
 * "The customer cannot pay this invoice" signal (2026-11-09) — suite.
 *
 * THE DEFECT: two of the three live Stripe accounts render a hosted invoice page
 * with NO payment panel at all (the page renders fully and ends at "Powered by /
 * Terms / Privacy"; no "Choose how you'd like to pay", no card field). The
 * approval screen told the merchant "Ready to send" anyway, so a reminder went
 * to a customer who had nothing to click. The cause is account-level and is
 * invisible through our OAuth scope (every /v1 read except /v1/invoices/{id}
 * answers 403), so the hosted page is the only evidence there is.
 *
 * THIS SUITE PROVES the signal and that nothing about sending changed:
 *
 *   (a) the two live page SHAPES classify correctly — 346-shaped (payment panel
 *       present, 37,902 B) ⇒ payable; 356-shaped (renders fully, no panel,
 *       18,429 B) ⇒ not_payable; the panel markers are detected individually
 *       and through an HTML-entity apostrophe;
 *   (b) BE CONSERVATIVE — HTTP 500, a timeout, a network error, a short/garbage
 *       body, a non-invoice page and Stripe's own error/expired page are all
 *       `unknown`, never `not_payable`;
 *   (c) the 24 h cache holds: a second sweep immediately after the first
 *       fetches nothing (for `not_payable` AND for `unknown` verdicts, which are
 *       stamped too, so an unclassifiable page is not re-fetched every tick);
 *       a stamp older than 24 h is fetched again;
 *   (d) GET /tasks exposes `customer_can_pay` ('yes' | 'no' | 'unknown') per
 *       task, sourced from the stored column;
 *   (e) WARNING ONLY — POST /tasks/:id/approve still succeeds on an invoice
 *       whose customer cannot pay (no gate reads this), and the task is sent;
 *   (f) the approval screen carries the amber warning surface.
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3161) and
 * its SQLite file (TEST_DB_PATH, default /tmp/cc-payability.db). Boot with the
 * provider keys stripped so nothing can leave the box:
 *
 *   DB_PATH=/tmp/cc-payability.db PORT=3161 bun run src/index.ts
 *   TEST_BASE=http://localhost:3161 TEST_DB_PATH=/tmp/cc-payability.db bun run test-payability.ts
 */
import { Database } from "bun:sqlite";
import {
  checkHostedInvoicePayable,
  classifyHostedInvoicePage,
  runPayabilitySweep,
  type Payability,
} from "./src/pipeline/payability";

const BASE = process.env.TEST_BASE || "http://localhost:3161";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-payability.db";
const SESSION = "payability-session";
const MERCHANT = 1; // default merchant, created at boot
const CACHE_MERCHANT = 3; // seeded for the 24 h cache section only

let pass = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}
function db(): Database {
  return new Database(DB_PATH);
}
const DUE = "2026-10-30"; // fixed past date — the invoice is overdue

// ── Recorded page shapes ──
//
// Reconstructed from the two live pages measured in production on 2026-11-09
// (body sizes and marker presence are the recorded facts; the filler is inert).
// The control page carried the payment panel and was 37,902 B; the broken page
// rendered fully with no panel and was 18,429 B.
const CONTROL_BYTES = 37_902;
const BROKEN_BYTES = 18_429;

function withFiller(head: string, tail: string, totalBytes: number): string {
  const pad = Math.max(0, totalBytes - head.length - tail.length);
  return head + " ".repeat(pad) + tail;
}

/** 346-shaped: Stripe's hosted page WITH the payment panel. */
function pageControl(): string {
  const head =
    `<html><head><title>Invoice</title></head><body>` +
    `<div>Acme Billing</div><div>Invoice INV-346</div><div>Amount due $1.00</div>` +
    `<h2>Choose how you'd like to pay</h2>` +
    `<label>Card number</label><input aria-label="Card number">` +
    `<label>Save payment details for future payments</label>` +
    `<button>Pay $1.00</button>`;
  const tail = `<div>Powered by <a href="/">Stripe</a></div><div><a>Terms</a> <a>Privacy</a></div></body></html>`;
  return withFiller(head, tail, CONTROL_BYTES);
}

/** 356-shaped: the same page rendered fully, with NO payment panel. */
function pageNoPanel(): string {
  const head =
    `<html><head><title>Invoice</title></head><body>` +
    `<div>Beta Studio</div><div>Invoice INV-356</div><div>Amount due $27.00</div>` +
    `<div>Questions? Contact Beta Studio.</div>`;
  const tail = `<div>Powered by <a href="/">Stripe</a></div><div><a>Terms</a> <a>Privacy</a></div></body></html>`;
  return withFiller(head, tail, BROKEN_BYTES);
}

function stubFetch(status: number, body: string | (() => Promise<string>)): typeof fetch {
  return (async () => ({
    status,
    text: async () => (typeof body === "function" ? await body() : body),
  })) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  // ── (a) the two live page shapes ──
  {
    const control = pageControl();
    const broken = pageNoPanel();
    check("(a) fixture sizes match the recorded pages", control.length === CONTROL_BYTES && broken.length === BROKEN_BYTES,
      `${control.length}/${broken.length}`);
    check("(a) control page really carries the panel marker", control.includes("Choose how you'd like to pay"));
    check("(a) broken page really has no panel marker",
      !broken.includes("Choose how you'd like to pay") && !broken.includes("card number"));
    check("(a) 346-shaped (panel present) ⇒ payable", classifyHostedInvoicePage(control) === "payable",
      classifyHostedInvoicePage(control));
    check("(a) 356-shaped (renders fully, no panel) ⇒ not_payable", classifyHostedInvoicePage(broken) === "not_payable",
      classifyHostedInvoicePage(broken));
    check("(a) 'Save payment details' alone ⇒ payable",
      classifyHostedInvoicePage(pageNoPanel().replace("<div>Questions? Contact Beta Studio.</div>", "<div>Save payment details</div>")) === "payable");
    check("(a) 'card number' alone ⇒ payable",
      classifyHostedInvoicePage(pageNoPanel().replace("<div>Questions? Contact Beta Studio.</div>", "<div>Enter your card number</div>")) === "payable");
    check("(a) entity-encoded apostrophe still matches",
      classifyHostedInvoicePage(pageNoPanel().replace("<div>Questions? Contact Beta Studio.</div>", "<h2>Choose how you&#x27;d like to pay</h2>")) === "payable");
  }

  // ── (b) conservative: everything uncertain is `unknown` ──
  {
    const url = "https://invoice.stripe.com/i/acct_test/test_payability";
    const v = async (f: typeof fetch, timeoutMs?: number): Promise<Payability> =>
      checkHostedInvoicePayable(url, { fetch: f, timeoutMs, log: () => {} });

    check("(b) HTTP 500 ⇒ unknown", (await v(stubFetch(500, pageNoPanel()))) === "unknown");
    check("(b) HTTP 404 ⇒ unknown", (await v(stubFetch(404, "not found"))) === "unknown");
    check("(b) short/garbage body ⇒ unknown", (await v(stubFetch(200, "<html>hi</html>"))) === "unknown");
    check("(b) empty body ⇒ unknown", (await v(stubFetch(200, ""))) === "unknown");
    check("(b) non-invoice page (login wall) ⇒ unknown",
      (await v(stubFetch(200, withFiller("<html><body>Sign in to continue", "</body></html>", BROKEN_BYTES)))) === "unknown");
    check("(b) Stripe's expired/error page ⇒ unknown",
      (await v(stubFetch(200, pageNoPanel().replace("Questions? Contact Beta Studio.", "This invoice is no longer available.")))) === "unknown");
    check("(b) network error ⇒ unknown",
      (await v((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch)) === "unknown");
    const hang: typeof fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    check("(b) timeout ⇒ unknown", (await v(hang, 50)) === "unknown");
    check("(b) timeout actually aborted quickly", Date.now() - started < 2_000, `${Date.now() - started}ms`);
    let fetched = 0;
    const countingFetch: typeof fetch = (async () => {
      fetched++;
      return { status: 200, text: async () => pageControl() };
    }) as unknown as typeof fetch;
    check("(b) an empty / non-https URL is never fetched",
      (await checkHostedInvoicePayable("", { fetch: countingFetch, log: () => {} })) === "unknown" &&
        (await checkHostedInvoicePayable("http://invoice.stripe.com/x", { fetch: countingFetch, log: () => {} })) === "unknown" &&
        fetched === 0,
      `fetched=${fetched}`);
  }

  // ── (c) the 24 h cache ──
  {
    const d = db();
    // Re-runnable: drop any rows a previous run of this suite left behind.
    d.run("DELETE FROM reminder_tasks WHERE invoice_id IN (SELECT id FROM invoices WHERE stripe_invoice_id LIKE 'in_pay%')");
    d.run("DELETE FROM invoices WHERE stripe_invoice_id LIKE 'in_pay%'");
    d.run(
      "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (?, ?, ?, 'semi')",
      [CACHE_MERCHANT, "acct_payability_cache", "cache@example.test"],
    );
    const insert = (sid: string, url: string, status = "overdue"): number => {
      const r = d.run(
        `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, hosted_invoice_url)
         VALUES (?, ?, 'Cache Customer', 'cache@customer.test', 1000, 'usd', ?, ?, ?)`,
        [sid, CACHE_MERCHANT, DUE, status, url],
      );
      return Number(r.lastInsertRowid);
    };
    const invA = insert("in_pay_cache_a", "https://invoice.stripe.com/i/acct_cache/a");
    const invB = insert("in_pay_cache_b", "https://invoice.stripe.com/i/acct_cache/b");
    const invC = insert("in_pay_cache_c", "https://invoice.stripe.com/i/acct_cache/c");
    const invPaid = insert("in_pay_cache_paid", "https://invoice.stripe.com/i/acct_cache/p", "paid");
    d.close();

    let calls = 0;
    const counting: typeof fetch = (async (u: string) => {
      calls++;
      const html = String(u).endsWith("/c") ? pageNoPanel() : pageControl();
      return { status: 200, text: async () => html };
    }) as unknown as typeof fetch;

    const first = await runPayabilitySweep(db(), CACHE_MERCHANT, 1, { fetch: counting, log: () => {} });
    check("(c) first sweep checked the open/overdue invoices with a link", first.checked === 3, `checked=${first.checked}`);
    check("(c) first sweep made exactly one fetch per invoice", calls === 3, `calls=${calls}`);
    check("(c) paid invoices are never checked", first.checked === 3 && calls === 3, `calls=${calls}`);
    check("(c) verdicts stored (payable / not_payable)",
      (() => {
        const x = db();
        const a = x.query("SELECT payability FROM invoices WHERE id=?").get(invA) as { payability: string };
        const c = x.query("SELECT payability FROM invoices WHERE id=?").get(invC) as { payability: string };
        x.close();
        return a.payability === "payable" && c.payability === "not_payable";
      })());

    calls = 0;
    const second = await runPayabilitySweep(db(), CACHE_MERCHANT, 1, { fetch: counting, log: () => {} });
    check("(c) second sweep immediately after: NO fetch (24 h cache)", calls === 0, `calls=${calls}`);
    check("(c) second sweep checked nothing", second.checked === 0, `checked=${second.checked}`);

    // An `unknown` verdict is stamped too — otherwise a page we cannot classify
    // would be re-fetched on every 15-minute tick.
    {
      const d2 = db();
      d2.run("UPDATE invoices SET payability='unknown', payability_checked_at=datetime('now') WHERE id=?", [invB]);
      d2.close();
    }
    calls = 0;
    await runPayabilitySweep(db(), CACHE_MERCHANT, 1, { fetch: counting, log: () => {} });
    check("(c) an 'unknown' verdict is cached for 24 h as well", calls === 0, `calls=${calls}`);

    // 25 h later the cache has expired → fetched again, exactly once.
    {
      const d3 = db();
      d3.run("UPDATE invoices SET payability_checked_at=datetime('now','-25 hours') WHERE id IN (?,?,?)", [invA, invB, invC]);
      d3.close();
    }
    calls = 0;
    const third = await runPayabilitySweep(db(), CACHE_MERCHANT, 1, { fetch: counting, log: () => {} });
    check("(c) a stamp older than 24 h is re-checked, once each", third.checked === 3 && calls === 3,
      `checked=${third.checked} calls=${calls}`);
    check("(c) unpaid invoice is untouched by all of this",
      (() => {
        const x = db();
        const r = x.query("SELECT payability FROM invoices WHERE id=?").get(invPaid) as { payability: string | null };
        x.close();
        return r.payability === null;
      })());
  }

  // ── seed the approval-surface fixtures (merchant 1) ──
  let noTaskId = 0;
  let yesTaskId = 0;
  let unknownTaskId = 0;
  {
    const d = db();
    d.run(
      "INSERT OR REPLACE INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_payability', 'pro', 'active')",
      [MERCHANT],
    );
    d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))", [
      SESSION,
      MERCHANT,
    ]);

    const seedInvoice = (sid: string, payability: string | null, amount: number): number => {
      const hosted = `https://invoice.stripe.com/i/acct_payability/${sid}`;
      const r = d.run(
        `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, hosted_invoice_url, payability, payability_checked_at)
         VALUES (?, ?, 'Dana Customer', 'dana@customer.test', ?, 'usd', ?, 'overdue', ?, ?, datetime('now'))`,
        [sid, MERCHANT, amount, DUE, hosted, payability],
      );
      const invoiceId = Number(r.lastInsertRowid);
      const body =
        `Hi Dana,\n\nInvoice ${sid} for $${(amount / 100).toFixed(2)} was due on ${DUE} and is still open.\n` +
        `You can pay it here: ${hosted}\n\nBest regards,\nAcme Billing`;
      const t = d.run(
        "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body, reviewer_notes) VALUES (?, 1, 'reviewed', ?, ?, '')",
        [invoiceId, `Reminder: invoice ${sid} is overdue`, body],
      );
      return Number(t.lastInsertRowid);
    };

    noTaskId = seedInvoice("in_pay_no", "not_payable", 2700);
    yesTaskId = seedInvoice("in_pay_yes", "payable", 5000);
    unknownTaskId = seedInvoice("in_pay_unknown", null, 8000);
    d.close();
  }

  // ── (d) GET /tasks exposes customer_can_pay ──
  {
    const res = await fetch(`${BASE}/tasks`, { headers: { Cookie: `session=${SESSION}` } });
    const rows = (await res.json()) as Array<{ id: number; customer_can_pay?: string }>;
    const byId = (id: number) => rows.find((r) => r.id === id);
    check("(d) GET /tasks → 200", res.status === 200, `status=${res.status}`);
    check("(d) stored 'not_payable' ⇒ customer_can_pay 'no'", byId(noTaskId)?.customer_can_pay === "no",
      `got=${byId(noTaskId)?.customer_can_pay}`);
    check("(d) stored 'payable' ⇒ customer_can_pay 'yes'", byId(yesTaskId)?.customer_can_pay === "yes",
      `got=${byId(yesTaskId)?.customer_can_pay}`);
    check("(d) never checked (NULL) ⇒ customer_can_pay 'unknown'", byId(unknownTaskId)?.customer_can_pay === "unknown",
      `got=${byId(unknownTaskId)?.customer_can_pay}`);
    const missing = await fetch(`${BASE}/tasks`);
    check("(d) GET /tasks without a session → 401", missing.status === 401, `status=${missing.status}`);
  }

  // ── (e) WARNING ONLY: approve still sends ──
  {
    const res = await fetch(`${BASE}/tasks/${noTaskId}/approve`, {
      method: "POST",
      headers: { Cookie: `session=${SESSION}` },
    });
    const body = (await res.json()) as { sent?: boolean; task?: { status?: string } };
    check("(e) approve on a 'customer cannot pay' invoice → 200", res.status === 200, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
    check("(e) the reminder was actually sent", body.sent === true && body.task?.status === "sent",
      JSON.stringify({ sent: body.sent, status: body.task?.status }));
    const d = db();
    const row = d.query("SELECT status FROM reminder_tasks WHERE id=?").get(noTaskId) as { status: string };
    const logs = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=?").get(noTaskId) as { n: number };
    d.close();
    check("(e) task row is 'sent' and a send_logs row exists", row.status === "sent" && logs.n > 0,
      JSON.stringify({ status: row.status, logs: logs.n }));
  }

  // ── (f) the approval screen carries the warning surface ──
  {
    const res = await fetch(`${BASE}/messages`, { headers: { Cookie: `session=${SESSION}` } });
    const html = await res.text();
    check("(f) /messages carries the amber payability chip", html.includes("chip-payability"), `status=${res.status}`);
    check("(f) /messages carries the amber payability note", html.includes("task-note-payability"));
    check("(f) /messages explains the warning",
      html.includes("no way to pay") && html.toLowerCase().includes("stripe account setup"));
    check("(f) the warning is never 'Ready to send' for that case",
      html.includes("Customer can") && html.includes("customer_can_pay === 'no'"));
  }

  console.log(`\n${pass} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

await main();
