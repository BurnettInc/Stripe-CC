/**
 * Merchant settings pack — endpoint + unit tests (sender branding / custom
 * escalation timing / late-fee automation).
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100).
 * The server must share the SQLite DB this script seeds (TEST_DB_PATH,
 * default /tmp/cc-test.db) so the test can create the session + subscription
 * the HTTP calls depend on — sessions have no public creation endpoint.
 * Boot the server WITHOUT provider keys so sends fall to the log-only stub.
 *
 *   DB_PATH=/tmp/cc-test.db PORT=3100 bun run src/index.ts
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-test.db bun run test-settings-pack.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const SESSION = "test-settings-pack-session";

// ── helpers ──

function db(): Database {
  // Bun 1.3.x throws SQLITE_MISUSE with `create: false` — default constructor.
  return new Database(DB_PATH);
}

function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now', '+30 days'))", [SESSION]);
  d.close();
}

function setSubscription(tier: "standard" | "pro" | null): void {
  const d = db();
  const existing = d.query("SELECT id FROM subscriptions WHERE merchant_id=1").get() as { id: number } | null;
  if (existing) {
    if (tier === null) {
      d.run("UPDATE subscriptions SET status='cancelled' WHERE merchant_id=1");
    } else {
      d.run("UPDATE subscriptions SET status='active', tier=? WHERE merchant_id=1", [tier]);
    }
  } else if (tier !== null) {
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (1, 'sub_settings_pack', ?, 'active')", [tier]);
  }
  d.close();
}

/** Direct merchant-row update for the migration-009 settings columns. */
function setMerchant(updates: Record<string, unknown>): void {
  const d = db();
  const sets = Object.keys(updates).map((k) => `${k}=?`).join(", ");
  d.run(`UPDATE merchants SET ${sets} WHERE id=1`, Object.values(updates));
  d.close();
}

function af(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Cookie", `session=${encodeURIComponent(SESSION)}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}

function daysAgoTimestamp(days: number): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return Math.floor(d.getTime() / 1000);
}

async function fireOverdueWebhook(invoiceId: string, daysAgo: number, amountCents = 5000): Promise<{ action: string; invoiceId: number; taskId: number }> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      data: {
        object: {
          id: invoiceId,
          customer_name: "Test Client",
          customer_email: "client@example.com",
          amount_due: amountCents,
          currency: "usd",
          due_date: daysAgoTimestamp(daysAgo),
        },
      },
    }),
  });
  return res.json();
}

