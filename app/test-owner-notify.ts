/**
 * Owner notification suite — signup + paid-subscription emails
 * (owner request 2026-08-12; feature: owner-notify-emails).
 *
 * The backend emails the OWNER (OWNER_NOTIFY_EMAIL) via the product's Resend
 * sender whenever a merchant connects Stripe or subscribes to a paid plan
 * (+ cancellation). Dev/test merchants are excluded; OWNER_NOTIFY_EMAIL unset
 * disables notifications entirely.
 *
 * Coverage:
 *   (a) Module-level (in-process, log-only stub — provider keys deleted):
 *       notifyOwnerStripeConnect / notifyOwnerPaidSubscription /
 *       notifyOwnerCancelledSubscription produce the expected subject lines
 *       and a send_logs row (type 'owner_notification') for real merchants;
 *       dev/test merchants (dev_pro=1, acct_default, *.local, unknown) are
 *       skipped with no row; OWNER_NOTIFY_EMAIL unset → no-op (skipped, no
 *       row, no crash).
 *   (b) HTTP against the booted server (OWNER_NOTIFY_EMAIL set, log-only
 *       mode): /billing checkout.session.completed fires
 *       "💳 Paid subscription — <email> subscribed to <Plan> ($x/mo)" for a
 *       real merchant, nothing for dev/placeholder merchants, no duplicate
 *       on idempotent replay; customer.subscription.deleted fires
 *       "❌ <email> canceled <Plan>" for a real merchant, nothing for dev.
 *   (c) HTTP against a SECOND isolated server booted WITHOUT
 *       OWNER_NOTIFY_EMAIL: same checkout for a real merchant produces NO
 *       owner_notification row (disabled, no crash).
 *
 * The connect notification itself is covered in (a): the OAuth callback's
 * accounts.retrieve cannot be pointed at a stub (this Stripe SDK version
 * hard-codes api.stripe.com — see DEFAULT_BASE_ADDRESSES), so the callback
 * path is verified only as a regression (missing-account → 302, no Stripe
 * call) exactly like test-oauth-session.ts does.
 *
 * Run:
 *   bash /tmp/run-suite.sh owner-notify
 * (boots an isolated server on :3100 with a fresh DB, provider keys stripped,
 * OWNER_NOTIFY_EMAIL=owner@example.com, STRIPE_SECRET_KEY=sk_test_stub so no
 * real Stripe call can escape. The test script boots the :3101 "unset" server
 * itself.)
 */
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

// ── Defensive: never let an in-process send reach a real provider ──
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-owner-notify.db";
const OWNER = "owner@example.com";

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function q(sql: string, ...args: unknown[]): unknown[] {
  const d = new Database(DB_PATH);
  const rows = d.query(sql).all(...args);
  d.close();
  return rows;
}
function q1(sql: string, ...args: unknown[]): Record<string, unknown> | null {
  const d = new Database(DB_PATH);
  const row = d.query(sql).get(...args) as Record<string, unknown> | null;
  d.close();
  return row;
}
/** send_logs rows for owner notifications whose message contains a marker. */
function ownerLogs(marker: string): Array<Record<string, unknown>> {
  return q(
    "SELECT type, status, provider_message FROM send_logs WHERE type='owner_notification' AND provider_message LIKE ? ORDER BY id",
    `%${marker}%`
  ) as Array<Record<string, unknown>>;
}
function countOwnerLogs(marker: string): number {
  return ownerLogs(marker).length;
}

// ══════════════════════════════════════════════════════════════════════════
// (a) Module-level tests — in-process, against the shared test DB.
// ══════════════════════════════════════════════════════════════════════════
process.env.DB_PATH = DB_PATH;
const { getDb } = await import("./src/db");
const db = getDb();
const {
  notifyOwnerStripeConnect,
  notifyOwnerPaidSubscription,
  notifyOwnerCancelledSubscription,
  isDevOrTestMerchant,
} = await import("./src/pipeline/owner-notify");

// Seed merchants (explicit ids so HTTP assertions stay deterministic).
// Merchant 1 (acct_default) is auto-created by ensureDefaultMerchant on the
// server's first request — seed the real/dev/local ones here.
db.run(
  "INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode, dev_pro) VALUES (2, 'acct_owner_real', 'realowner@example.com', 'draft', 0)"
);
db.run(
  "INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode, dev_pro) VALUES (3, 'acct_owner_dev', 'dev@example.com', 'full', 1)"
);
db.run(
  "INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode, dev_pro) VALUES (4, 'acct_owner_local', 'merchant@collections-copilot.local', 'draft', 0)"
);

