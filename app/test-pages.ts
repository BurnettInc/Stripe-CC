/**
 * List-page filter tests — /past-due?status= and /reminders?type=.
 *
 * The summary chips on the dashboard list pages are filter tabs: /past-due
 * supports all|overdue|paid|refunded|disputed (default overdue, matching the
 * pre-existing behavior), /reminders supports all|real (default all). This
 * suite proves the server-side filtering actually filters:
 *   - /past-due default shows only overdue rows, with the Overdue chip marked
 *     selected and all five tabs rendered with correct counts
 *   - ?status=paid / refunded / disputed / all return exactly the rows for
 *     that view and move the selected state
 *   - /reminders default shows every success send (stub rows included, still
 *     labeled "Test send" — no-fake-sends rule preserved)
 *   - ?type=real excludes [STUB SEND] rows entirely
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
  d.run("DELETE FROM send_logs; DELETE FROM reminder_tasks; DELETE FROM invoices WHERE merchant_id=?;", [MERCHANT]);
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
  return Array.from(html.matchAll(/<div class="cell-strong">([^<]*)</g)).map((m) => m[1]);
}

async function main(): Promise<void> {
  seed();
  const base = await get("/past-due");
  const all = await get("/past-due?status=all");
  const paid = await get("/past-due?status=paid");
  const refunded = await get("/past-due?status=refunded");
  const disputed = await get("/past-due?status=disputed");
  const bogus = await get("/past-due?status=bogus");

  // Default view = overdue (unchanged behavior): exactly the 3 overdue rows.
  check("past-due default shows only overdue rows", rows(base).join(",") === "Ovd Alpha,Ovd Beta,Disputed Epsilon", rows(base).join(","));
  check("past-due default selects Overdue chip", selectedChip(base) === "Overdue · 3", selectedChip(base) ?? "none");
  const labels = chipLabels(base).join(" | ");
  check("past-due renders all five filter tabs", chipLabels(base).length === 5, labels);
  check("past-due chip counts are whole-dataset", labels.includes("All invoices · 5") && labels.includes("Paid · 2") && labels.includes("Refunded · 1") && labels.includes("Disputed · 1"), labels);
  check("past-due default has sortable headers + data-sort cells", (base.match(/data-sort-key=/g) || []).length === 5 && (base.match(/data-sort="/g) || []).length >= 5, `keys=${(base.match(/data-sort-key=/g) || []).length}`);

  check("?status=all shows every invoice", rows(all).length === 5 && selectedChip(all) === "All invoices · 5", rows(all).join(","));
  check("?status=paid shows only paid", rows(paid).join(",") === "Paid Gamma,Refunded Delta" && selectedChip(paid) === "Paid · 2", rows(paid).join(","));
  check("?status=refunded shows only the refunded invoice", rows(refunded).join(",") === "Refunded Delta" && selectedChip(refunded) === "Refunded · 1", rows(refunded).join(","));
  check("?status=disputed shows only the disputed invoice", rows(disputed).join(",") === "Disputed Epsilon" && selectedChip(disputed) === "Disputed · 1", rows(disputed).join(","));
  check("?status=bogus falls back to overdue default", rows(bogus).join(",") === rows(base).join(",") && selectedChip(bogus) === "Overdue · 3", rows(bogus).join(","));

  const remAll = await get("/reminders");
  const remReal = await get("/reminders?type=real");
  const remBogus = await get("/reminders?type=bogus");
  check("reminders default shows both sends, stub labeled Test send", rows(remAll).join(",") === "Ovd Alpha,Ovd Beta" && remAll.includes('chip-stub">Test send') && remAll.includes('chip-sent">Sent'), rows(remAll).join(","));
  check("reminders default selects All sends", selectedChip(remAll) === "All sends · 2" && remAll.includes("1 real send"), selectedChip(remAll) ?? "none");
  check("?type=real excludes the stub send", rows(remReal).join(",") === "Ovd Alpha" && !remReal.includes("STUB SEND"), rows(remReal).join(","));
  check("?type=real selects Real sends", selectedChip(remReal) === "1 real send", selectedChip(remReal) ?? "none");
  check("?type=bogus falls back to all", rows(remBogus).join(",") === rows(remAll).join(",") && selectedChip(remBogus) === "All sends · 2", rows(remBogus).join(","));
  check("reminders has sortable headers + data-sort cells", (remAll.match(/data-sort-key=/g) || []).length === 4 && (remAll.match(/data-sort="/g) || []).length >= 8, `keys=${(remAll.match(/data-sort-key=/g) || []).length}`);

  // Auth must still be enforced on the new query-param variants.
  const unauth = await fetch(BASE + "/past-due?status=all", { headers: { Cookie: "session=nope" } });
  check("query-param routes still require session auth", unauth.status === 401, `status=${unauth.status}`);

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR", e); process.exit(1); });
