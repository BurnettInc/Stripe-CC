/**
 * Data-rights suite (PROMISES_AUDIT #42) — export, immediate deletion, and the
 * 30-day cancellation clock the privacy page promises.
 *
 * Contract under test:
 *   1. GET  /account/export — session-authed JSON download of EVERYTHING
 *      stored for the merchant (all merchant-scoped tables keyed by name +
 *      the linked platform account row), with Content-Disposition attachment
 *      filename collectionscopilot-data-<merchant_id>.json. 401 without a
 *      session.
 *   2. POST /account/delete — session-authed immediate purge. Cancels an
 *      ACTIVE Stripe subscription via the API first (subscribed.cancel with
 *      cancel_at_period_end=false — the in-process stub records the call);
 *      if the cancel FAILS the data is STILL purged. Every table ends at 0
 *      rows for the merchant, the merchant row is gone, the session is gone
 *      (follow-up authed request → 401), and the linked account layer is
 *      deleted when this was the account's last merchant (kept when the
 *      account still owns other merchants).
 *   3. Billing webhook customer.subscription.deleted sets
 *      merchants.deletion_scheduled_at ≈ now + 30 days (and never moves an
 *      already-set deadline); a resubscription (checkout.session.completed)
 *      or an updated→active event clears the clock.
 *   4. purgeMerchantData (db.ts) is idempotent — calling it twice (even for
 *      an unknown id) is a safe no-op.
 *
 * Stripe is stubbed by an in-process HTTP server on 3199; the app server MUST
 * be booted with STRIPE_API_BASE + a dummy STRIPE_SECRET_KEY (see
 * /tmp/run-suite.sh data-rights, which adds both to EXTRA_ENV):
 *
 *   STRIPE_API_BASE=http://localhost:3199/v1 STRIPE_SECRET_KEY=sk_test_stub \
 *     TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-data-rights.db \
 *     bun run test-data-rights.ts
 */
import { Database } from "bun:sqlite";
import { purgeMerchantData, getDb } from "./src/db";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-data-rights.db";
const SESSION = "data-rights-session";
const SESSION2 = "data-rights-session-2";
const STRIPE_STUB_PORT = 3199;

let passed = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`PASS  ${label}`); }
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function db(): Database {
  return new Database(DB_PATH);
}
function count(sql: string, ...params: (string | number)[]): number {
  const d = db();
  const row = d.query(`SELECT COUNT(*) as n FROM (${sql})`).get(...params) as { n: number };
  d.close();
  return row.n;
}

// ── In-process Stripe stub ─────────────────────────────────────────────
// Records every subscription-cancel POST (so tests can prove the delete route
// cancels the merchant's subscription before purging) and fails the cancel
// for sub ids containing "fail" (so tests can prove purge proceeds anyway).
const stub: {
  cancelCalls: string[];
  server: ReturnType<typeof Bun.serve>;
} = {
  cancelCalls: [],
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};
stub.server = Bun.serve({
  port: STRIPE_STUB_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // subscriptions.cancel (raw fetch from routes/data-rights.ts on STRIPE_API)
    if (url.pathname.startsWith("/v1/subscriptions/") && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const params = new URLSearchParams(await req.text());
      stub.cancelCalls.push(`${id}?${params.toString()}`);
      if (id.includes("fail")) {
        return Response.json(
          { error: { type: "invalid_request_error", message: "stub: no such subscription" } },
          { status: 500 },
        );
      }
      return Response.json({ id, status: "canceled", cancel_at_period_end: false });
    }
    return Response.json(
      { error: { type: "invalid_request_error", message: `stub: not found ${req.method} ${url.pathname}` } },
      { status: 404 },
    );
  },
});

// ── Seed helpers ───────────────────────────────────────────────────────
function seedSession(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [SESSION]);
  d.close();
}
/** Full merchant-scoped dataset for merchant 1, including a linked platform
 *  account (accounts/account_sessions/account_magic_links/oauth_install_states
 *  + merchants.account_id) so export and account-layer purge are covered. */
