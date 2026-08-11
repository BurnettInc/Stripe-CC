/**
 * Free-draft counter derivation tests.
 *
 * The dashboard's "Free Drafts: X of 5" counter (GET /stats →
 * free_drafts_remaining) is DERIVED from reality — the count of the
 * merchant's reminder_tasks that carry a draft (joined through their
 * invoice) — not from the legacy merchants.drafts_used column, which is no
 * longer written or read. This suite proves that:
 *   - a pre-existing drafted task counts even when drafts_used is 0 (the
 *     reported bug: the counter stayed "5 of 5" because pre-counter drafts
 *     were never tallied)
 *   - a pending task with no draft does not count
 *   - a second drafted task drops the counter further
 *   - sent / cancelled tasks that carry a draft still count (rev-23
 *     semantics: the allowance is consumed at draft time, once per task,
 *     lifetime)
 *   - the drafts_used column value is ignored entirely
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default app/app.db). Run via:
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-free-drafts.db bun run test-free-drafts.ts
 *
 * (or /tmp/run-suite.sh free-drafts, which boots an isolated server with a
 * fresh DB and stripped email-provider keys).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const SESSION = "test-free-drafts-session";
const MERCHANT = 2; // dedicated merchant — the derived count starts at exactly zero

function db(): Database {
  // NOTE: Bun 1.3.x throws SQLITE_MISUSE when the options object contains
  // `create: false` — use the default constructor (create: true is harmless,
  // the file already exists because the server created it).
  return new Database(DB_PATH);
}
function seedMerchant(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, drafts_used) VALUES (?, 'acct_free_drafts', 'free@example.com', 'draft', 0)",
    [MERCHANT]
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [SESSION, MERCHANT]);
  d.close();
}
function insertTask(stripeInvoiceId: string, status: string, draftBody: string): void {
  const d = db();
  d.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, amount_cents, due_date, status) VALUES (?, ?, 'Derived Client', 2500, datetime('now'), 'overdue')",
    [stripeInvoiceId, MERCHANT]
  );
  const inv = d.query("SELECT id FROM invoices WHERE stripe_invoice_id=?").get(stripeInvoiceId) as { id: number };
  d.run(
    "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, ?, 'Derived', ?)",
    [inv.id, status, draftBody]
  );
  d.close();
}
function draftCount(): number {
  const d = db();
  const row = d.query(
    "SELECT COUNT(*) AS n FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=? AND rt.draft_body != ''"
  ).get(MERCHANT) as { n: number };
  d.close();
  return row.n;
}
function columnDraftsUsed(): number {
  const d = db();
  const row = d.query("SELECT drafts_used FROM merchants WHERE id=?").get(MERCHANT) as { drafts_used: number };
  d.close();
  return row.drafts_used;
}
async function af(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Cookie", `session=${encodeURIComponent(SESSION)}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}
async function freeDrafts(): Promise<number> {
  const res = await af("/stats");
  if (res.status !== 200) throw new Error(`GET /stats returned ${res.status}`);
  const s = (await res.json()) as { free_drafts_remaining: number };
  return s.free_drafts_remaining;
}
async function statsJson(): Promise<{ free_drafts_remaining: number; free_drafts_unlimited: boolean }> {
  const res = await af("/stats");
  if (res.status !== 200) throw new Error(`GET /stats returned ${res.status}`);
  return (await res.json()) as { free_drafts_remaining: number; free_drafts_unlimited: boolean };
}

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

async function run(): Promise<void> {
  seedMerchant();
  // 1. drafts_used=0 + one pre-existing drafted task → 4 of 5 remaining.
  //    (The reported bug: the E2E task's draft was never counted because it
  //    predated the counter — the derived count picks it up immediately.)
  insertTask("fd_001", "reviewed", "Draft one");
  let fd = await freeDrafts();
  record("1. pre-existing drafted task counts with drafts_used=0 → 4 of 5",
    fd === 4 && draftCount() === 1 && columnDraftsUsed() === 0,
    `freeDrafts=${fd} drafts=${draftCount()} column=${columnDraftsUsed()}`);
  // 2. pending task with no draft does not count.
  insertTask("fd_002", "pending", "");
  fd = await freeDrafts();
  record("2. pending task with no draft does not count → still 4 of 5",
    fd === 4 && draftCount() === 1,
    `freeDrafts=${fd} drafts=${draftCount()}`);
  // 3. a second drafted task (sent) drops it to 3 of 5.
  insertTask("fd_003", "sent", "Draft three");
  fd = await freeDrafts();
  record("3. second drafted task (sent) → 3 of 5",
    fd === 3 && draftCount() === 2,
    `freeDrafts=${fd} drafts=${draftCount()}`);
  // 4. cancelled task that carries a draft still counts (rev-23 semantics).
  insertTask("fd_004", "cancelled", "Draft four");
  fd = await freeDrafts();
  record("4. cancelled task with draft still counts → 2 of 5",
    fd === 2 && draftCount() === 3,
    `freeDrafts=${fd} drafts=${draftCount()}`);
  // 5. the drafts_used column is ignored: set it to 5, counter unchanged.
  db().run("UPDATE merchants SET drafts_used=5 WHERE id=?", [MERCHANT]);
  fd = await freeDrafts();
  record("5. drafts_used column ignored (set to 5) → still 2 of 5",
    fd === 2 && columnDraftsUsed() === 5,
    `freeDrafts=${fd} column=${columnDraftsUsed()}`);
  // 6. clearing a draft frees the allowance (the count reads reality).
  db().run(
    "UPDATE reminder_tasks SET draft_body='', draft_subject='' WHERE invoice_id=(SELECT id FROM invoices WHERE stripe_invoice_id='fd_003')"
  );
  fd = await freeDrafts();
  record("6. cleared draft no longer counts → 3 of 5",
    fd === 3 && draftCount() === 2,
    `freeDrafts=${fd} drafts=${draftCount()}`);
  // 7. Paid merchant (active Standard): the 5-draft cap does not apply — /stats
  //    must flag free_drafts_unlimited so the dashboard renders "Unlimited"
  //    instead of a misleading countdown. (The reported bug: the countdown was
  //    computed for EVERYONE, including paid merchants.)
  db().run(
    "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_paid_test', 'standard', 'active')",
    [MERCHANT]
  );
  let stats = await statsJson();
  record("7. active Standard subscriber → free_drafts_unlimited=true",
    stats.free_drafts_unlimited === true,
    `free_drafts_unlimited=${stats.free_drafts_unlimited}`);
  // 8. Cancelled subscription → back to the free countdown (still 3 of 5).
  db().run(
    "UPDATE subscriptions SET status='cancelled' WHERE stripe_subscription_id='sub_paid_test'"
  );
  stats = await statsJson();
  fd = await freeDrafts();
  record("8. cancelled subscription → free_drafts_unlimited=false, countdown resumes",
    stats.free_drafts_unlimited === false && fd === 3,
    `free_drafts_unlimited=${stats.free_drafts_unlimited} freeDrafts=${fd}`);
  // 9. Active Pro subscriber → unlimited too (Standard OR Pro active).
  db().run(
    "UPDATE subscriptions SET status='active', tier='pro' WHERE stripe_subscription_id='sub_paid_test'"
  );
  stats = await statsJson();
  record("9. active Pro subscriber → free_drafts_unlimited=true",
    stats.free_drafts_unlimited === true,
    `free_drafts_unlimited=${stats.free_drafts_unlimited}`);
  // Cleanup: remove the test subscription so the merchant is free again.
  db().run("DELETE FROM subscriptions WHERE stripe_subscription_id='sub_paid_test'");

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n═══════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════");
  process.exit(failed === 0 ? 0 : 1);
}
run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
