/**
 * List-page filter tests — /past-due?status= and /reminders.
 *
 * The past-due summary chips are filter tabs: /past-due supports
 * all|overdue|paid|refunded|disputed (default overdue). /reminders is a
 * SINGLE list, newest first — every successful reminder send (real + test
 * rows together); test (stub) rows are labeled with a muted "Test send" pill
 * next to the customer name and carry a row-test marker class, and the
 * shared list-page CSS hides row-test rows unconditionally (no toggle — test
 * sends are never visible to merchants). The old two-tab split
 * (?type=all|real) is gone — ?type= is a no-op now. This suite proves:
 *   - /past-due default shows only overdue rows, with the Overdue chip marked
 *     selected and all five tabs rendered with correct counts
 *   - ?status=paid / refunded / disputed / all return exactly the rows for
 *     that view and move the selected state
 *   - /reminders renders ONE list (no tab chips at all), newest first, with
 *     both real and stub rows; the stub row has the muted "Test send" pill +
 *     row-test marker class, real rows have no pill
 *   - /reminders no longer renders a "Hide test sends" toggle; stub rows are
 *     hidden unconditionally by the shared list-page CSS rule tr.row-test
 *   - ?type=real / ?type=bogus are no-ops (same single list, no tabs)
 *   - rows carry data-sort attributes and the table has sortable headers
 *     (the client-side sort input, verified by the served markup)
 *
 * Runs against a booted server (TEST_BASE, default http://localhost:3100)
 * sharing its SQLite DB (TEST_DB_PATH, default /tmp/cc-pages.db). Run via:
 *
 *   bash /tmp/run-suite.sh pages
 *
 * (boots an isolated server with a fresh DB and stripped provider keys).
 */
import { Database } from "bun:sqlite";
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-pages.db";
const SESSION = "pages-test-session";
const MERCHANT = 2; // dedicated merchant, like the free-drafts suite

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

function db(): Database {
  return new Database(DB_PATH);
}

function seed(): void {
  const d = db();
  d.run(
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, sender_name) VALUES (?, 'acct_pages', 'pages@example.com', 'draft', 'Acme Widgets')",
    [MERCHANT]
  );
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))", [SESSION, MERCHANT]);
  d.run("DELETE FROM send_logs");
  d.run("DELETE FROM reminder_tasks");
  d.run("DELETE FROM invoices WHERE merchant_id=?", [MERCHANT]);
  const due = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
  const inv = (sid: string, name: string, amt: number, dueDate: string, status: string, dispute?: string, refund?: string) => {
    d.run(
      "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status, dispute_id, refund_id) VALUES (?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?)",
      [sid, MERCHANT, name, name.toLowerCase() + "@x.com", amt, dueDate, status, dispute ?? null, refund ?? null]
    );
  };
  inv("pgs_ovd_a", "Ovd Alpha", 12000, due(10), "overdue");
  inv("pgs_ovd_b", "Ovd Beta", 5000, due(3), "overdue");
  inv("pgs_paid_c", "Paid Gamma", 25000, due(20), "paid");
  inv("pgs_paid_d", "Refunded Delta", 8000, due(30), "paid", undefined, "re_pgs");
  inv("pgs_ovd_e", "Disputed Epsilon", 150000, due(45), "overdue", "dp_pgs");
  // draft_subject/draft_body are the PERSISTED sent content (read back by the
  // reminders full-email viewer — never regenerated). Bodies are plain text.
  const tA = d.query("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES ((SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_a'), 1, 'sent', 'Payment reminder', 'Hi Ovd Alpha,\n\nJust a friendly reminder that invoice pgs_ovd_a is due.\n\nThanks!') RETURNING id").get() as { id: number };
  const tB = d.query("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES ((SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_b'), 3, 'sent', 'Final notice', 'Hi Ovd Beta,\n\nThis is your final notice for invoice pgs_ovd_b before we escalate further.\n\nRegards') RETURNING id").get() as { id: number };
  // An OPEN (reviewed) task for ovd_a so the stage-override reconciliation has
  // a pending task to re-stage immediately (the send_log above references the
  // separate SENT task tA — the reminders page lists sends, not tasks).
  d.run("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES ((SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_a'), 2, 'reviewed', 'Following up', 'Hi Ovd Alpha,\n\nFollowing up on invoice pgs_ovd_a.\n\nThanks')");
  d.run("INSERT INTO send_logs (reminder_task_id, type, status, provider_message, created_at) VALUES (?, 'reminder', 'success', 'Sent via Resend re_pgs', datetime('now','-1 day'))", [tA.id]);
  d.run("INSERT INTO send_logs (reminder_task_id, type, status, provider_message, created_at) VALUES (?, 'reminder', 'success', '[STUB SEND] Would send email: Beta', datetime('now','-2 days'))", [tB.id]);
  d.close();
}