// ── a1: connect notification fires for a real merchant (stub send) ──
process.env.OWNER_NOTIFY_EMAIL = OWNER;
{
  const before = countOwnerLogs("New signup");
  const res = await notifyOwnerStripeConnect(db, 2, "acct_owner_real", "account-holder@example.com");
  const after = countOwnerLogs("New signup");
  const last = ownerLogs("New signup").at(-1) as Record<string, unknown> | undefined;
  check(
    "a1: connect → owner notification sent + logged",
    res.success === true && res.skipped !== true && after === before + 1 &&
      String(last?.provider_message).includes("🎉 New signup — account-holder@example.com connected Stripe"),
    JSON.stringify({ res, after, last })
  );
}

// ── a2: account email preferred over merchant email in the subject ──
{
  const rows = ownerLogs("New signup");
  const last = rows.at(-1) as Record<string, unknown>;
  check(
    "a2: subject uses the Stripe account email",
    String(last.provider_message).includes("account-holder@example.com") &&
      !String(last.provider_message).includes("realowner@example.com"),
    JSON.stringify(last)
  );
}

// ── a3: fallback to merchant email when no account email ──
{
  const before = countOwnerLogs("New signup — realowner@example.com");
  await notifyOwnerStripeConnect(db, 2, "acct_owner_real", null);
  const after = countOwnerLogs("New signup — realowner@example.com");
  check("a3: merchant email fallback works", after === before + 1, `${before}→${after}`);
}

// ── a4: dev_pro=1 merchant → skipped, no row ──
{
  const before = countOwnerLogs("New signup");
  const res = await notifyOwnerStripeConnect(db, 3, "acct_owner_dev", "dev@example.com");
  const after = countOwnerLogs("New signup");
  check("a4: dev_pro=1 merchant skipped", res.skipped === true && after === before, JSON.stringify({ res, after }));
}

// ── a5: acct_default placeholder merchant → skipped ──
{
  const res = await notifyOwnerStripeConnect(db, 1, "acct_default", "default@collections-copilot.local");
  check("a5: acct_default merchant skipped", res.skipped === true, JSON.stringify(res));
}

// ── a6: .local email merchant → skipped ──
{
  const before = countOwnerLogs("New signup");
  const res = await notifyOwnerStripeConnect(db, 4, "acct_owner_local", "merchant@collections-copilot.local");
  const after = countOwnerLogs("New signup");
  check("a6: .local merchant skipped", res.skipped === true && after === before, JSON.stringify({ res, after }));
}

// ── a7: unknown merchant → skipped quietly ──
{
  const res = await notifyOwnerStripeConnect(db, 9999, "acct_unknown", "x@example.com");
  check("a7: unknown merchant skipped", res.skipped === true && res.success === false, JSON.stringify(res));
}

// ── a8: paid subscription notification ──
{
  const before = countOwnerLogs("Paid subscription");
  const res = await notifyOwnerPaidSubscription(db, 2, "pro", "cus_owner_x");
  const after = countOwnerLogs("Paid subscription");
  const last = ownerLogs("Paid subscription").at(-1) as Record<string, unknown>;
  check(
    "a8: paid sub → 💳 subject with plan + price",
    res.success === true && after === before + 1 &&
      String(last.provider_message).includes("💳 Paid subscription — realowner@example.com subscribed to Pro ($15/mo)"),
    JSON.stringify({ res, last })
  );
}

// ── a9: paid subscription — Standard label ──
{
  await notifyOwnerPaidSubscription(db, 2, "standard", null);
  const rows = ownerLogs("Paid subscription — realowner@example.com subscribed to Standard ($7/mo)");
  check("a9: Standard ($7/mo) label", rows.length === 1, JSON.stringify(rows));
}

// ── a10: paid subscription — dev merchant skipped ──
{
  const before = countOwnerLogs("Paid subscription");
  const res = await notifyOwnerPaidSubscription(db, 3, "pro", "cus_owner_dev");
  const after = countOwnerLogs("Paid subscription");
  check("a10: paid sub dev merchant skipped", res.skipped === true && after === before, JSON.stringify({ res, after }));
}

