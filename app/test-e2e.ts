/**
 * Stripe Collections Copilot — End-to-End Test Suite
 *
 * Runs 10 test sequences against the running server on port 3001.
 * Uses unique invoice IDs per test to avoid collisions.
 * Resets trust_mode to 'full' at the end.
 */

const BASE = "http://localhost:3001";

// Helpers
function daysAgoTimestamp(days: number): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return Math.floor(d.getTime() / 1000);
}

function daysAgoDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

async function setTrustMode(mode: "draft" | "semi" | "full"): Promise<void> {
  const res = await fetch(`${BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trust_mode: mode }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set trust_mode=${mode}: ${res.status} ${await res.text()}`);
  }
}

async function fireOverdueWebhook(invoiceId: string, daysAgo: number, opts: {
  customerName?: string;
  customerEmail?: string;
  amountCents?: number;
  currency?: string;
} = {}): Promise<{ action: string; invoiceId: number; taskId: number }> {
  const ts = daysAgoTimestamp(daysAgo);
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.overdue",
      data: {
        object: {
          id: invoiceId,
          customer_name: opts.customerName || "Test Client",
          customer_email: opts.customerEmail || "client@example.com",
          amount_due: opts.amountCents ?? 5000,
          currency: opts.currency || "usd",
          due_date: ts,
        },
      },
    }),
  });
  return res.json();
}

async function firePaidWebhook(invoiceId: string): Promise<{ action: string }> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
        },
      },
    }),
  });
  return res.json();
}