function seedFullMerchantData(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO accounts (id, email) VALUES (1, 'merchant1@example.com')");
  d.run("UPDATE merchants SET account_id = 1 WHERE id = 1");
  d.run("INSERT OR REPLACE INTO account_sessions (account_id, token, expires_at) VALUES (1, 'acct-sess-1', datetime('now','+30 days'))");
  d.run("INSERT OR REPLACE INTO account_magic_links (account_id, token, expires_at) VALUES (1, 'magic-1', datetime('now','+15 minutes'))");
  d.run("INSERT OR REPLACE INTO oauth_install_states (state, link_type, account_id) VALUES ('state-1', 'live', 1)");
  d.run("INSERT OR REPLACE INTO invoices (id, stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (101, 'in_export_1', 1, 'Acme', 'acme@example.com', 5000, 'usd', '2026-08-01', 'overdue')");
  d.run("INSERT OR REPLACE INTO invoices (id, stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (102, 'in_export_2', 1, 'Globex', 'globex@example.com', 12000, 'usd', '2026-08-10', 'overdue')");
  d.run("INSERT OR REPLACE INTO reminder_tasks (id, invoice_id, stage, status, draft_subject, draft_body) VALUES (1001, 101, 1, 'sent', 'Friendly reminder', 'Body 1')");
  d.run("INSERT OR REPLACE INTO reminder_tasks (id, invoice_id, stage, status) VALUES (1002, 102, 2, 'pending')");
  d.run("INSERT OR REPLACE INTO send_logs (id, reminder_task_id, type, status, provider_message) VALUES (1, 1001, 'reminder', 'success', 'sent')");
  d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, stripe_customer_id, tier, status) VALUES (1, 1, 'sub_dr_export', 'cus_dr_export', 'standard', 'active')");
  d.run("INSERT OR REPLACE INTO unsubscribes (id, merchant_id, customer_email) VALUES (1, 1, 'no@example.com')");
  d.run("INSERT OR REPLACE INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key) VALUES ('acct_dr_conn', 1, 'tok_conn', NULL, 'pk_test_x')");
  d.run("INSERT OR REPLACE INTO oauth_tokens (stripe_user_id, merchant_id, access_token, refresh_token, stripe_publishable_key, livemode, link_type, expires_at) VALUES ('acct_dr_oauth', 1, 'tok_oauth', 'rt_oauth', 'pk_test_x', 1, 'live', datetime('now','+1 hour'))");
  d.run("INSERT OR REPLACE INTO inbound_replies (id, merchant_id, invoice_id, sequence_key, received_at, from_email, body, idempotency_key, reply_status) VALUES (1, 1, 101, '101', datetime('now'), 'customer@example.com', 'I paid', 'idem-1', 'handled')");
  d.run("INSERT OR REPLACE INTO subscription_events (id, merchant_id, stripe_subscription_id, event, tier, status) VALUES (1, 1, 'sub_dr_export', 'created', 'standard', 'active')");
  d.close();
}
/** Cancel-clock test data: a cancellable subscription row for merchant 1. */
function seedClockSubscription(): void {
  const d = db();
  d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, stripe_customer_id, tier, status) VALUES (2, 1, 'sub_cancel_clock', 'cus_clock', 'standard', 'active')");
  d.close();
}
function deletionScheduledAt(merchantId = 1): string | null {
  const d = db();
  const row = d.query("SELECT deletion_scheduled_at FROM merchants WHERE id = ?").get(merchantId) as { deletion_scheduled_at: string | null } | null;
  d.close();
  return row?.deletion_scheduled_at ?? null;
}
/** Whole days between an SQLite datetime string (UTC) and now. */
function daysUntil(sqliteDt: string): number {
  const iso = sqliteDt.replace(" ", "T") + "Z";
  return (new Date(iso).getTime() - Date.now()) / 86400000;
}