async function processTask(taskId: number): Promise<{ status: number; body: any }> {
  const res = await af(`/tasks/${taskId}/process`, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

const results: { name: string; pass: boolean; details: string }[] = [];
function record(name: string, pass: boolean, details = "") {
  results.push({ name, pass, details });
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass && details) console.log(`   FAIL: ${details}`);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${BASE} did not become healthy`);
}

// ── tests ──

const INV_PREFIX = `sps_test_${Date.now()}`;

async function run() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Merchant Settings Pack — endpoint + unit tests");
  console.log(`  BASE=${BASE} DB=${DB_PATH}`);
  console.log("═══════════════════════════════════════════════\n");

  await waitForServer();
  seedSession();

  // ── A1. Unit: buildFromAddress display-name formatting ──
  try {
    const { buildFromAddress, sanitizeDisplayName } = await import("./src/pipeline/sender");
    const withName = buildFromAddress("reminders@x.com", "Acme Co");
    const bare = buildFromAddress("reminders@x.com");
    const emptyName = buildFromAddress("reminders@x.com", "");
    const quoted = sanitizeDisplayName('Weird "Name" Co');
    const pass =
      withName === '"Acme Co" <reminders@x.com>' &&
      bare === "reminders@x.com" &&
      emptyName === "reminders@x.com" &&
      quoted === "Weird Name Co";
    record("A1. buildFromAddress: display name → RFC5322 form; no/empty name → bare email; quotes sanitized", pass,
      pass ? "" : JSON.stringify({ withName, bare, emptyName, quoted }));
  } catch (e: any) {
    record("A1. buildFromAddress unit", false, `Exception: ${e.message}`);
  }

  // ── A2. Standard merchant: PUT branding round-trips through GET ──
  try {
    setSubscription("standard");
    const put = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_name: "Acme Billing", reply_to: "billing@acme.com" }),
    });
    const p = await put.json();
    const get = await af("/settings");
    const g = await get.json();
    const pass =
      put.status === 200 &&
      p.sender_name === "Acme Billing" && p.reply_to === "billing@acme.com" &&
      g.sender_name === "Acme Billing" && g.reply_to === "billing@acme.com" &&
      g.stage1_days === 6 && g.stage2_days === 20 && g.late_fee_type === "none";
    record("A2. Standard PUT sender_name+reply_to → 200; GET round-trips (incl. defaults for new fields)", pass,
      pass ? "" : JSON.stringify({ putStatus: put.status, p, g }));
  } catch (e: any) {
    record("A2. Standard branding round-trip", false, `Exception: ${e.message}`);
  }

  // ── A3. Free merchant: PUT branding → 402; GET still readable ──
  try {
    setSubscription(null);
    const put = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_name: "Free Co" }),
    });
    const get = await af("/settings");
    const g = await get.json();
    const pass =
      put.status === 402 &&
      get.status === 200 && g.sender_name === "Acme Billing"; // still readable
    record("A3. Free merchant: PUT branding → 402; GET still returns saved values", pass,
      pass ? "" : JSON.stringify({ putStatus: put.status, getStatus: get.status, g }));
  } catch (e: any) {
    record("A3. Free branding 402", false, `Exception: ${e.message}`);
  }

  // ── A4. Validation: >80-char name and bad reply-to → 400; empty clears ──
  try {
    setSubscription("standard");
    const tooLong = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_name: "x".repeat(81) }),
    });
    const badReply = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply_to: "not-an-email" }),
    });
    const clear = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_name: "", reply_to: "" }),
    });
    const c = await clear.json();
    const pass =
      tooLong.status === 400 && badReply.status === 400 &&
      clear.status === 200 && c.sender_name === null && c.reply_to === null;
    record("A4. Branding validation: 80-char cap + email check → 400; empty clears to null", pass,
      pass ? "" : JSON.stringify({ tooLong: tooLong.status, badReply: badReply.status, clearStatus: clear.status, c }));
  } catch (e: any) {
    record("A4. Branding validation", false, `Exception: ${e.message}`);
  }

  // ── A5. Reminder send path carries branding (log-only stub) ──
  try {
    setSubscription("standard");
    setMerchant({ sender_name: "Acme Billing", reply_to: "billing@acme.com", drafts_used: 0 });
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "draft" }) });
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_a1`, 3);
    await processTask(wh.taskId);
    const approve = await af(`/tasks/${wh.taskId}/approve`, { method: "POST" });
    const a = await approve.json();

    const d = db();
    const log = d.query(
      "SELECT provider_message FROM send_logs WHERE reminder_task_id=? AND status='success' ORDER BY id DESC LIMIT 1"
    ).get(wh.taskId) as { provider_message: string } | null;
    d.close();

    const msg = log?.provider_message || "";
    const pass =
      approve.status === 200 && a.task.status === "sent" &&
      msg.includes('[STUB SEND]') &&
      msg.includes('From: "Acme Billing" <') &&
      msg.includes("Reply-To: billing@acme.com");
    record("A5. Approve send (log-only) carries From display name + Reply-To", pass,
      pass ? "" : JSON.stringify({ approveStatus: approve.status, taskStatus: a.task?.status, msg }));
  } catch (e: any) {
    record("A5. Approve send branding", false, `Exception: ${e.message}`);
  }

  // ── A6. Auto-send path (semi stage 1) carries branding too ──
  try {
    setSubscription("standard");
    setMerchant({ sender_name: "Auto Brand", reply_to: "auto@acme.com" });
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "semi", paused: false }) });
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_a2`, 2); // stage 1 → semi auto-sends
    const proc = await processTask(wh.taskId);
    const d = db();
    const log = d.query(
      "SELECT provider_message FROM send_logs WHERE reminder_task_id=? AND status='success' ORDER BY id DESC LIMIT 1"
    ).get(wh.taskId) as { provider_message: string } | null;
    d.close();
    const msg = log?.provider_message || "";
    const pass =
      proc.status === 200 && proc.body.task.status === "sent" &&
      msg.includes('From: "Auto Brand" <') && msg.includes("Reply-To: auto@acme.com");
    record("A6. Semi-Auto stage-1 auto-send carries branding", pass,
      pass ? "" : JSON.stringify({ procStatus: proc.status, taskStatus: proc.body.task?.status, msg }));
  } catch (e: any) {
    record("A6. Auto-send branding", false, `Exception: ${e.message}`);
  }

  // ── B1. Unit: getEscalationStage defaults unchanged; custom thresholds shift boundaries ──
  try {
    const { getEscalationStage } = await import("./src/pipeline/escalation");
    const defaults =
      getEscalationStage(6) === 1 && getEscalationStage(7) === 2 &&
      getEscalationStage(20) === 2 && getEscalationStage(21) === 3 &&
      getEscalationStage(0) === 1 && getEscalationStage(-1) === 1;
    const custom =
      getEscalationStage(3, 3, 10) === 1 && getEscalationStage(4, 3, 10) === 2 &&
      getEscalationStage(10, 3, 10) === 2 && getEscalationStage(11, 3, 10) === 3;
    record("B1. getEscalationStage defaults (6/20) unchanged; custom 3/10 shifts boundaries", defaults && custom,
      !defaults || !custom ? `defaults=${defaults} custom=${custom}` : "");
  } catch (e: any) {
    record("B1. getEscalationStage unit", false, `Exception: ${e.message}`);
  }

  // ── B2. Pro merchant: PUT stage1/stage2 round-trips through GET ──
  try {
    setSubscription("pro");
    const put = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage1_days: 3, stage2_days: 10 }),
    });
    const p = await put.json();
    const get = await af("/settings");
    const g = await get.json();
    const pass =
      put.status === 200 && p.stage1_days === 3 && p.stage2_days === 10 &&
      g.stage1_days === 3 && g.stage2_days === 10;
    record("B2. Pro PUT stage1_days=3/stage2_days=10 → 200; GET round-trips", pass,
      pass ? "" : JSON.stringify({ putStatus: put.status, p, g }));
  } catch (e: any) {
    record("B2. Pro timing round-trip", false, `Exception: ${e.message}`);
  }

  // ── B3. Watcher uses merchant thresholds: daysAgo=5 with stage1=3 → stage 2 ──
  try {
    setSubscription("pro");
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage1_days: 3, stage2_days: 10 }) });
    // 5 days overdue: default ladder → stage 1; custom (3/10) → stage 2
    const wh2 = await fireOverdueWebhook(`${INV_PREFIX}_b1`, 5);
    const d = db();
    const s2 = d.query("SELECT stage FROM reminder_tasks WHERE id=?").get(wh2.taskId) as { stage: number } | null;
    d.close();
    // 11 days overdue: default → stage 2; custom → stage 3
    const wh3 = await fireOverdueWebhook(`${INV_PREFIX}_b2`, 11);
    const d2 = db();
    const s3 = d2.query("SELECT stage FROM reminder_tasks WHERE id=?").get(wh3.taskId) as { stage: number } | null;
    d2.close();
    // 2 days overdue: still stage 1 under custom ladder
    const wh1 = await fireOverdueWebhook(`${INV_PREFIX}_b3`, 2);
    const d3 = db();
    const s1 = d3.query("SELECT stage FROM reminder_tasks WHERE id=?").get(wh1.taskId) as { stage: number } | null;
    d3.close();
    const pass = s1?.stage === 1 && s2?.stage === 2 && s3?.stage === 3;
    record("B3. Watcher applies custom boundaries (2d→1, 5d→2, 11d→3)", pass,
      pass ? "" : JSON.stringify({ s1: s1?.stage, s2: s2?.stage, s3: s3?.stage }));
  } catch (e: any) {
    record("B3. Watcher custom boundaries", false, `Exception: ${e.message}`);
  }

  // ── B4. Non-Pro: PUT timing → 402; values still readable via GET ──
  try {
    setSubscription("standard");
    const put = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage1_days: 5, stage2_days: 15 }),
    });
    setSubscription(null);
    const putFree = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage1_days: 5, stage2_days: 15 }),
    });
    const get = await af("/settings");
    const g = await get.json();
    const pass = put.status === 402 && putFree.status === 402 && get.status === 200 && g.stage1_days === 3;
    record("B4. Standard + free: PUT timing → 402; GET still readable", pass,
      pass ? "" : JSON.stringify({ standard: put.status, free: putFree.status, getStatus: get.status, g }));
  } catch (e: any) {
    record("B4. Non-Pro timing 402", false, `Exception: ${e.message}`);
  }

  // ── B5. Validation: non-integer, out-of-range, inverted pair → 400 ──
  try {
    setSubscription("pro");
    const notInt = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage1_days: 2.5, stage2_days: 10 }) });
    const inverted = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage1_days: 10, stage2_days: 5 }) });
    const tooBig = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage1_days: 1, stage2_days: 91 }) });
    const zero = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage1_days: 0, stage2_days: 10 }) });
    const onlyOne = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage1_days: 3 }) });
    const pass = notInt.status === 400 && inverted.status === 400 && tooBig.status === 400 && zero.status === 400 && onlyOne.status === 400;
    record("B5. Timing validation 400s (non-integer, inverted, >90, <1, partial pair)", pass,
      pass ? "" : JSON.stringify({ notInt: notInt.status, inverted: inverted.status, tooBig: tooBig.status, zero: zero.status, onlyOne: onlyOne.status }));
  } catch (e: any) {
    record("B5. Timing validation", false, `Exception: ${e.message}`);
  }

  // ── C1. Pro merchant: PUT late fee (flat) round-trips; validation 400s ──
  try {
    setSubscription("pro");
    const put = await af("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 25 }),
    });
    const p = await put.json();
    const get = await af("/settings");
    const g = await get.json();
    const badType = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_fee_type: "weird", late_fee_value: 5 }) });
    const negVal = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_fee_type: "flat", late_fee_value: -1 }) });
    const pctTooBig = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_fee_type: "percent", late_fee_value: 101 }) });
    const pass =
      put.status === 200 && p.late_fee_type === "flat" && p.late_fee_value === 25 &&
      g.late_fee_type === "flat" && g.late_fee_value === 25 &&
      badType.status === 400 && negVal.status === 400 && pctTooBig.status === 400;
    record("C1. Pro PUT late_fee flat $25 → 200 + GET round-trip; validation 400s", pass,
      pass ? "" : JSON.stringify({ putStatus: put.status, p, g, badType: badType.status, negVal: negVal.status, pctTooBig: pctTooBig.status }));
  } catch (e: any) {
    record("C1. Late fee round-trip", false, `Exception: ${e.message}`);
  }

  // ── C2. Flat fee: stage 2/3 drafts mention it; stage 1 never does ──
  try {
    setSubscription("pro");
    setMerchant({ late_fee_type: "flat", late_fee_value: 25 });
    await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trust_mode: "draft" }) });
    const wh2 = await fireOverdueWebhook(`${INV_PREFIX}_c1`, 10); // stage 2
    const proc2 = await processTask(wh2.taskId);
    const body2: string = proc2.body.draft?.body || "";
    const review2 = proc2.body.review || {};
    const wh3 = await fireOverdueWebhook(`${INV_PREFIX}_c2`, 25); // stage 3
    const proc3 = await processTask(wh3.taskId);
    const body3: string = proc3.body.draft?.body || "";
    const wh1 = await fireOverdueWebhook(`${INV_PREFIX}_c3`, 3); // stage 1
    const proc1 = await processTask(wh1.taskId);
    const body1: string = proc1.body.draft?.body || "";
    const pass =
      proc2.status === 200 && body2.includes("A late fee of $25.00 may apply per your payment terms.") &&
      review2.approved === true &&
      proc3.status === 200 && body3.includes("A late fee of $25.00 may apply per your payment terms.") &&
      proc1.status === 200 && !body1.toLowerCase().includes("late fee");
    record("C2. Flat $25 fee in stage 2+3 drafts (+review passes); absent from stage 1", pass,
      pass ? "" : JSON.stringify({ s2: body2.substring(0, 200), s3: body3.substring(0, 200), s1: body1.substring(0, 200), review2 }));
  } catch (e: any) {
    record("C2. Flat fee in drafts", false, `Exception: ${e.message}`);
  }

  // ── C3. Percent fee math: $1250 invoice, 1.5% → "$18.75 (1.5% of the invoice)" ──
  try {
    setSubscription("pro");
    setMerchant({ late_fee_type: "percent", late_fee_value: 1.5 });
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_c4`, 10, 125000); // $1250.00
    const proc = await processTask(wh.taskId);
    const body: string = proc.body.draft?.body || "";
    const review = proc.body.review || {};
    const pass =
      proc.status === 200 &&
      body.includes("A late fee of $18.75 (1.5% of the invoice) may apply per your payment terms.") &&
      review.approved === true;
    record("C3. Percent fee math: 1.5% of $1250 → '$18.75 (1.5% of the invoice)' + review approves", pass,
      pass ? "" : JSON.stringify({ body: body.substring(0, 300), review }));
  } catch (e: any) {
    record("C3. Percent fee math", false, `Exception: ${e.message}`);
  }

  // ── C4. Reviewer unit: consistent fee text passes; missing fee text fails ──
  try {
    const { reviewDraft } = await import("./src/pipeline/reviewer");
    const { formatLateFeeText, getLateFeeConfig } = await import("./src/pipeline/late-fee");
    const d = db();
    const invoice = d.query("SELECT * FROM invoices WHERE id=(SELECT invoice_id FROM reminder_tasks ORDER BY id DESC LIMIT 1)").get() as any;
    d.close();
    const config = getLateFeeConfig(db(), 1);
    const feeText = formatLateFeeText(config, invoice, 2); // merchant is percent 1.5 now
    const withFee = reviewDraft(
      { subject: "Subject", body: `Invoice ${invoice.stripe_invoice_id} for $1250.00 due ${invoice.due_date}. A late fee of ${feeText} may apply per your payment terms. Pay at https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}` },
      invoice, { lateFeeText: feeText },
    );
    const withoutFee = reviewDraft(
      { subject: "Subject", body: `Invoice ${invoice.stripe_invoice_id} for $1250.00 due ${invoice.due_date}. Pay at https://dashboard.stripe.com/invoices/${invoice.stripe_invoice_id}` },
      invoice, { lateFeeText: feeText },
    );
    const pass =
      feeText === "$18.75 (1.5% of the invoice)" &&
      withFee.approved === true &&
      withoutFee.approved === false &&
      withoutFee.issues.some((i: string) => i.includes("Missing late-fee mention"));
    record("C4. Reviewer: consistent fee text → approved; missing fee text → rejected with issue", pass,
      pass ? "" : JSON.stringify({ feeText, withFee, withoutFee }));
  } catch (e: any) {
    record("C4. Reviewer fee check", false, `Exception: ${e.message}`);
  }

  // ── C5. Non-Pro: PUT late fee → 402; 'none' resets (Pro) and removes from drafts ──
  try {
    setSubscription("standard");
    const putStd = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 10 }) });
    setSubscription(null);
    const putFree = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_fee_type: "flat", late_fee_value: 10 }) });
    setSubscription("pro");
    const reset = await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ late_fee_type: "none" }) });
    const r = await reset.json();
    const wh = await fireOverdueWebhook(`${INV_PREFIX}_c5`, 10); // stage 2 after reset
    const proc = await processTask(wh.taskId);
    const body: string = proc.body.draft?.body || "";
    const pass =
      putStd.status === 402 && putFree.status === 402 &&
      reset.status === 200 && r.late_fee_type === "none" && r.late_fee_value === 0 &&
      !body.toLowerCase().includes("late fee");
    record("C5. Standard/free PUT late fee → 402; 'none' resets and removes fee from drafts", pass,
      pass ? "" : JSON.stringify({ putStd: putStd.status, putFree: putFree.status, r, body: body.substring(0, 200) }));
  } catch (e: any) {
    record("C5. Late fee gating + reset", false, `Exception: ${e.message}`);
  }

  // ── cleanup ──
  setSubscription("pro");
  setMerchant({ sender_name: null, reply_to: null, stage1_days: 6, stage2_days: 20, late_fee_type: "none", late_fee_value: 0, drafts_used: 0 });
  await af("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false, trust_mode: "draft" }) }).catch(() => {});

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
