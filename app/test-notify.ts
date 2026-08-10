/**
 * Stripe Collections Copilot — Merchant Notification Unit Tests
 *
 * Direct unit tests for notifyMerchant() (app/src/pipeline/notify.ts):
 *   1. Real-email merchant → send_logs row with type 'merchant_notification'.
 *   2. Placeholder-email merchants (acct_default / *.local) → skipped, no send,
 *      no crash.
 *   3. Unknown merchant → skipped quietly.
 *
 * The test is self-contained: it points DB_PATH at TEST_DB_PATH and applies
 * schema.sql + migrations idempotently through the app's own getDb(), so no
 * running server is required (WAL allows concurrent access if the isolated
 * test server happens to share the same DB file).
 *
 * Run:  TEST_DB_PATH=/tmp/cc-test.db bun run test-notify.ts
 */

const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-test.db";
process.env.DB_PATH = DB_PATH;

const { getDb } = await import("./src/db");
const db = getDb();
const { notifyMerchant } = await import("./src/pipeline/notify");

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}
const results: TestResult[] = [];

function record(name: string, pass: boolean, details = "") {
  results.push({ name, pass, details });
  const icon = pass ? "✅" : "❌";
  console.log(`${icon} ${name}`);
  if (!pass && details) console.log(`   FAIL: ${details}`);
}

function countNotificationLogs(): number {
  const row = db.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='merchant_notification'").get() as { n: number };
  return row.n;
}

function merchantEmail(merchantId: number): string | null {
  const row = db.query("SELECT email FROM merchants WHERE id=?").get(merchantId) as { email: string } | null;
  return row?.email ?? null;
}

// ── Seed merchants ──
// Merchant 1 (acct_default) is auto-created by ensureDefaultMerchant.
db.run(
  "INSERT OR IGNORE INTO merchants (stripe_account_id, email, trust_mode) VALUES ('acct_notify_real', 'merchant@example.com', 'draft')"
);
const realMerchant = db.query("SELECT id FROM merchants WHERE stripe_account_id='acct_notify_real'").get() as { id: number };
const realId = realMerchant.id;

db.run(
  "INSERT OR IGNORE INTO merchants (stripe_account_id, email, trust_mode) VALUES ('acct_notify_local', 'merchant@collections-copilot.local', 'draft')"
);
const localMerchant = db.query("SELECT id FROM merchants WHERE stripe_account_id='acct_notify_local'").get() as { id: number };
const localId = localMerchant.id;

// ── Test 1: real-email merchant → logged merchant_notification send ──
try {
  const before = countNotificationLogs();
  const result = await notifyMerchant(
    db,
    realId,
    "Payment received",
    "A customer payment was received for invoice INV-123."
  );
  const after = countNotificationLogs();

  const row = db.query(
    "SELECT type, status, provider_message FROM send_logs WHERE type='merchant_notification' ORDER BY id DESC LIMIT 1"
  ).get() as { type: string; status: string; provider_message: string } | null;

  const pass =
    result.success === true &&
    result.skipped !== true &&
    after === before + 1 &&
    row?.type === "merchant_notification" &&
    row.status === "success" &&
    (row.provider_message || "").includes("Payment received") &&
    merchantEmail(realId) === "merchant@example.com";

  record("notifyMerchant: real email → merchant_notification send logged", pass,
    pass ? "" : `result=${JSON.stringify(result)} before=${before} after=${after} row=${JSON.stringify(row)}`);
} catch (e: any) {
  record("notifyMerchant: real email → merchant_notification send logged", false, `Exception: ${e.message}`);
}

// ── Test 2: acct_default (placeholder) → skipped, no send, no crash ──
try {
  const before = countNotificationLogs();
  const result = await notifyMerchant(db, 1, "Dispute filed", "A customer disputed an invoice.");
  const after = countNotificationLogs();

  const pass =
    result.success === false &&
    result.skipped === true &&
    after === before; // no send_logs row written

  record("notifyMerchant: acct_default placeholder → skipped quietly", pass,
    pass ? "" : `result=${JSON.stringify(result)} before=${before} after=${after}`);
} catch (e: any) {
  record("notifyMerchant: acct_default placeholder → skipped quietly", false, `Exception: ${e.message}`);
}

// ── Test 3: *.local placeholder email → skipped, no send, no crash ──
try {
  const before = countNotificationLogs();
  const result = await notifyMerchant(db, localId, "Escalated", "A sequence escalated to stage 2.");
  const after = countNotificationLogs();

  const pass =
    result.success === false &&
    result.skipped === true &&
    after === before;

  record("notifyMerchant: *.local placeholder email → skipped quietly", pass,
    pass ? "" : `result=${JSON.stringify(result)} before=${before} after=${after}`);
} catch (e: any) {
  record("notifyMerchant: *.local placeholder email → skipped quietly", false, `Exception: ${e.message}`);
}

// ── Test 4: unknown merchant → skipped quietly, no crash ──
try {
  const before = countNotificationLogs();
  const result = await notifyMerchant(db, 999999, "Test", "Should never reach a send.");
  const after = countNotificationLogs();

  const pass =
    result.success === false &&
    result.skipped === true &&
    after === before;

  record("notifyMerchant: unknown merchant → skipped quietly", pass,
    pass ? "" : `result=${JSON.stringify(result)} before=${before} after=${after}`);
} catch (e: any) {
  record("notifyMerchant: unknown merchant → skipped quietly", false, `Exception: ${e.message}`);
}

// ── Summary ──
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;

console.log("\n═══════════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log(`  🎉 All ${results.length}/${results.length} notify tests PASSED`);
} else {
  console.log(`  ❌ ${failed} test(s) FAILED`);
  for (const r of results) {
    if (!r.pass) console.log(`     ${r.name} — ${r.details}`);
  }
}
console.log("═══════════════════════════════════════════════");

process.exit(failed === 0 ? 0 : 1);