// ── HTTP helpers ───────────────────────────────────────────────────────
function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers, redirect: "manual" });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function main(): Promise<void> {
  // ── 1. Auth gates ──
  {
    const r1 = await get("/account/export");
    check("1a. GET /account/export without session → 401", r1.status === 401, `status=${r1.status}`);
    const r2 = await post("/account/delete", {});
    check("1b. POST /account/delete without session → 401", r2.status === 401, `status=${r2.status}`);
  }

  // ── 2. Export returns everything ──
  seedSession();
  seedFullMerchantData();
  {
    const res = await get("/account/export", { Cookie: `session=${SESSION}` });
    check("2a. GET /account/export with session → 200", res.status === 200, `status=${res.status}`);
    const cd = res.headers.get("content-disposition") || "";
    check("2b. attachment filename collectionscopilot-data-1.json", cd.includes('attachment') && cd.includes('filename="collectionscopilot-data-1.json"'), cd);
    const data = (await res.json()) as Record<string, { length?: number }>;
    const keyChecks: Array<[string, number]> = [
      ["merchant", 1], ["account", 1], ["sessions", 1], ["oauth_tokens", 1],
      ["stripe_connections", 1], ["invoices", 2], ["reminder_tasks", 2],
      ["send_logs", 1], ["subscriptions", 1], ["unsubscribes", 1],
      ["inbound_replies", 1], ["subscription_events", 1],
    ];
    for (const [key, expected] of keyChecks) {
      const actual = Array.isArray(data[key]) ? data[key].length : data[key] != null ? 1 : 0;
      check(`2c. export.${key} has ${expected} row(s)`, actual === expected, `actual=${actual}`);
    }
    check("2d. export.merchant carries merchant id", (data.merchant as { id?: number })?.id === 1);
    check("2e. export.account carries the linked account email", (data.account as { email?: string } | null)?.email === "merchant1@example.com");
  }

  // ── 3. Cancel webhook → 30-day deletion clock ──
  seedClockSubscription();
  {
    const r = await post("/billing", {
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_cancel_clock" } },
    });
    check("3a. cancel webhook accepted", r.status === 200, `status=${r.status}`);
    const scheduled = deletionScheduledAt();
    const days = scheduled ? daysUntil(scheduled) : NaN;
    check("3b. deletion_scheduled_at ≈ now + 30 days", scheduled !== null && days > 29 && days < 31, `scheduled=${scheduled} days=${days}`);

    // Idempotent: a replay must NOT move the deadline later.
    const first = deletionScheduledAt();
    await post("/billing", { type: "customer.subscription.deleted", data: { object: { id: "sub_cancel_clock" } } });
    check("3c. replay does not overwrite the deadline", deletionScheduledAt() === first);

    // Resubscription clears the clock.
    const r2 = await post("/billing", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_reactive", subscription: "sub_reactive", customer: "cus_reactive", metadata: { merchant_id: "1", tier: "pro" } } },
    });
    check("3d. checkout.session.completed accepted", r2.status === 200, `status=${r2.status}`);
    check("3e. resubscription clears deletion_scheduled_at", deletionScheduledAt() === null);

    // updated → active also clears a pending clock.
    await post("/billing", { type: "customer.subscription.deleted", data: { object: { id: "sub_reactive" } } });
    check("3f. second cancel sets clock again", deletionScheduledAt() !== null);
    const r3 = await post("/billing", {
      type: "customer.subscription.updated",
      data: { object: { id: "sub_reactive", status: "active", items: { data: [{ price: { id: "price_1U4LUtAD4cJGS9CrkqXP6IxH" } }] } } },
    });
    check("3g. updated→active accepted", r3.status === 200, `status=${r3.status}`);
    check("3h. updated→active clears the clock", deletionScheduledAt() === null);
  }

  // ── 4. Delete: cancels subscription + purges every table, idempotent ──
  {
    // Fresh active subscription (inserted LAST with a future created_at so
    // getSubscriptionByMerchantId — ORDER BY created_at DESC — resolves to it)
    // so the stub cancel call is deterministic.
    const d = db();
    d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, stripe_customer_id, tier, status, created_at) VALUES (9, 1, 'sub_dr_delete', 'cus_delete', 'standard', 'active', datetime('now','+1 minute'))");
    d.close();
    stub.cancelCalls = [];

    const res = await post("/account/delete", {}, { Cookie: `session=${SESSION}` });
    const body = (await res.json()) as Record<string, unknown>;
    check("4a. POST /account/delete → 200", res.status === 200, `status=${res.status}`);
    check("4b. response {ok:true, deleted:true}", body.ok === true && body.deleted === true, JSON.stringify(body));
    check("4c. Stripe subscriptions.cancel called for sub_dr_delete",
      stub.cancelCalls.some(c => c.startsWith("sub_dr_delete?") && c.includes("cancel_at_period_end=false")),
      stub.cancelCalls.join(", "));

    check("4d. invoices purged", count("SELECT * FROM invoices WHERE merchant_id=1") === 0);
    check("4e. reminder_tasks purged", count("SELECT rt.* FROM reminder_tasks rt JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=1") === 0);
    check("4f. send_logs purged", count("SELECT sl.* FROM send_logs sl JOIN reminder_tasks rt ON sl.reminder_task_id=rt.id JOIN invoices i ON rt.invoice_id=i.id WHERE i.merchant_id=1") === 0);
    check("4g. subscriptions purged", count("SELECT * FROM subscriptions WHERE merchant_id=1") === 0);
    check("4h. unsubscribes purged", count("SELECT * FROM unsubscribes WHERE merchant_id=1") === 0);
    check("4i. sessions purged", count("SELECT * FROM sessions WHERE merchant_id=1") === 0);
    check("4j. stripe_connections purged", count("SELECT * FROM stripe_connections WHERE merchant_id=1") === 0);
    check("4k. oauth_tokens purged", count("SELECT * FROM oauth_tokens WHERE merchant_id=1") === 0);
    check("4l. inbound_replies purged", count("SELECT * FROM inbound_replies WHERE merchant_id=1") === 0);
    check("4m. subscription_events purged", count("SELECT * FROM subscription_events WHERE merchant_id=1") === 0);
    check("4n. merchant row gone", count("SELECT * FROM merchants WHERE id=1") === 0);
    check("4o. account layer gone (last merchant)", count("SELECT * FROM accounts WHERE id=1") === 0
      && count("SELECT * FROM account_sessions WHERE account_id=1") === 0
      && count("SELECT * FROM account_magic_links WHERE account_id=1") === 0
      && count("SELECT * FROM oauth_install_states WHERE account_id=1") === 0);

    // Session was purged → the same cookie is now unauthenticated.
    const r2 = await get("/account/export", { Cookie: `session=${SESSION}` });
    check("4p. session invalid after purge → 401", r2.status === 401, `status=${r2.status}`);
  }

  // ── 5. Stripe cancel FAILURE still purges ──
  {
    const d = db();
    d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (2, 'acct_dr_fail', 'fail@example.com', 'draft')");
    d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 2, datetime('now','+30 days'))", [SESSION2]);
    d.run("INSERT OR REPLACE INTO subscriptions (id, merchant_id, stripe_subscription_id, stripe_customer_id, tier, status) VALUES (20, 2, 'sub_cancel_fail', 'cus_fail', 'pro', 'active')");
    d.run("INSERT OR REPLACE INTO invoices (id, stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (201, 'in_fail_1', 2, 'Acme', 'acme@example.com', 9900, 'usd', '2026-08-01', 'overdue')");
    d.close();
    stub.cancelCalls = [];

    const res = await post("/account/delete", {}, { Cookie: `session=${SESSION2}` });
    const body = (await res.json()) as Record<string, unknown>;
    check("5a. delete with failing Stripe cancel still → 200", res.status === 200, `status=${res.status}`);
    check("5b. cancel was ATTEMPTED for sub_cancel_fail", stub.cancelCalls.some(c => c.startsWith("sub_cancel_fail?")), stub.cancelCalls.join(", "));
    check("5c. data still purged on cancel failure", count("SELECT * FROM merchants WHERE id=2") === 0
      && count("SELECT * FROM subscriptions WHERE merchant_id=2") === 0
      && count("SELECT * FROM invoices WHERE merchant_id=2") === 0);
  }

  // ── 6. Shared account is KEPT when not the last merchant ──
  {
    const d = db();
    d.run("INSERT OR REPLACE INTO accounts (id, email) VALUES (50, 'shared@example.com')");
    d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, account_id) VALUES (4, 'acct_dr_shared_a', 'a@example.com', 'draft', 50)");
    d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode, account_id) VALUES (5, 'acct_dr_shared_b', 'b@example.com', 'draft', 50)");
    d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES ('data-rights-session-4', 4, datetime('now','+30 days'))");
    d.close();
    stub.cancelCalls = [];
    const res = await post("/account/delete", {}, { Cookie: `session=data-rights-session-4` });
    check("6a. delete one merchant of a shared account → 200", res.status === 200, `status=${res.status}`);
    check("6b. merchant 4 gone", count("SELECT * FROM merchants WHERE id=4") === 0);
    check("6c. account KEPT (still owns merchant 5)", count("SELECT * FROM accounts WHERE id=50") === 1);
    check("6d. merchant 5 still linked to account 50", count("SELECT * FROM merchants WHERE id=5 AND account_id=50") === 1);
  }

  // ── 7. purgeMerchantData is idempotent (double call, same process) ──
  {
    const d = db();
    d.run("INSERT OR REPLACE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (3, 'acct_dr_unit', 'unit@example.com', 'draft')");
    d.run("INSERT OR REPLACE INTO invoices (id, stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (301, 'in_unit_1', 3, 'Acme', 'acme@example.com', 100, 'usd', '2026-08-01', 'overdue')");
    d.close();
    process.env.DB_PATH = DB_PATH;
    const appDb = getDb();
    purgeMerchantData(appDb, 3);
    purgeMerchantData(appDb, 3); // second call must be a safe no-op
    purgeMerchantData(appDb, 99999); // unknown id must also be a safe no-op
    check("7a. purgeMerchantData twice is a safe no-op", count("SELECT * FROM merchants WHERE id=3") === 0
      && count("SELECT * FROM invoices WHERE merchant_id=3") === 0);
  }

  console.log(`\nRESULTS: ${passed} passed, ${failures} failed`);
  stub.server.stop(true);
  if (failures > 0) process.exit(1);
}
main().catch((err) => {
  console.error("suite crashed:", err);
  stub.server.stop(true);
  process.exit(1);
});