// ── a11: cancellation notification ──
{
  const before = countOwnerLogs("canceled");
  const res = await notifyOwnerCancelledSubscription(db, 2, "pro");
  const after = countOwnerLogs("canceled");
  const last = ownerLogs("canceled").at(-1) as Record<string, unknown>;
  check(
    "a11: cancellation → ❌ subject",
    res.success === true && after === before + 1 &&
      String(last.provider_message).includes("❌ realowner@example.com canceled Pro"),
    JSON.stringify({ res, last })
  );
}

// ── a12: OWNER_NOTIFY_EMAIL unset → no-op, no row, no crash ──
{
  delete process.env.OWNER_NOTIFY_EMAIL;
  const before = countOwnerLogs("Paid subscription");
  const res = await notifyOwnerPaidSubscription(db, 2, "pro", "cus_owner_x");
  const after = countOwnerLogs("Paid subscription");
  check(
    "a12: OWNER_NOTIFY_EMAIL unset → skipped no-op",
    res.skipped === true && after === before && res.success === false,
    JSON.stringify({ res, after })
  );
  const resConnect = await notifyOwnerStripeConnect(db, 2, "acct_owner_real", "x@example.com");
  check("a12b: connect notify unset → skipped no-op", resConnect.skipped === true, JSON.stringify(resConnect));
  process.env.OWNER_NOTIFY_EMAIL = OWNER;
}

// ── a13: isDevOrTestMerchant matrix ──
{
  const mk = (stripe_account_id: string, email: string, dev_pro: number) => ({ stripe_account_id, email, dev_pro } as never);
  check("a13: dev_pro=1 is dev/test", isDevOrTestMerchant(mk("acct_x", "x@example.com", 1)));
  check("a13: acct_default is dev/test", isDevOrTestMerchant(mk("acct_default", "x@example.com", 0)));
  check("a13: .local is dev/test", isDevOrTestMerchant(mk("acct_x", "x@collections-copilot.local", 0)));
  check("a13: null merchant is dev/test", isDevOrTestMerchant(null));
  check("a13: real merchant is NOT dev/test", !isDevOrTestMerchant(mk("acct_owner_real", "realowner@example.com", 0)));
}