async function get(path: string): Promise<string> {
  const res = await fetch(BASE + path, { headers: { Cookie: `session=${SESSION}` } });
  if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status}`);
  return res.text();
}

function chipLabels(html: string): string[] {
  return Array.from(html.matchAll(/<a class="summary-chip[^"]*"[^>]*>([^<]*)</g)).map((m) => m[1]);
}

function selectedChip(html: string): string | null {
  const m = html.match(/<a class="summary-chip selected"[^>]*>([^<]*)</);
  return m ? m[1] : null;
}

function rows(html: string): string[] {
  // cell-strong divs may contain an inline pill (e.g. "Test send") after the
  // name — trim so the captured name is exact.
  return Array.from(html.matchAll(/<div class="cell-strong">([^<]*)</g)).map((m) => m[1].trim());
}

async function main(): Promise<void> {
  seed();
  const base = await get("/past-due");
  const all = await get("/past-due?status=all");
  const paid = await get("/past-due?status=paid");
  const refunded = await get("/past-due?status=refunded");
  const disputed = await get("/past-due?status=disputed");
  const bogus = await get("/past-due?status=bogus");

  // Default view = overdue (unchanged behavior): exactly the 3 overdue rows,
  // in the server's deterministic order (due_date ASC — most overdue first).
  check("past-due default shows only overdue rows", rows(base).join(",") === "Disputed Epsilon,Ovd Alpha,Ovd Beta", rows(base).join(","));
  check("past-due default selects Overdue chip", selectedChip(base) === "Overdue · 3", selectedChip(base) ?? "none");
  const labels = chipLabels(base).join(" | ");
  check("past-due renders all five filter tabs", chipLabels(base).length === 5, labels);
  check("past-due chip counts are whole-dataset", labels.includes("All invoices · 5") && labels.includes("Paid · 2") && labels.includes("Refunded · 1") && labels.includes("Disputed · 1"), labels);
  check("past-due default has sortable headers + data-sort cells", (base.match(/data-sort-key=/g) || []).length === 5 && (base.match(/data-sort="/g) || []).length >= 5, `keys=${(base.match(/data-sort-key=/g) || []).length}`);

  check("?status=all shows every invoice", rows(all).length === 5 && selectedChip(all) === "All invoices · 5", rows(all).join(","));
  check("?status=paid shows only paid", rows(paid).join(",") === "Refunded Delta,Paid Gamma" && selectedChip(paid) === "Paid · 2", rows(paid).join(","));
  check("?status=refunded shows only the refunded invoice", rows(refunded).join(",") === "Refunded Delta" && selectedChip(refunded) === "Refunded · 1", rows(refunded).join(","));
  check("?status=disputed shows only the disputed invoice", rows(disputed).join(",") === "Disputed Epsilon" && selectedChip(disputed) === "Disputed · 1", rows(disputed).join(","));
  check("?status=bogus falls back to overdue default", rows(bogus).join(",") === rows(base).join(",") && selectedChip(bogus) === "Overdue · 3", rows(bogus).join(","));

  const remAll = await get("/reminders");
  const remReal = await get("/reminders?type=real");
  const remBogus = await get("/reminders?type=bogus");

  // Single list, newest first: both sends shown, real row first (seeded at
  // -1 day) then the stub (seeded at -2 days). No tab chips at all.
  check("reminders shows one list with both sends newest first", rows(remAll).join(",") === "Ovd Alpha,Ovd Beta", rows(remAll).join(","));
  check("reminders has no filter tabs (All sends/Real sends gone)", !remAll.includes("All sends") && !remAll.includes("Real sends") && (remAll.match(/<a class="summary-chip/g) || []).length === 0, `chips=${(remAll.match(/<a class="summary-chip/g) || []).length}`);
  check("reminders stub row has muted Test send pill next to customer name", remAll.includes('class="pill pill-muted">Test send'), "");
  check("reminders stub row carries row-test marker class", remAll.includes('class="row-test"'), "");
  check("reminders real rows have no Test send pill", (remAll.match(/class="pill pill-muted"/g) || []).length === 1 && (remAll.match(/class="row-test"/g) || []).length === 1, `pills=${(remAll.match(/class="pill pill-muted"/g) || []).length}`);
  check("reminders stub send still labeled in Result column", remAll.includes('chip-stub">Test send') && remAll.includes('chip-sent">Sent'), "");
  check("reminders no longer renders a Hide test sends toggle", !remAll.includes('id="hide-test-sends"') && !remAll.includes("Hide test sends") && !remAll.includes("hide-tests-toggle"), "");
  check("reminders stub rows hidden unconditionally by list-page CSS", /tr\.row-test\s*\{\s*display:\s*none/.test(remAll), "");
  check("reminders ?type=real is a no-op (single view)", rows(remReal).join(",") === rows(remAll).join(",") && (remReal.match(/<a class="summary-chip/g) || []).length === 0, rows(remReal).join(","));
  check("reminders ?type=bogus is a no-op (single view)", rows(remBogus).join(",") === rows(remAll).join(","), rows(remBogus).join(","));
  check("reminders has sortable headers + data-sort cells", (remAll.match(/data-sort-key=/g) || []).length === 4 && (remAll.match(/data-sort="/g) || []).length >= 8, `keys=${(remAll.match(/data-sort-key=/g) || []).length}`);

  // Auth must still be enforced on the new query-param variants.
  const unauth = await fetch(BASE + "/past-due?status=all", { headers: { Cookie: "session=nope" } });
  check("query-param routes still require session auth", unauth.status === 401, `status=${unauth.status}`);
  const unauthRem = await fetch(BASE + "/reminders?type=real", { headers: { Cookie: "session=nope" } });
  check("reminders query-param route still requires session auth", unauthRem.status === 401, `status=${unauthRem.status}`);

  // ── FEATURE 1: sent-email full-content viewer on /reminders ──
  // Each row has a "View email" toggle; the hidden detail panel holds the
  // EXACT sent content (persisted draft_subject/draft_body + reconstructed
  // From/Reply-To/CAN-SPAM footer — never regenerated).
  const ovdAId = (db().query("SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_a'").get() as { id: number }).id;
  const ovdBId = (db().query("SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_b'").get() as { id: number }).id;

  check("reminders renders a View email toggle per row", (remAll.match(/class="email-toggle"/g) || []).length >= 2, `toggles=${(remAll.match(/class="email-toggle"/g) || []).length}`);
  check("reminders detail panel present per row (hidden by default)", (remAll.match(/class="email-body" id="emailbody-/g) || []).length >= 2, `panels=${(remAll.match(/class="email-body" id="emailbody-/g) || []).length}`);
  // From: global FROM_EMAIL + merchant sender_name display-name branding.
  check("reminders detail From uses merchant sender-name branding", remAll.includes("Acme Widgets") && remAll.includes("noreply@stripecollectionscopilot.com"), "");
  // Reply-To: system-tracked reply+{invoice_id}@{REPLY_DOMAIN} (per-task/invoice).
  check("reminders detail shows tracked Reply-To for real row", remAll.includes(`reply+${ovdAId}@replies.getcollectionscopilot.com`), `reply+${ovdAId}@replies.getcollectionscopilot.com`);
  check("reminders detail shows tracked Reply-To for stub row (distinct per invoice)", remAll.includes(`reply+${ovdBId}@replies.getcollectionscopilot.com`), `reply+${ovdBId}@replies.getcollectionscopilot.com`);
  // Subject surfaced in the detail panel.
  check("reminders detail shows the sent subject", remAll.includes(">Payment reminder</dd>"), "");
  // Body: the exact persisted plain-text body + the deterministically
  // reconstructed CAN-SPAM footer (what the recipient actually saw).
  check("reminders detail shows full sent body (real row)", remAll.includes("friendly reminder that invoice pgs_ovd_a is due") && remAll.includes("This is your final notice for invoice pgs_ovd_b"), "");
  check("reminders detail includes the CAN-SPAM footer", remAll.includes("Unsubscribe:") && remAll.includes("To stop receiving reminders for this invoice") && remAll.includes("CollectionsCopilot") && remAll.includes("Texas, USA"), "");

  // ── FEATURE 2: manual escalation-stage override on /past-due ──
  // Auto-is-the-default: every row renders a Stage select defaulting to Auto,
  // and no "manually set" pill appears until an override is set.
  check("past-due renders a stage-override control per row (Auto default)", (base.match(/class="stage-override"/g) || []).length === 3, `n=${(base.match(/class="stage-override"/g) || []).length}`);
  check("past-due stage controls offer Auto/1/2/3", /<option value=""[^>]*>Auto<\/option>/.test(base) && base.includes('<option value="1">Stage 1</option>') && base.includes('<option value="2">Stage 2</option>') && base.includes('<option value="3">Stage 3</option>'), "");
  check("past-due no manual indicator until an override is set", (base.match(/class="pill pill-manual"/g) || []).length === 0, `n=${(base.match(/class="pill pill-manual"/g) || []).length}`);
  // Effective stage is auto from days-overdue: pgs_ovd_a is 10d → Stage 2,
  // pgs_ovd_b is 3d → Stage 1, pgs_ovd_e is 45d → Stage 3.
  check("past-due shows auto effective stage chip per row", base.includes('chip-stage st2">Stage 2') && base.includes('chip-stage st1">Stage 1') && base.includes('chip-stage st3">Stage 3'), "");

  // Set an override on pgs_ovd_a (10 days overdue → auto Stage 2) to Stage 3.
  const setRes = await fetch(BASE + `/invoices/${ovdAId}/stage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: `session=${SESSION}` },
    body: JSON.stringify({ stage: 3 }),
  });
  const setBody = await setRes.json();
  check("PUT stage override returns 200 with is_overridden", setRes.status === 200 && setBody.is_overridden === true && setBody.stage_override === 3 && setBody.effective_stage === 3, JSON.stringify(setBody));
  // Immediate effect on the invoice's open pending task (stage + re-drafted
  // content follow the override).
  const ovdATask = db().query("SELECT stage, draft_subject, status FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(ovdAId) as { stage: number; draft_subject: string; status: string };
  check("override wins immediately: open task stage updated to 3", ovdATask.stage === 3, `stage=${ovdATask.stage}`);
  check("override re-drafts task content at the new stage (Final notice prefix)", typeof ovdATask.draft_subject === "string" && /Final notice/i.test(ovdATask.draft_subject), ovdATask.draft_subject);
  check("override-affected task is still open (reviewed, not sent)", ovdATask.status === "reviewed", `status=${ovdATask.status}`);
  // GET /invoices/:id reflects the override.
  const invRes = await (await fetch(BASE + `/invoices/${ovdAId}`, { headers: { Cookie: `session=${SESSION}` } })).json();
  check("GET /invoices/:id returns stage_override + is_overridden", invRes.is_overridden === true && invRes.stage_override === 3, JSON.stringify({ s: invRes.stage_override, o: invRes.is_overridden }));
  // /past-due now shows the manual indicator + select state for that row.
  const baseSet = await get("/past-due");
  const rowA = baseSet.match(new RegExp(`<tr>.*?data-invoice-id="${ovdAId}".*?</tr>`, "s"));
  const rowAStr = rowA ? rowA[0] : "";
  check("past-due shows manual indicator after override", rowAStr.includes('class="pill pill-manual"') && rowAStr.includes("manually set"), "");
  check("past-due select reflects the override value", rowAStr.includes(`data-invoice-id="${ovdAId}"`) && /<option value="3" selected>Stage 3<\/option>/.test(rowAStr), "");

  // Clear the override → Auto restored + effective stage back to days-overdue.
  const clearRes = await fetch(BASE + `/invoices/${ovdAId}/stage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: `session=${SESSION}` },
    body: JSON.stringify({ stage: null }),
  });
  const clearBody = await clearRes.json();
  check("PUT stage null clears the override", clearRes.status === 200 && clearBody.is_overridden === false && clearBody.stage_override === null, JSON.stringify(clearBody));
  const ovdATask2 = db().query("SELECT stage FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(ovdAId) as { stage: number };
  check("clearing restores auto: open task stage back to auto (Stage 2 at 10d)", ovdATask2.stage === 2, `stage=${ovdATask2.stage}`);
  const baseClear = await get("/past-due");
  check("past-due manual indicator removed after clear", (baseClear.match(/class="pill pill-manual"/g) || []).length === 0, `n=${(baseClear.match(/class="pill pill-manual"/g) || []).length}`);
  const invRes2 = await (await fetch(BASE + `/invoices/${ovdAId}`, { headers: { Cookie: `session=${SESSION}` } })).json();
  check("GET /invoices/:id reflects cleared override", invRes2.is_overridden === false && invRes2.stage_override === null, JSON.stringify({ s: invRes2.stage_override, o: invRes2.is_overridden }));

  // Auth + validation on the stage endpoint.
  const unauthStage = await fetch(BASE + `/invoices/${ovdAId}/stage`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage: 2 }),
  });
  check("stage override endpoint requires session auth", unauthStage.status === 401, `status=${unauthStage.status}`);
  const badStage = await fetch(BASE + `/invoices/${ovdAId}/stage`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: `session=${SESSION}` }, body: JSON.stringify({ stage: 9 }),
  });
  check("stage override rejects invalid stage", badStage.status === 400, `status=${badStage.status}`);

  // ── Reply-pause copy pass (owner 2026-08-12): landing page + dashboard UI ──
  // The backend serves the built TanStack site at "/" (SSR, unauthenticated)
  // and dashboard.html at /dashboard. Assert the copy describes the
  // reply-pause behavior the backend is being built to deliver (sequence
  // auto-pauses on reply, merchant notified, message forwarded) and that the
  // Reply-To customization field is gone from sender branding (Reply-To is now
  // the system-tracked reply+{invoice}@replies.getcollectionscopilot.com).
  const landing = await (await fetch(BASE + "/")).text();
  // SSR HTML escapes apostrophes (&#x27;) inside text nodes, so match either form.
  check("landing FAQ: reply pauses the sequence automatically", /their sequence pauses automatically and you(&#x27;|')re notified immediately/.test(landing), "");
  check("landing FAQ: reply forwarded to your inbox", landing.includes("forwarded straight to your inbox"), "");
  check("landing FAQ: no near-term-roadmap reply copy", !landing.includes("near-term roadmap") && !landing.includes("reply detection isn't automatic"), "");
  check("landing FAQ: opt-out copy is per-invoice scope", landing.includes("use the link in any reminder to stop follow-ups on that invoice") && !landing.includes("unsubscribe link in any email we send"), "");
  check("landing FAQ: reply question still present", landing.includes("What happens if a customer replies?"), "");

  const dash = await (await fetch(BASE + "/dashboard")).text();
  check("dashboard: Reply-To customization field removed", !dash.includes('id="reply-to"') && !dash.includes("Reply-To email") && !dash.includes("payload.reply_to"), "");
  check("dashboard: sender-name branding field kept", dash.includes('id="sender-name"'), "");
  check("dashboard: sender helper line no longer mentions Reply-To", !dash.includes("replies go to your Reply-To"), "");
  check("dashboard: pause-reason chips renderer present (reply/dispute/paid)", dash.includes("pauseReasonChipFor") && dash.includes("Reply received") && dash.includes("Dispute") && dash.includes("Payment received"), "");
  check("dashboard: reply-draft-awaiting-review chip + inbox copy present", dash.includes("Reply draft awaiting review") && dash.includes("Customer replies pause that invoice's sequence and wait here for your response."), "");
  check("dashboard: chip keys documented defensively (reply_paused_at/dispute_id/invoice_status)", dash.includes("reply_paused_at") && dash.includes("dispute_id") && dash.includes("invoice_status"), "");

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
