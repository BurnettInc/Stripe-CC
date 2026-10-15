/**
 * Daily owner revenue digest suite (feature/daily-owner-revenue-digest).
 *
 * Standalone in-process tests — NO real network, NO real sends. The pass reads
 * the app's own Stripe account through STRIPE_API_BASE, which points here at an
 * in-process stub; provider keys are deleted before the modules load so the
 * send path is the log-only stub.
 *
 * Coverage:
 *   (a) happy path: usd balance buckets summed, 24h window filtered (a charge
 *       older than 24h and a livemode=false charge are both excluded), net =
 *       payments − refunds − fees, active subscribers + MRR (monthly at face
 *       value, yearly / 12, test-mode and cancelled rows excluded), one event
 *       line per payment/refund/subscription-created, Bearer key used;
 *   (b) the digest is a no-op (no Stripe call, no send, no log row) when
 *       OWNER_NOTIFY_EMAIL is unset;
 *   (c) every Stripe call failing → no email, failed send_logs row, no throw;
 *   (d) ONE call failing → the digest still goes out, that line reads
 *       "unavailable" and the failure is listed in the body;
 *   (e) pure formatting guards: zero/missing data renders as $0.00 /
 *       "unavailable" (never invented), empty activity says so, and the body
 *       carries no CAN-SPAM footer (same as the other owner notifications);
 *   (f) a capped balance-history page is disclosed in the body;
 *   (g) plan-name mapping (price nickname wins, else the live $7/$15/$50/$100
 *       catalog, else a neutral "Paid plan").
 *
 * Run: cd app && bun run test-owner-digest.ts
 */
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-owner-digest-test.db";
const STRIPE_STUB_PORT = 3221;
const NOW = new Date("2026-10-12T09:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const DAY = 86400;

// ── Environment BEFORE any module import ──
process.env.DB_PATH = DB_PATH;
process.env.STRIPE_API_BASE = `http://localhost:${STRIPE_STUB_PORT}/v1`;
process.env.STRIPE_SECRET_KEY = "sk_test_stub_key";
process.env.OWNER_NOTIFY_EMAIL = "owner@example.com";
process.env.FROM_EMAIL = "test@example.com";
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
Bun.spawnSync(["rm", "-f", DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

// ── In-process Stripe stub ──
const stub = {
  calls: [] as string[],
  authHeaders: [] as string[],
  failPaths: [] as string[],
  balance: {} as Record<string, unknown>,
  history: {} as Record<string, unknown>,
  subs: {} as Record<string, unknown>,
  server: undefined as unknown as ReturnType<typeof Bun.serve>,
};
stub.server = Bun.serve({
  port: STRIPE_STUB_PORT,
  fetch(req) {
    const url = new URL(req.url);
    stub.calls.push(url.pathname + url.search);
    stub.authHeaders.push(req.headers.get("authorization") || "");
    for (const p of stub.failPaths) {
      if (url.pathname === p) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    }
    if (url.pathname === "/v1/balance") return Response.json(stub.balance);
    if (url.pathname === "/v1/balance/history") return Response.json(stub.history);
    if (url.pathname === "/v1/subscriptions") return Response.json(stub.subs);
    return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
  },
});
function resetStub(): void {
  stub.calls = [];
  stub.authHeaders = [];
  stub.failPaths = [];
}

// ── Dynamic imports (env above must be set first) ──
const { getDb } = await import("./src/db");
const digest = await import("./src/pipeline/owner-digest");
const sched = await import("./src/pipeline/scheduler");
const db = getDb();

function digestLogRows(): { type: string; status: string; provider_message: string }[] {
  return db.query("SELECT type, status, provider_message FROM send_logs WHERE type='owner_digest' ORDER BY id ASC")
    .all() as { type: string; status: string; provider_message: string }[];
}
function logLines(): string[] { return captured.slice(); }
const captured: string[] = [];
const deps = { now: () => NOW, log: (m: string) => captured.push(m) };

/** Fixture: one in-window charge, one in-window refund, one payout (ignored),
 *  one out-of-window charge, one test-mode charge. */
function seedStripe(): void {
  stub.balance = {
    available: [{ amount: 123456, currency: "usd" }, { amount: 999, currency: "eur" }],
    pending: [{ amount: 0, currency: "usd" }],
  };
  stub.history = {
    data: [
      { id: "txn_1", type: "charge", amount: 1500, fee: 74, net: 1426, currency: "usd", created: NOW_SECONDS - 3600, livemode: true },
      { id: "txn_2", type: "refund", amount: -1500, fee: 0, net: -1500, currency: "usd", created: NOW_SECONDS - 7200, livemode: true },
      { id: "txn_3", type: "payout", amount: -1500, fee: 0, currency: "usd", created: NOW_SECONDS - 10800, livemode: true },
      { id: "txn_4", type: "charge", amount: 5000, fee: 175, currency: "usd", created: NOW_SECONDS - 4000, livemode: false },
      { id: "txn_5", type: "charge", amount: 800, fee: 23, currency: "usd", created: NOW_SECONDS - 30 * 3600, livemode: true },
    ],
  };
  stub.subs = {
    data: [
      { id: "sub_1", status: "active", created: NOW_SECONDS - 3600, livemode: true, items: { data: [{ quantity: 1, price: { unit_amount: 1500, nickname: null, recurring: { interval: "month" } } }] } },
      { id: "sub_2", status: "active", created: NOW_SECONDS - 40 * DAY, livemode: true, items: { data: [{ quantity: 1, price: { unit_amount: 5000, nickname: null, recurring: { interval: "year" } } }] } },
      { id: "sub_3", status: "active", created: NOW_SECONDS - 3600, livemode: false, items: { data: [{ quantity: 1, price: { unit_amount: 10000, nickname: null, recurring: { interval: "month" } } }] } },
      { id: "sub_4", status: "canceled", created: NOW_SECONDS - 3600, livemode: true, items: { data: [{ quantity: 1, price: { unit_amount: 1500, nickname: null, recurring: { interval: "month" } } }] } },
    ],
  };
}

// ── (a) happy path ──
resetStub();
seedStripe();
captured.length = 0;
const ok = await digest.runDailyOwnerDigest(db, deps);
check("(a) pass succeeds", ok.success === true, ok.message);
check("(a) not skipped", ok.skipped !== true);
const d = ok.data!;
check("(a) available sums usd only", d.availableCents === 123456, String(d.availableCents));
check("(a) pending parsed", d.pendingCents === 0, String(d.pendingCents));
check("(a) payments in window", d.paymentsCents === 1500, String(d.paymentsCents));
check("(a) refunds in window", d.refundsCents === 1500, String(d.refundsCents));
check("(a) fees summed", d.feesCents === 74, String(d.feesCents));
check("(a) net = payments - refunds - fees", d.netCents === -74, String(d.netCents));
check("(a) test-mode + cancelled subs excluded", d.activeSubscribers === 2, String(d.activeSubscribers));
check("(a) MRR monthly + yearly/12", d.mrrCents === 1500 + 417, String(d.mrrCents));
check("(a) one event per payment/refund/new sub", d.events.length === 3, JSON.stringify(d.events));
check("(a) payment event line", d.events.some((e) => e.includes("· Payment received · $15.00")), JSON.stringify(d.events));
check("(a) refund event line", d.events.some((e) => e.includes("· Refund · $15.00")), JSON.stringify(d.events));
check("(a) subscription event line", d.events.some((e) => e.includes("Pro subscription created · $15.00")), JSON.stringify(d.events));
check("(a) payout is not revenue", !d.events.some((e) => e.includes("payout")), JSON.stringify(d.events));
check("(a) three read-only GETs", stub.calls.length === 3, JSON.stringify(stub.calls));
check("(a) subscriptions request is status=active&limit=100", stub.calls.some((c) => c.startsWith("/v1/subscriptions?status=active&limit=100")), JSON.stringify(stub.calls));
check("(a) history request is limit=100", stub.calls.some((c) => c === "/v1/balance/history?limit=100"), JSON.stringify(stub.calls));
check("(a) Bearer key used", stub.authHeaders.every((h) => h === "Bearer sk_test_stub_key"), JSON.stringify(stub.authHeaders));

const body = digest.buildOwnerDigestEmail(d).body;
check("(a) subject carries the date", digest.buildOwnerDigestEmail(d).subject === "Daily revenue — 2026-10-12", digest.buildOwnerDigestEmail(d).subject);
check("(a) body: balance line", body.includes("Balance available:   $1,234.56"), body);
check("(a) body: pending line", body.includes("Balance pending:     $0.00"), body);
check("(a) body: net line", body.includes("Revenue last 24h:    -$0.74"), body);
check("(a) body: subscribers + MRR", body.includes("Active subscribers:  2") && body.includes("MRR:                 $19.17/mo"), body);
check("(a) body: breakdown line", body.includes("(last 24h: $15.00 payments − $15.00 refunds − $0.74 fees)"), body);
check("(a) body: no CAN-SPAM footer", !/unsubscribe/i.test(body), body);
check("(a) body: internal-only note", body.includes("Internal owner alert; never sent to a customer."), body);

const rows = digestLogRows();
check("(a) send logged as owner_digest success", rows.length === 1 && rows[0].status === "success", JSON.stringify(rows));
check("(a) log line parses like the other passes",
  logLines().some((l) => l.startsWith("[scheduler] owner-digest pass: 2 subscriber(s), MRR $19.17/mo, net 24h -$0.74, 3 event(s) — sent")),
  JSON.stringify(logLines()));

// ── (b) OWNER_NOTIFY_EMAIL unset → no network, no send ──
resetStub();
seedStripe();
captured.length = 0;
delete process.env.OWNER_NOTIFY_EMAIL;
const skip = await digest.runDailyOwnerDigest(db, deps);
check("(b) skipped when owner email unset", skip.skipped === true && skip.success === false, skip.message);
check("(b) no Stripe call made", stub.calls.length === 0, JSON.stringify(stub.calls));
check("(b) no send_logs row added", digestLogRows().length === 1, JSON.stringify(digestLogRows()));
check("(b) skip logged", logLines().some((l) => l.includes("skipped — OWNER_NOTIFY_EMAIL not set")), JSON.stringify(logLines()));
process.env.OWNER_NOTIFY_EMAIL = "owner@example.com";

// ── (c) every Stripe call fails → no email, failure logged, no throw ──
resetStub();
stub.failPaths = ["/v1/balance", "/v1/balance/history", "/v1/subscriptions"];
captured.length = 0;
const allFail = await digest.runDailyOwnerDigest(db, deps);
check("(c) returns failure without throwing", allFail.success === false && allFail.skipped === true, allFail.message);
check("(c) no digest emailed", digestLogRows().length === 2, JSON.stringify(digestLogRows()));
check("(c) failure recorded in send_logs", digestLogRows()[1].status === "failed" && allFail.message.includes("all Stripe calls failed"), allFail.message);
check("(c) log line names the failures", logLines().some((l) => l.includes("[scheduler] owner-digest pass: no digest sent")), JSON.stringify(logLines()));

// ── (d) one dead call degrades that line only ──
resetStub();
seedStripe();
stub.failPaths = ["/v1/subscriptions"];
captured.length = 0;
const partial = await digest.runDailyOwnerDigest(db, deps);
check("(d) digest still sent", partial.success === true, partial.message);
check("(d) subscribers line unavailable", partial.data!.activeSubscribers === null && partial.data!.mrrCents === null);
const partialBody = digest.buildOwnerDigestEmail(partial.data!).body;
check("(d) body says unavailable", partialBody.includes("Active subscribers:  unavailable") && partialBody.includes("MRR:                 unavailable"), partialBody);
check("(d) body lists the failure", partialBody.includes("Unavailable this run: /v1/subscriptions?status=active&limit=100 → HTTP 500"), partialBody);
check("(d) activity still reported", partialBody.includes("Payment received · $15.00"), partialBody);

// ── (e) pure formatting guards for zero / missing data ──
const empty = digest.buildOwnerDigestEmail({
  date: "2026-10-12", windowEnd: "2026-10-12 09:00 UTC",
  availableCents: 0, pendingCents: 0, netCents: 0, paymentsCents: 0, refundsCents: 0, feesCents: 0,
  activeSubscribers: 0, mrrCents: 0, events: [], historyTruncated: false, errors: [],
});
check("(e) zeros render as $0.00", empty.body.includes("Balance available:   $0.00") && empty.body.includes("Revenue last 24h:    $0.00") && empty.body.includes("MRR:                 $0.00/mo"), empty.body);
check("(e) no activity is stated, not invented", empty.body.includes("(no payments, refunds or new subscriptions in the last 24h)"), empty.body);
check("(e) unavailable renders honestly", digest.buildOwnerDigestEmail({ ...emptyDataNulls() }).body.includes("Balance available:   unavailable"));
check("(e) money helper negative", digest.formatUsd(-74) === "-$0.74", digest.formatUsd(-74));

// ── (f) capped history page is disclosed ──
resetStub();
seedStripe();
const cappedRows = Array.from({ length: 100 }, (_, i) => ({
  id: `txn_${i}`, type: "charge", amount: 100, fee: 3, currency: "usd", created: NOW_SECONDS - 60 - i, livemode: true,
}));
stub.history = { data: cappedRows };
captured.length = 0;
const capped = await digest.runDailyOwnerDigest(db, deps);
check("(f) truncated flag set", capped.data!.historyTruncated === true, JSON.stringify(capped.data!.historyTruncated));
check("(f) body discloses the cap", digest.buildOwnerDigestEmail(capped.data!).body.includes("100 most recent balance transactions"), digest.buildOwnerDigestEmail(capped.data!).body);

// ── (g) plan-name mapping ──
check("(g) nickname wins", digest.planNameForPrice({ unit_amount: 1500, nickname: "Pro Annual", recurring: { interval: "year" } }) === "Pro Annual");
check("(g) $7/$50 → Standard", digest.planNameForPrice({ unit_amount: 700, recurring: { interval: "month" } }) === "Standard" && digest.planNameForPrice({ unit_amount: 5000, recurring: { interval: "year" } }) === "Standard");
check("(g) $15/$100 → Pro", digest.planNameForPrice({ unit_amount: 1500, recurring: { interval: "month" } }) === "Pro" && digest.planNameForPrice({ unit_amount: 10000, recurring: { interval: "year" } }) === "Pro");
check("(g) unknown amount is neutral", digest.planNameForPrice({ unit_amount: 1234, recurring: { interval: "month" } }) === "Paid plan");

// ── (h) scheduler wiring: the pass is registered under the owner-digest name ──
const cfg = sched.DEFAULT_SCHEDULER_CONFIG;
check("(h) 24h interval registered", cfg.ownerDigestIntervalMs === 86400000, String(cfg.ownerDigestIntervalMs));
check("(h) exported from scheduler for manual runs", typeof sched.runDailyOwnerDigest === "function");

stub.server.stop(true);
db.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/** Every source unavailable — the honest "unavailable" rendering path. */
function emptyDataNulls(): Parameters<typeof digest.buildOwnerDigestEmail>[0] {
  return {
    date: "2026-10-12", windowEnd: "2026-10-12 09:00 UTC",
    availableCents: null, pendingCents: null, netCents: null, paymentsCents: null, refundsCents: null, feesCents: null,
    activeSubscribers: null, mrrCents: null, events: [], historyTruncated: false, errors: [],
  };
}
