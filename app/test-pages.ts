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
    "INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (?, 'acct_pages', 'pages@example.com', 'draft')",
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
  const tA = d.query("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject) VALUES ((SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_a'), 1, 'sent', 'Payment reminder') RETURNING id").get() as { id: number };
  const tB = d.query("INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject) VALUES ((SELECT id FROM invoices WHERE stripe_invoice_id='pgs_ovd_b'), 3, 'sent', 'Final notice') RETURNING id").get() as { id: number };
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