async function processTask(taskId: number): Promise<any> {
  const res = await fetch(`${BASE}/tasks/${taskId}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function getSummary(merchantId = 1): Promise<any> {
  const res = await fetch(`${BASE}/summary?merchantId=${merchantId}`);
  return res.json();
}

interface TestResult {
  seq: number;
  name: string;
  pass: boolean;
  details: string;
}

const results: TestResult[] = [];

function record(seq: number, name: string, pass: boolean, details: string) {
  results.push({ seq, name, pass, details });
  const icon = pass ? "✅" : "❌";
  console.log(`${icon} Sequence ${seq}: ${name}`);
  if (!pass) console.log(`   FAIL: ${details}`);
}

async function run() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Stripe Collections Copilot — E2E Test Suite");
  console.log("═══════════════════════════════════════════════\n");

  const INV_PREFIX = `e2e_test_${Date.now()}`;

  // ────────────────────────────────────────────────────
  // Sequence 1: Stage 1 — Friendly reminder
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    const invId = `${INV_PREFIX}_seq1`;
    const wh = await fireOverdueWebhook(invId, 3); // 3 days ago → stage 1
    const taskId = wh.taskId;

    const proc = await processTask(taskId);
    const t = proc.body.task;
    const pass =
      proc.status === 200 &&
      t.stage === 1 &&
      t.draft_subject.includes("Quick reminder") &&
      t.reviewer_notes &&
      JSON.parse(t.reviewer_notes).approved === true &&
      t.status === "sent";

    record(1, "Stage 1 — Friendly reminder", pass,
      pass ? "" : `taskId=${taskId} stage=${t.stage} subject="${t.draft_subject}" status=${t.status} reviewer=${t.reviewer_notes}`);
  } catch (e: any) {
    record(1, "Stage 1 — Friendly reminder", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 2: Stage 2 — Firmer follow-up
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    const invId = `${INV_PREFIX}_seq2`;
    const wh = await fireOverdueWebhook(invId, 10); // 10 days ago → stage 2
    const taskId = wh.taskId;

    const proc = await processTask(taskId);
    const t = proc.body.task;
    const pass =
      proc.status === 200 &&
      t.stage === 2 &&
      t.draft_subject.includes("Following up") &&
      JSON.parse(t.reviewer_notes).approved === true &&
      t.status === "sent";

    record(2, "Stage 2 — Firmer follow-up", pass,
      pass ? "" : `stage=${t.stage} subject="${t.draft_subject}" status=${t.status}`);
  } catch (e: any) {
    record(2, "Stage 2 — Firmer follow-up", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 3: Stage 3 — Final notice
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    const invId = `${INV_PREFIX}_seq3`;
    const wh = await fireOverdueWebhook(invId, 25); // 25 days ago → stage 3
    const taskId = wh.taskId;

    const proc = await processTask(taskId);
    const t = proc.body.task;
    const pass =
      proc.status === 200 &&
      t.stage === 3 &&
      t.draft_subject.includes("Final notice") &&
      JSON.parse(t.reviewer_notes).approved === true &&
      t.status === "sent";

    record(3, "Stage 3 — Final notice", pass,
      pass ? "" : `stage=${t.stage} subject="${t.draft_subject}" status=${t.status}`);
  } catch (e: any) {
    record(3, "Stage 3 — Final notice", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 4: Payment stops the sequence
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    const invId = `${INV_PREFIX}_seq4`;
    // Create overdue invoice
    const wh = await fireOverdueWebhook(invId, 3);
    const taskId = wh.taskId;

    // Fire invoice.paid for same invoice
    const paidResult = await firePaidWebhook(invId);

    // Check task status is cancelled
    const tasksRes = await fetch(`${BASE}/tasks`);
    const tasks = await tasksRes.json();
    const task = tasks.find((t: any) => t.id === taskId);

    const pass1 = task && task.status === "cancelled";

    // Try processing — should fail
    const procTry = await processTask(taskId);

    const pass2 = procTry.status === 400 &&
      (procTry.body.error?.includes("already paid") ||
       procTry.body.error?.includes("Task already processed"));

    const pass = pass1 && pass2;
    const details = !pass
      ? `taskStatus=${task?.status} procStatus=${procTry.status} procError=${JSON.stringify(procTry.body)}`
      : "";

    record(4, "Payment stops the sequence", pass, details);
  } catch (e: any) {
    record(4, "Payment stops the sequence", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 5: Trust Mode — Draft
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("draft");
    const invId = `${INV_PREFIX}_seq5`;
    const wh = await fireOverdueWebhook(invId, 5);
    const taskId = wh.taskId;

    const proc = await processTask(taskId);
    const t = proc.body.task;
    const message = proc.body.message || "";
    const pass =
      proc.status === 200 &&
      t.status === "reviewed" &&
      message.toLowerCase().includes("awaiting merchant approval");

    record(5, "Trust Mode — Draft", pass,
      pass ? "" : `status=${t.status} message="${message}"`);
  } catch (e: any) {
    record(5, "Trust Mode — Draft", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 6: Trust Mode — Semi-Auto, Stage 1
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("semi");
    const invId = `${INV_PREFIX}_seq6`;
    const wh = await fireOverdueWebhook(invId, 3); // stage 1
    const taskId = wh.taskId;

    const proc = await processTask(taskId);
    const t = proc.body.task;
    const pass =
      proc.status === 200 &&
      t.status === "sent" &&  // semi auto-sends stage 1
      t.draft_subject.includes("Quick reminder");

    record(6, "Trust Mode — Semi-Auto, Stage 1", pass,
      pass ? "" : `status=${t.status} stage=${t.stage} trustMode=${proc.body.trustMode}`);
  } catch (e: any) {
    record(6, "Trust Mode — Semi-Auto, Stage 1", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 7: Trust Mode — Semi-Auto, Stage 2+
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("semi");
    const invId = `${INV_PREFIX}_seq7`;
    const wh = await fireOverdueWebhook(invId, 25); // stage 3
    const taskId = wh.taskId;

    const proc = await processTask(taskId);
    const t = proc.body.task;
    const message = proc.body.message || "";
    const pass =
      proc.status === 200 &&
      t.status === "reviewed" &&
      message.toLowerCase().includes("requires merchant approval");

    record(7, "Trust Mode — Semi-Auto, Stage 2+", pass,
      pass ? "" : `status=${t.status} stage=${t.stage} message="${message}"`);
  } catch (e: any) {
    record(7, "Trust Mode — Semi-Auto, Stage 2+", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 8: Duplicate webhook
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    const invId = `${INV_PREFIX}_seq8`;
    // First webhook + process to sent
    const wh1 = await fireOverdueWebhook(invId, 3);
    const taskId1 = wh1.taskId;
    await processTask(taskId1);

    // Fire same overdue webhook again — should cancel old task and create new
    const wh2 = await fireOverdueWebhook(invId, 3);
    const taskId2 = wh2.taskId;

    // Check old task is cancelled
    const tasksRes = await fetch(`${BASE}/tasks`);
    const tasks = await tasksRes.json();
    const oldTask = tasks.find((t: any) => t.id === taskId1);
    const newTask = tasks.find((t: any) => t.id === taskId2);

    const pass =
      oldTask && oldTask.status === "cancelled" &&
      newTask && newTask.status === "pending" &&
      taskId1 !== taskId2;

    record(8, "Duplicate webhook", pass,
      pass ? "" : `oldTaskId=${taskId1} oldStatus=${oldTask?.status} newTaskId=${taskId2} newStatus=${newTask?.status}`);
  } catch (e: any) {
    record(8, "Duplicate webhook", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 9: Double-process guard
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    const invId = `${INV_PREFIX}_seq9`;
    const wh = await fireOverdueWebhook(invId, 3);
    const taskId = wh.taskId;

    // First process — should succeed
    const proc1 = await processTask(taskId);

    // Second process — should fail with 400
    const proc2 = await processTask(taskId);

    const pass =
      proc1.status === 200 &&
      proc1.body.task.status === "sent" &&
      proc2.status === 400 &&
      proc2.body.error?.includes("Task already processed") &&
      proc2.body.currentStatus === "sent";

    record(9, "Double-process guard", pass,
      pass ? "" : `proc1Status=${proc1.status} proc2Status=${proc2.status} proc2Error=${JSON.stringify(proc2.body)}`);
  } catch (e: any) {
    record(9, "Double-process guard", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Sequence 10: Weekly summary accuracy
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");

    // Seed specific data directly via webhooks:
    // 1. Overdue invoice that was then paid (recovered) — due in last 7 days
    const invPaid1 = `${INV_PREFIX}_seq10_paid1`;
    const whPaid1 = await fireOverdueWebhook(invPaid1, 2, { amountCents: 10000, customerName: "Paid Client 1" });
    await processTask(whPaid1.taskId); // send it
    await firePaidWebhook(invPaid1); // then mark paid

    // 2. Another paid one
    const invPaid2 = `${INV_PREFIX}_seq10_paid2`;
    const whPaid2 = await fireOverdueWebhook(invPaid2, 1, { amountCents: 5000, customerName: "Paid Client 2" });
    await processTask(whPaid2.taskId);
    await firePaidWebhook(invPaid2);

    // 3. Sent but not paid (still overdue) — these should NOT be counted as activeSequences (they're sent)
    const invSent = `${INV_PREFIX}_seq10_sent`;
    const whSent = await fireOverdueWebhook(invSent, 4, { amountCents: 20000 });
    await processTask(whSent.taskId);

    // 4. Pending — not processed yet (active sequence)
    const invPending1 = `${INV_PREFIX}_seq10_pending1`;
    await fireOverdueWebhook(invPending1, 3);
    const invPending2 = `${INV_PREFIX}_seq10_pending2`;
    await fireOverdueWebhook(invPending2, 2);

    // Get summary
    const summary = await getSummary(1);

    // Verify: invoicesRecovered should be 2 (the two paid ones)
    // amountCollectedDollars: 100.00 + 50.00 = 150.00
    // remindersSent: at least 3 (the two paid + one sent)
    // activeSequences: at least 2 pending ones (not counting sent/cancelled)

    const pass =
      summary.invoicesRecovered >= 2 &&
      summary.amountCollectedDollars >= 150.00 &&
      summary.remindersSent >= 3 &&
      summary.activeSequences >= 2;

    record(10, "Weekly summary accuracy", pass,
      pass ? "" : `Got: recovered=${summary.invoicesRecovered} amount=$${summary.amountCollectedDollars} sent=${summary.remindersSent} active=${summary.activeSequences} rate=${summary.recoveryRatePercent}%`);
  } catch (e: any) {
    record(10, "Weekly summary accuracy", false, `Exception: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Cleanup: reset trust_mode to 'full'
  // ────────────────────────────────────────────────────
  try {
    await setTrustMode("full");
    console.log("\n🔄 Trust mode reset to 'full'");
  } catch (e: any) {
    console.log(`⚠️  Failed to reset trust_mode: ${e.message}`);
  }

  // ────────────────────────────────────────────────────
  // Final summary
  // ────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("  🎉 All 10/10 tests PASSED");
  } else {
    console.log(`  ❌ ${failed} test(s) FAILED`);
    for (const r of results) {
      if (!r.pass) {
        console.log(`     Seq ${r.seq}: ${r.name} — ${r.details}`);
      }
    }
  }
  console.log("═══════════════════════════════════════════════");

  // Exit with appropriate code
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
