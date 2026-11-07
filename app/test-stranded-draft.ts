/**
 * Stranded-draft visibility (2026-11-06) — endpoint suite.
 *
 * THE DEFECT: Trust Mode auto-sends only at DRAFT CREATION. A stage-1 reminder
 * drafted while the merchant was in Draft Mode therefore stays 'reviewed'
 * forever after the merchant flips to Semi-Auto, and nothing told the merchant
 * it was sendable (live case: merchant 11, reminder_task 72, $27.00).
 *
 * THIS SUITE PROVES the read-only derived flag `draft_readiness` on GET /tasks,
 * the counts on GET /tasks/ready-count, and that nothing about sending changed:
 *
 *   (a) 401 without a session on /tasks and /tasks/ready-count;
 *   (b) reviewed + merchant now Semi-Auto + invoice overdue + reviewer passes
 *       ⇒ ready_to_send true, stranded true (this is merchant 11's case);
 *   (c) reviewed + merchant still in Draft Mode ⇒ NOT ready (no flag at all);
 *   (d) reviewed + invoice now paid ⇒ NOT ready;
 *   (e) reviewed + reviewer gate failure ⇒ NOT ready AND needs_attention true
 *       with the gate issues attached;
 *   (f) stage 2 in Semi-Auto: ready_to_send true but stranded FALSE (Semi-Auto
 *       never auto-sends stage 2, so it is not a stranded draft);
 *   (g) /tasks/ready-count reports {ready, stranded, needs_attention} per mode;
 *   (h) READ-ONLY: reading /tasks sends nothing and changes nothing — the task
 *       is still 'reviewed' and no send_logs row exists for it;
 *   (i) the send-time guard is unchanged: POST /tasks/:id/approve on the
 *       gate-failing draft still 409s and leaves the task unsent;
 *   (j) the merchant-facing markup carries the new surfaces (/messages chips +
 *       explanation sentence, /copilot-controls count element).
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3132) and
 * its SQLite file (TEST_DB_PATH, default /tmp/cc-stranded-draft.db). Boot the
 * server with the provider keys stripped so nothing can leave the box:
 *
 *   DB_PATH=/tmp/cc-stranded-draft.db PORT=3132 bun run src/index.ts
 *   TEST_BASE=http://localhost:3132 TEST_DB_PATH=/tmp/cc-stranded-draft.db bun run test-stranded-draft.ts
 */
import { Database } from "bun:sqlite";

const BASE = process.env.TEST_BASE || "http://localhost:3132";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-stranded-draft.db";
const SESSION_SEMI = "stranded-semi-session";
const SESSION_DRAFT = "stranded-draft-session";
const MERCHANT_SEMI = 1; // default merchant, created at boot
const MERCHANT_DRAFT = 2; // seeded below

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
const DUE = "2026-10-30"; // a fixed past date — the invoice is overdue
const HOSTED = "https://invoice.stripe.com/i/acct_stranded/test_stranded001";

interface SeedResult {
  readyTaskId: number;
  paidTaskId: number;
  gateFailTaskId: number;
  stage2TaskId: number;
  draftModeTaskId: number;
}