// ══════════════════════════════════════════════════════════════════════════
// (b) HTTP tests against the booted :3100 server (OWNER_NOTIFY_EMAIL set).
// ══════════════════════════════════════════════════════════════════════════
async function postBilling(body: unknown): Promise<Response> {
  return fetch(`${BASE}/billing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function checkoutEvent(subId: string, merchantId: number, tier: string, customerId = `cus_${subId}`) {
  return {
    type: "checkout.session.completed",
    data: { object: { id: `cs_${subId}`, subscription: subId, customer: customerId, metadata: { merchant_id: String(merchantId), tier } } },
  };
}
function cancelEvent(subId: string) {
  return { type: "customer.subscription.deleted", data: { object: { id: subId } } };
}

// Clear owner-notification rows from the module section so (b) counts fresh.
{
  const d = new Database(DB_PATH);
  d.run("DELETE FROM send_logs WHERE type='owner_notification'");
  d.close();
}

// ── b1: checkout.session.completed → owner paid-subscription email ──
{
  const before = countOwnerLogs("Paid subscription");
  const res = await postBilling(checkoutEvent("sub_owner_http", 2, "pro"));
  const body = (await res.json()) as { received?: boolean; action?: string };
  const after = countOwnerLogs("Paid subscription");
  const rows = ownerLogs("Paid subscription — realowner@example.com subscribed to Pro ($15/mo)");
  check(
    "b1: billing webhook → 200 + 💳 owner email",
    res.status === 200 && body.received === true && after === before + 1 && rows.length === 1,
    JSON.stringify({ status: res.status, body, after, rows })
  );
}

// ── b2: dev merchant checkout → no owner email (sub still created) ──
{
  const before = countOwnerLogs("Paid subscription");
  const res = await postBilling(checkoutEvent("sub_owner_dev", 3, "standard"));
  const after = countOwnerLogs("Paid subscription");
  const sub = q1("SELECT id FROM subscriptions WHERE stripe_subscription_id='sub_owner_dev'");
  check("b2: dev checkout → sub created, no owner email", res.status === 200 && sub !== null && after === before, JSON.stringify({ status: res.status, after }));
}

// ── b3: .local merchant checkout → no owner email ──
{
  const before = countOwnerLogs("Paid subscription");
  const res = await postBilling(checkoutEvent("sub_owner_local", 4, "standard"));
  const after = countOwnerLogs("Paid subscription");
  check("b3: .local checkout → no owner email", res.status === 200 && after === before, JSON.stringify({ status: res.status, after }));
}

// ── b4: idempotent replay of the same checkout → no duplicate email ──
{
  const before = countOwnerLogs("Paid subscription — realowner@example.com subscribed to Pro ($15/mo)");
  const res = await postBilling(checkoutEvent("sub_owner_http", 2, "pro"));
  const after = countOwnerLogs("Paid subscription — realowner@example.com subscribed to Pro ($15/mo)");
  check("b4: replay → no second owner email", res.status === 200 && after === before, JSON.stringify({ status: res.status, after, before }));
}

// ── b5: customer.subscription.deleted → cancellation owner email ──
{
  const before = countOwnerLogs("canceled");
  const res = await postBilling(cancelEvent("sub_owner_http"));
  const after = countOwnerLogs("canceled");
  const rows = ownerLogs("❌ realowner@example.com canceled Pro");
  check("b5: cancellation → ❌ owner email", res.status === 200 && after === before + 1 && rows.length === 1, JSON.stringify({ status: res.status, after, rows }));
}

// ── b6: dev merchant cancellation → no owner email ──
{
  const before = countOwnerLogs("canceled");
  const res = await postBilling(cancelEvent("sub_owner_dev"));
  const after = countOwnerLogs("canceled");
  check("b6: dev cancellation → no owner email", res.status === 200 && after === before, JSON.stringify({ status: res.status, after }));
}

// ── b7: OAuth callback missing-account regression (no Stripe call) ──
{
  const res = await fetch(`${BASE}/stripe/oauth/callback`, { redirect: "manual" });
  const loc = res.headers.get("location") || "";
  check("b7: callback missing account → 302 to dashboard error", res.status === 302 && loc.includes("error=missing_account"), `${res.status} ${loc}`);
}

// ══════════════════════════════════════════════════════════════════════════
// (c) HTTP against a second server booted WITHOUT OWNER_NOTIFY_EMAIL.
// ══════════════════════════════════════════════════════════════════════════
{
  // Kill any stale :3101 server, boot a fresh one with its own DB.
  const stale = (await Bun.$`lsof -t -iTCP:3101 -sTCP:LISTEN 2>/dev/null`.text().catch(() => "")).trim();
  for (const pid of stale.split(/\s+/).filter(Boolean)) {
    process.kill(Number(pid), "SIGKILL").catch(() => {});
  }
  await Bun.sleep(500);
  const unsetDb = "/tmp/cc-owner-notify-unset.db";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(unsetDb + suffix, { force: true });
  const server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: "/home/team/shared/repo/app",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "OWNER_NOTIFY_EMAIL")),
      DB_PATH: unsetDb,
      PORT: "3101",
      // No OWNER_NOTIFY_EMAIL on purpose (filtered above).
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://localhost:3101/health");
      if (r.ok) { up = true; break; }
    } catch { /* booting */ }
    await Bun.sleep(500);
  }
  check("c0: second server (no OWNER_NOTIFY_EMAIL) boots", up, "");
  if (up) {
    // Seed a real merchant + a checkout on the unset server's DB.
    const d = new Database(unsetDb);
    d.run("INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode, dev_pro) VALUES (2, 'acct_owner_real', 'realowner@example.com', 'draft', 0)");
    d.close();
    const res = await fetch("http://localhost:3101/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkoutEvent("sub_unset_env", 2, "pro")),
    });
    const d2 = new Database(unsetDb);
    const n = (d2.query("SELECT COUNT(*) AS n FROM send_logs WHERE type='owner_notification'").get() as { n: number }).n;
    d2.close();
    check("c1: checkout without OWNER_NOTIFY_EMAIL → 200, no owner email, no crash", res.status === 200 && n === 0, `status=${res.status} rows=${n}`);
  }
  server.kill();
}

console.log(failures === 0 ? "\nALL OWNER-NOTIFY CHECKS PASSED" : `\n${failures} OWNER-NOTIFY CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
