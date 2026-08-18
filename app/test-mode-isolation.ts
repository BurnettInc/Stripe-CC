/**
 * Reviewer fix #5 — Live/Test mode isolation (ZERO-BLEED) endpoint suite.
 *
 * Stripe's reviewer: "when opened from the Stripe Dashboard app drawer, the
 * app fetches records without isolating by mode, combining Live and Test
 * invoices/customers in one view."
 *
 * This suite seeds ONE merchant with BOTH a live invoice (livemode=1) and a
 * test invoice (livemode=0), then asserts over HTTP that the drawer-facing
 * endpoints (/overdue/summary, /tasks/pause|resume, /invoices/:id,
 * /invoices/:id/trust-mode) return / act on ONLY the active mode's rows:
 *
 *   (a) 401 without a session;
 *   (b) /overdue/summary with X-Stripe-Mode: live -> ONLY the live invoice;
 *   (c) /overdue/summary with X-Stripe-Mode: test -> ONLY the test invoice;
 *   (d) /overdue/summary with NO header -> live (web-dashboard default,
 *       unchanged);
 *   (e) POST /tasks/pause on the LIVE invoice sent with mode=test -> 404 and
 *       the live row's manually_paused_at stays NULL (not touched);
 *   (f) POST /tasks/pause on the TEST invoice sent with mode=live -> 404 and
 *       the test row stays untouched;
 *   (g) positive control: POST /tasks/pause on the live invoice with
 *       mode=live -> 200 and the live row IS paused;
 *   (h) POST /tasks/resume with mode=live clears the live pause (positive);
 *   (i) /invoices/:id zero bleed: live id with mode=test -> 404, with
 *       mode=live -> 200 (and vice versa for the test id);
 *   (j) trust-mode GET/PUT zero bleed: PUT on the live invoice with
 *       mode=test -> 404 and the DB override unchanged; PUT with mode=live
 *       -> 200 and the DB override IS set.
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-mode-isolation.db),
 * like every other suite. The server MUST be booted with the provider keys
 * stripped (log-only mode — see /tmp/run-suite.sh mode-isolation).
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-mode-isolation.db bun run test-mode-isolation.ts
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-mode-isolation.db";
const SESSION = "mode-isolation-session";
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}
function invoiceRow(invoiceId: number): Record<string, unknown> {
  const d = db();
  const row = d.query("SELECT * FROM invoices WHERE id=?").get(invoiceId) as Record<string, unknown> | undefined;
  d.close();
  return row ?? {};
}
const authHeaders = { "Content-Type": "application/json", Cookie: `session=${SESSION}` };
/** fetch with an explicit X-Stripe-Mode (omitted when mode is null). */
async function af(path: string, init: RequestInit = {}, mode: "live" | "test" | null = null): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders, ...(init.headers as Record<string, string> | undefined) };
  if (mode !== null) headers["X-Stripe-Mode"] = mode;
  return fetch(`${BASE}${path}`, { ...init, headers });
}
/** Seed session + active Pro subscription + one LIVE + one TEST invoice. */
function seed(): { liveId: number; testId: number } {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.run(
    "INSERT OR REPLACE INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (1, 'sub_modeiso', 'pro', 'active')",
  );
  const due = new Date(Date.now() - 5 * 86400e3).toISOString();
  const live = d.run(
    `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency,
                           due_date, status, livemode)
     VALUES ('in_live_1', 1, 'Live Customer', 'live@customer.com', 10000, 'usd', ?, 'overdue', 1)`,
    [due],
  );
  const test = d.run(
    `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency,
                           due_date, status, livemode)
     VALUES ('in_test_1', 1, 'Test Customer', 'test@customer.com', 20000, 'usd', ?, 'overdue', 0)`,
    [due],
  );
  d.close();
  return { liveId: Number(live.lastInsertRowid), testId: Number(test.lastInsertRowid) };
}
function summaryInvoiceIds(payload: { invoices?: Array<{ id: number; stripe_invoice_id: string; customer_name: string }> }): string[] {
  return (payload.invoices ?? []).map((i) => i.stripe_invoice_id);
}
async function main(): Promise<void> {
  // ── (a) Auth: 401 without session ──
  {
    const noSession = await fetch(`${BASE}/overdue/summary`, { headers: { "X-Stripe-Mode": "live" } });
    check("(a) /overdue/summary without session → 401", noSession.status === 401, `status=${noSession.status}`);
  }
  const { liveId, testId } = seed();
  // ── (b)/(c)/(d) /overdue/summary zero bleed ──
  {
    const live = await af("/overdue/summary", {}, "live");
    const livePayload = (await live.json()) as { counts: { total: number }; invoices: Array<{ id: number; stripe_invoice_id: string; customer_name: string }> };
    const liveIds = summaryInvoiceIds(livePayload);
    check("(b) mode=live summary → 200", live.status === 200, `status=${live.status}`);
    check("(b) mode=live summary → ONLY live invoice", liveIds.length === 1 && liveIds.includes("in_live_1"), `ids=${liveIds.join(",")}`);
    check("(b) mode=live summary → counts.total == 1", livePayload.counts.total === 1, `total=${livePayload.counts.total}`);
    check("(b) mode=live summary → live row is 'Live Customer'", livePayload.invoices[0]?.customer_name === "Live Customer",
      `name=${livePayload.invoices[0]?.customer_name}`);
    const test = await af("/overdue/summary", {}, "test");
    const testPayload = (await test.json()) as { counts: { total: number }; invoices: Array<{ id: number; stripe_invoice_id: string; customer_name: string }> };
    const testIds = summaryInvoiceIds(testPayload);
    check("(c) mode=test summary → 200", test.status === 200, `status=${test.status}`);
    check("(c) mode=test summary → ONLY test invoice", testIds.length === 1 && testIds.includes("in_test_1"), `ids=${testIds.join(",")}`);
    check("(c) mode=test summary → counts.total == 1", testPayload.counts.total === 1, `total=${testPayload.counts.total}`);
    check("(c) mode=test summary → test row is 'Test Customer'", testPayload.invoices[0]?.customer_name === "Test Customer",
      `name=${testPayload.invoices[0]?.customer_name}`);
    const noHeader = await af("/overdue/summary", {}, null);
    const noHeaderPayload = (await noHeader.json()) as { invoices: Array<{ stripe_invoice_id: string }> };
    check("(d) no-header summary → defaults to LIVE only", summaryInvoiceIds(noHeaderPayload).join(",") === "in_live_1",
      `ids=${summaryInvoiceIds(noHeaderPayload).join(",")}`);
  }
  // ── (e)/(f) pause zero bleed ──
  {
    const crossLive = await af("/tasks/pause", { method: "POST", body: JSON.stringify({ invoice_id: liveId }) }, "test");
    check("(e) pause LIVE invoice with mode=test → 404", crossLive.status === 404, `status=${crossLive.status}`);
    check("(e) live invoice NOT paused (manually_paused_at null)", invoiceRow(liveId).manually_paused_at === null,
      `paused_at=${invoiceRow(liveId).manually_paused_at}`);
    const crossTest = await af("/tasks/pause", { method: "POST", body: JSON.stringify({ invoice_id: testId }) }, "live");
    check("(f) pause TEST invoice with mode=live → 404", crossTest.status === 404, `status=${crossTest.status}`);
    check("(f) test invoice NOT paused (manually_paused_at null)", invoiceRow(testId).manually_paused_at === null,
      `paused_at=${invoiceRow(testId).manually_paused_at}`);
  }
  // ── (g) positive control: same-mode pause works ──
  {
    const ok = await af("/tasks/pause", { method: "POST", body: JSON.stringify({ invoice_id: liveId }) }, "live");
    const body = (await ok.json()) as { ok?: boolean };
    check("(g) pause LIVE invoice with mode=live → 200 ok", ok.status === 200 && body.ok === true, `status=${ok.status} body=${JSON.stringify(body)}`);
    check("(g) live invoice IS paused", invoiceRow(liveId).manually_paused_at !== null, `paused_at=${invoiceRow(liveId).manually_paused_at}`);
    // ── (h) resume positive control (mode-scoped too) ──
    const crossResume = await af("/tasks/resume", { method: "POST", body: JSON.stringify({ invoice_id: liveId }) }, "test");
    check("(h) resume LIVE invoice with mode=test → 404", crossResume.status === 404, `status=${crossResume.status}`);
    check("(h) live invoice STILL paused after mode=test resume", invoiceRow(liveId).manually_paused_at !== null,
      `paused_at=${invoiceRow(liveId).manually_paused_at}`);
    const resume = await af("/tasks/resume", { method: "POST", body: JSON.stringify({ invoice_id: liveId }) }, "live");
    const resumeBody = (await resume.json()) as { cleared?: string[] };
    check("(h) resume LIVE invoice with mode=live → 200 cleared manual", resume.status === 200 && (resumeBody.cleared ?? []).includes("manual"),
      `status=${resume.status} cleared=${JSON.stringify(resumeBody.cleared)}`);
    check("(h) live invoice unpaused after mode=live resume", invoiceRow(liveId).manually_paused_at === null,
      `paused_at=${invoiceRow(liveId).manually_paused_at}`);
  }
  // ── (i) /invoices/:id zero bleed ──
  {
    const liveWrong = await af(`/invoices/${liveId}`, {}, "test");
    check("(i) GET live id with mode=test → 404", liveWrong.status === 404, `status=${liveWrong.status}`);
    const liveRight = await af(`/invoices/${liveId}`, {}, "live");
    const livePayload = (await liveRight.json()) as { stripe_invoice_id: string; livemode?: number };
    check("(i) GET live id with mode=live → 200 + live row", liveRight.status === 200 && livePayload.stripe_invoice_id === "in_live_1",
      `status=${liveRight.status} sid=${livePayload.stripe_invoice_id}`);
    const testWrong = await af(`/invoices/${testId}`, {}, "live");
    check("(i) GET test id with mode=live → 404", testWrong.status === 404, `status=${testWrong.status}`);
    const testRight = await af(`/invoices/${testId}`, {}, "test");
    const testPayload = (await testRight.json()) as { stripe_invoice_id: string };
    check("(i) GET test id with mode=test → 200 + test row", testRight.status === 200 && testPayload.stripe_invoice_id === "in_test_1",
      `status=${testRight.status} sid=${testPayload.stripe_invoice_id}`);
    // stripe_invoice_id lookup is mode-scoped too
    const sidLiveWrong = await af("/invoices/in_live_1", {}, "test");
    check("(i) GET live stripe_invoice_id with mode=test → 404", sidLiveWrong.status === 404, `status=${sidLiveWrong.status}`);
    const sidNoHeader = await af(`/invoices/${liveId}`, {}, null);
    check("(i) no-header GET defaults to LIVE", sidNoHeader.status === 200, `status=${sidNoHeader.status}`);
  }
  // ── (j) trust-mode zero bleed ──
  {
    const getWrong = await af(`/invoices/${liveId}/trust-mode`, {}, "test");
    check("(j) GET trust-mode of live invoice with mode=test → 404", getWrong.status === 404, `status=${getWrong.status}`);
    const putWrong = await af(`/invoices/${liveId}/trust-mode`, {
      method: "PUT",
      body: JSON.stringify({ trust_mode: "full" }),
    }, "test");
    check("(j) PUT trust-mode of live invoice with mode=test → 404", putWrong.status === 404, `status=${putWrong.status}`);
    check("(j) live trust_mode_override unchanged", invoiceRow(liveId).trust_mode_override === null,
      `override=${invoiceRow(liveId).trust_mode_override}`);
    const putRight = await af(`/invoices/${liveId}/trust-mode`, {
      method: "PUT",
      body: JSON.stringify({ trust_mode: "full" }),
    }, "live");
    check("(j) PUT trust-mode of live invoice with mode=live → 200", putRight.status === 200, `status=${putRight.status}`);
    check("(j) live trust_mode_override IS set to full", invoiceRow(liveId).trust_mode_override === "full",
      `override=${invoiceRow(liveId).trust_mode_override}`);
    const putTestRight = await af(`/invoices/${testId}/trust-mode`, {
      method: "PUT",
      body: JSON.stringify({ trust_mode: "draft" }),
    }, "test");
    check("(j) PUT trust-mode of test invoice with mode=test → 200", putTestRight.status === 200, `status=${putTestRight.status}`);
    check("(j) test trust_mode_override IS set to draft", invoiceRow(testId).trust_mode_override === "draft",
      `override=${invoiceRow(testId).trust_mode_override}`);
  }
  // ── summary ──
  console.log(failures === 0 ? "ALL PASS" : `RESULTS: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}
await main();