function seed(): SeedResult {
  const d = db();
  // Merchant 1 (the default merchant) is now in Semi-Auto; merchant 2 is still
  // in Draft Mode. Both are live-mode merchants. Merchant 1 is inserted
  // explicitly so the seed does not depend on ensureDefaultMerchant having run.
  d.run(
    "INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (1, 'acct_default', 'default@example.com', 'semi')",
  );
  d.run("UPDATE merchants SET trust_mode='semi' WHERE id=?", [MERCHANT_SEMI]);
  d.run(
    "INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (?, 'acct_stranded_draft', 'draftmode@example.com', 'draft')",
    [MERCHANT_DRAFT],
  );
  d.run("UPDATE merchants SET trust_mode='draft' WHERE id=?", [MERCHANT_DRAFT]);
  // An active Pro subscription for merchant 1, so POST /approve reaches the
  // send-time guards instead of stopping at the 402 paid-unlock gate.
  d.run(
    "INSERT OR REPLACE INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_stranded', 'pro', 'active')",
    [MERCHANT_SEMI],
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))", [
    SESSION_SEMI,
    MERCHANT_SEMI,
  ]);
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))", [
    SESSION_DRAFT,
    MERCHANT_DRAFT,
  ]);

  function insertInvoice(
    sid: string,
    merchantId: number,
    amount: number,
    status: string,
    hosted: string | null,
  ): number {
    const r = d.run(
      `INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents,
                             currency, due_date, status, livemode, hosted_invoice_url)
       VALUES (?, ?, 'Dana Customer', 'dana@customer.com', ?, 'usd', ?, ?, 1, ?)`,
      [sid, merchantId, amount, DUE, status, hosted],
    );
    return Number(r.lastInsertRowid);
  }
  function insertTask(invoiceId: number, stage: number, subject: string, body: string): number {
    const r = d.run(
      `INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body, reviewer_notes)
       VALUES (?, ?, 'reviewed', ?, ?, '')`,
      [invoiceId, stage, subject, body],
    );
    return Number(r.lastInsertRowid);
  }
  /** A draft that passes every reviewer gate for its invoice. */
  function goodDraft(sid: string, amountDollars: string, hosted: string | null): { subject: string; body: string } {
    return {
      subject: `Reminder: invoice ${sid} is overdue`,
      body:
        `Hi Dana,\n\nInvoice ${sid} for $${amountDollars} was due on ${DUE} and is still open.\n` +
        (hosted ? `You can pay it here: ${hosted}\n` : "") +
        `\nBest regards,\nAcme Billing`,
    };
  }

  // (b) ready + stranded: semi merchant, overdue, reviewer passes.
  const readyInv = insertInvoice("in_stranded_ready", MERCHANT_SEMI, 2700, "overdue", HOSTED);
  const ready = goodDraft("in_stranded_ready", "27.00", HOSTED);
  const readyTaskId = insertTask(readyInv, 1, ready.subject, ready.body);

  // (d) reviewed but the invoice is now paid → never "ready".
  const paidInv = insertInvoice("in_stranded_paid", MERCHANT_SEMI, 5000, "paid", HOSTED);
  const paid = goodDraft("in_stranded_paid", "50.00", HOSTED);
  const paidTaskId = insertTask(paidInv, 1, paid.subject, paid.body);

  // (e) reviewed but the reviewer rejects it (merchant dashboard link, no
  //     hosted link) → needs attention, never ready.
  const gateInv = insertInvoice("in_stranded_gatefail", MERCHANT_SEMI, 12000, "overdue", HOSTED);
  const gateBody =
    `Hi Dana,\n\nInvoice in_stranded_gatefail for $120.00 was due on ${DUE}.\n` +
    `Pay here: https://dashboard.stripe.com/invoices/in_stranded_gatefail\n\nBest regards,\nAcme Billing`;
  const gateFailTaskId = insertTask(gateInv, 1, "Reminder: invoice in_stranded_gatefail is overdue", gateBody);

  // (f) stage 2 in Semi-Auto: ready to send, but NOT stranded (semi never
  //     auto-sends stage 2, so nothing was skipped).
  const s2Inv = insertInvoice("in_stranded_stage2", MERCHANT_SEMI, 8000, "overdue", HOSTED);
  const s2 = goodDraft("in_stranded_stage2", "80.00", HOSTED);
  const stage2TaskId = insertTask(s2Inv, 2, s2.subject, s2.body);

  // (c) Draft Mode merchant with an otherwise perfect reviewed draft → not ready.
  const draftInv = insertInvoice("in_stranded_draftmode", MERCHANT_DRAFT, 3000, "overdue", HOSTED);
  const draft = goodDraft("in_stranded_draftmode", "30.00", HOSTED);
  const draftModeTaskId = insertTask(draftInv, 1, draft.subject, draft.body);

  d.close();
  return { readyTaskId, paidTaskId, gateFailTaskId, stage2TaskId, draftModeTaskId };
}

interface TaskRow {
  id: number;
  status: string;
  stage: number;
  draft_readiness: null | {
    ready_to_send: boolean;
    stranded: boolean;
    needs_attention: boolean;
    issues: string[];
    effective_mode: string;
  };
}

async function getTasks(session: string): Promise<TaskRow[]> {
  const res = await fetch(`${BASE}/tasks`, { headers: { Cookie: `session=${session}` } });
  if (!res.ok) throw new Error(`GET /tasks → ${res.status}`);
  return (await res.json()) as TaskRow[];
}
function byId(rows: TaskRow[], id: number): TaskRow | undefined {
  return rows.find((r) => r.id === id);
}
function dbTaskRow(id: number): Record<string, unknown> {
  const d = db();
  const row = d.query("SELECT * FROM reminder_tasks WHERE id=?").get(id) as Record<string, unknown> | undefined;
  d.close();
  return row ?? {};
}
function sendLogCount(taskId: number): number {
  const d = db();
  const row = d.query("SELECT COUNT(*) AS n FROM send_logs WHERE reminder_task_id=?").get(taskId) as { n: number };
  d.close();
  return row.n;
}

async function main(): Promise<void> {
  // ── (a) auth ──
  {
    const tasks = await fetch(`${BASE}/tasks`);
    const counts = await fetch(`${BASE}/tasks/ready-count`);
    check("(a) GET /tasks without session → 401", tasks.status === 401, `status=${tasks.status}`);
    check("(a) GET /tasks/ready-count without session → 401", counts.status === 401, `status=${counts.status}`);
  }

  const ids = seed();
  const tasks = await getTasks(SESSION_SEMI);
  const draftModeTasks = await getTasks(SESSION_DRAFT);

  // ── (b) reviewed + semi + overdue + reviewer passes ⇒ ready & stranded ──
  {
    const t = byId(tasks, ids.readyTaskId);
    const r = t?.draft_readiness;
    check("(b) reviewed+semi+overdue+approved → draft_readiness present", !!r, JSON.stringify(t?.draft_readiness));
    check("(b) → ready_to_send true", r?.ready_to_send === true, `ready=${r?.ready_to_send}`);
    check("(b) → stranded true (semi would have auto-sent stage 1)", r?.stranded === true, `stranded=${r?.stranded}`);
    check("(b) → needs_attention false", r?.needs_attention === false, `needs=${r?.needs_attention}`);
    check("(b) → no gate issues", (r?.issues ?? ["x"]).length === 0, `issues=${JSON.stringify(r?.issues)}`);
    check("(b) → effective_mode semi", r?.effective_mode === "semi", `mode=${r?.effective_mode}`);
  }

  // ── (c) reviewed + Draft Mode ⇒ NOT ready, no flag ──
  {
    const t = byId(draftModeTasks, ids.draftModeTaskId);
    const r = t?.draft_readiness;
    check("(c) reviewed+draft-mode → task returned", !!t, `task=${JSON.stringify(t)}`);
    check("(c) reviewed+draft-mode → ready_to_send false", r?.ready_to_send === false, `ready=${r?.ready_to_send}`);
    check("(c) reviewed+draft-mode → stranded false", r?.stranded === false, `stranded=${r?.stranded}`);
    check("(c) reviewed+draft-mode → needs_attention false", r?.needs_attention === false, `needs=${r?.needs_attention}`);
    check("(c) reviewed+draft-mode → effective_mode draft", r?.effective_mode === "draft", `mode=${r?.effective_mode}`);
  }

  // ── (d) reviewed + invoice now paid ⇒ NOT ready ──
  {
    const t = byId(tasks, ids.paidTaskId);
    const r = t?.draft_readiness;
    check("(d) reviewed+paid → ready_to_send false", r?.ready_to_send === false, `ready=${r?.ready_to_send}`);
    check("(d) reviewed+paid → stranded false", r?.stranded === false, `stranded=${r?.stranded}`);
    check("(d) reviewed+paid → needs_attention false", r?.needs_attention === false, `needs=${r?.needs_attention}`);
  }

  // ── (e) reviewed + gate failure ⇒ not ready, flagged ──
  {
    const t = byId(tasks, ids.gateFailTaskId);
    const r = t?.draft_readiness;
    check("(e) gate failure → ready_to_send false", r?.ready_to_send === false, `ready=${r?.ready_to_send}`);
    check("(e) gate failure → needs_attention true", r?.needs_attention === true, `needs=${r?.needs_attention}`);
    check("(e) gate failure → issues attached", (r?.issues ?? []).length > 0, `issues=${JSON.stringify(r?.issues)}`);
    const joined = (r?.issues ?? []).join(" | ");
    check("(e) gate failure → dashboard-link issue present", joined.includes("dashboard.stripe.com"), joined);
    check("(e) gate failure → missing hosted link issue present", joined.includes("hosted payment link"), joined);
    check("(e) gate failure → never marked stranded", r?.stranded === false, `stranded=${r?.stranded}`);
  }

  // ── (f) stage 2 in Semi-Auto ⇒ ready but NOT stranded ──
  {
    const t = byId(tasks, ids.stage2TaskId);
    const r = t?.draft_readiness;
    check("(f) stage2+semi → ready_to_send true", r?.ready_to_send === true, `ready=${r?.ready_to_send}`);
    check("(f) stage2+semi → stranded false", r?.stranded === false, `stranded=${r?.stranded}`);
  }

  // ── (g) /tasks/ready-count ──
  {
    const res = await fetch(`${BASE}/tasks/ready-count`, { headers: { Cookie: `session=${SESSION_SEMI}` } });
    const counts = (await res.json()) as { ready: number; stranded: number; needs_attention: number };
    check("(g) ready-count → 200", res.status === 200, `status=${res.status}`);
    check("(g) ready-count → ready=2 (stage1 + stage2)", counts.ready === 2, `ready=${counts.ready}`);
    check("(g) ready-count → stranded=1", counts.stranded === 1, `stranded=${counts.stranded}`);
    check("(g) ready-count → needs_attention=1", counts.needs_attention === 1, `needs=${counts.needs_attention}`);
    const draftRes = await fetch(`${BASE}/tasks/ready-count`, { headers: { Cookie: `session=${SESSION_DRAFT}` } });
    const draftCounts = (await draftRes.json()) as { ready: number; stranded: number; needs_attention: number };
    check(
      "(g) ready-count for a Draft Mode merchant → all zero",
      draftCounts.ready === 0 && draftCounts.stranded === 0 && draftCounts.needs_attention === 0,
      JSON.stringify(draftCounts),
    );
  }

  // ── (h) READ-ONLY: the flag sends nothing and changes nothing ──
  {
    await getTasks(SESSION_SEMI);
    const row = dbTaskRow(ids.readyTaskId);
    check("(h) reading /tasks leaves the task 'reviewed'", row.status === "reviewed", `status=${row.status}`);
    check("(h) reading /tasks writes no send_logs row", sendLogCount(ids.readyTaskId) === 0, `logs=${sendLogCount(ids.readyTaskId)}`);
    check("(h) reading /tasks does not set sent_at", row.sent_at === null, `sent_at=${row.sent_at}`);
  }

  // ── (i) send-time guard unchanged: approving the gate-failing draft 409s ──
  {
    const res = await fetch(`${BASE}/tasks/${ids.gateFailTaskId}/approve`, {
      method: "POST",
      headers: { Cookie: `session=${SESSION_SEMI}` },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    check("(i) approve gate-failing draft → 409", res.status === 409, `status=${res.status} body=${JSON.stringify(body)}`);
    const row = dbTaskRow(ids.gateFailTaskId);
    check("(i) task still 'reviewed' after the 409", row.status === "reviewed", `status=${row.status}`);
    check("(i) no send_logs success row for it", sendLogCount(ids.gateFailTaskId) === 0, `logs=${sendLogCount(ids.gateFailTaskId)}`);
  }

  // ── (j) the merchant-facing surfaces exist ──
  {
    const messages = await fetch(`${BASE}/messages`);
    const html = await messages.text();
    check("(j) /messages → 200", messages.status === 200, `status=${messages.status}`);
    check("(j) /messages carries the Ready-to-send chip", html.includes("chip-ready"), "missing chip-ready");
    check("(j) /messages carries the Needs-attention chip", html.includes("chip-attention"), "missing chip-attention");
    check(
      "(j) /messages carries the explanation sentence",
      html.includes("after this draft was written, so it did not send automatically. You can send it now."),
      "missing explanation sentence",
    );
    check("(j) /messages reads the server flag", html.includes("draft_readiness"), "missing draft_readiness reference");
    const controls = await fetch(`${BASE}/copilot-controls`);
    const chtml = await controls.text();
    check("(j) /copilot-controls → 200", controls.status === 200, `status=${controls.status}`);
    check("(j) /copilot-controls carries the count element", chtml.includes('id="mode-stranded"'), "missing #mode-stranded");
    check("(j) /copilot-controls fetches /tasks/ready-count", chtml.includes("/tasks/ready-count"), "missing fetch");
  }

  console.log(`\n${pass} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

await main();
