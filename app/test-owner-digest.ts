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
 *   (h) scheduler wiring (24h interval, exported for manual runs).
 *   (i) free-trial merchants (owner visibility 2026-10-26): only real
 *       merchants inside the strict 30-day window are listed (exactly 30 days
 *       is OUT, dev_pro / .local placeholders and active subscribers are
 *       excluded), days-left is ceil()'d (a 5-day-old merchant reads "25 days
 *       left", a 29-day-old one "1 day left"), oldest first, one body line per
 *       merchant "email · N days left", the section is ALWAYS rendered even at
 *       zero, and the scheduled log line carries the trial count.
 *
 * Run: cd app && bun run test-owner-digest.ts
 */
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-owner-digest-test.db";
const STRIPE_STUB_PORT = 3221;
const NOW = new Date("2026-10-12T09:00:00Z");
/** The pass clock. Mutable so the suite can move time forward: the durable
 *  once-per-24h guard compares the send_logs ledger against this clock, and the
 *  Stripe stub fixtures are generated relative to it, so advancing it keeps every
 *  relative-time assertion intact while crossing the 24h window. */
let clockMs = NOW.getTime();
const nowDate = () => new Date(clockMs);
/** Stub fixtures are expressed relative to the pass clock (epoch seconds). */
const nowSeconds = () => Math.floor(clockMs / 1000);
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

/** Move the pass clock forward. Each scenario below is a separate "boot" against
 *  the same DB, so the durable 24h guard must be crossed between them. */
function advanceClock(ms: number): void { clockMs += ms; }

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
const deps = { now: nowDate, log: (m: string) => captured.push(m) };

/** Fixture: one in-window charge, one in-window refund, one payout (ignored),
 *  one out-of-window charge, one test-mode charge. */
function seedStripe(): void {
  stub.balance = {
    available: [{ amount: 123456, currency: "usd" }, { amount: 999, currency: "eur" }],
    pending: [{ amount: 0, currency: "usd" }],
  };
  stub.history = {
    data: [
      { id: "txn_1", type: "charge", amount: 1500, fee: 74, net: 1426, currency: "usd", created: nowSeconds() - 3600, livemode: true },
      { id: "txn_2", type: "refund", amount: -1500, fee: 0, net: -1500, currency: "usd", created: nowSeconds() - 7200, livemode: true },
      { id: "txn_3", type: "payout", amount: -1500, fee: 0, currency: "usd", created: nowSeconds() - 10800, livemode: true },
      { id: "txn_4", type: "charge", amount: 5000, fee: 175, currency: "usd", created: nowSeconds() - 4000, livemode: false },
      { id: "txn_5", type: "charge", amount: 800, fee: 23, currency: "usd", created: nowSeconds() - 30 * 3600, livemode: true },
    ],
  };
  stub.subs = {
    data: [
      { id: "sub_1", status: "active", created: nowSeconds() - 3600, livemode: true, items: { data: [{ quantity: 1, price: { unit_amount: 1500, nickname: null, recurring: { interval: "month" } } }] } },
      { id: "sub_2", status: "active", created: nowSeconds() - 40 * DAY, livemode: true, items: { data: [{ quantity: 1, price: { unit_amount: 5000, nickname: null, recurring: { interval: "year" } } }] } },
      { id: "sub_3", status: "active", created: nowSeconds() - 3600, livemode: false, items: { data: [{ quantity: 1, price: { unit_amount: 10000, nickname: null, recurring: { interval: "month" } } }] } },
      { id: "sub_4", status: "canceled", created: nowSeconds() - 3600, livemode: true, items: { data: [{ quantity: 1, price: { unit_amount: 1500, nickname: null, recurring: { interval: "month" } } }] } },
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
  logLines().some((l) => l.startsWith("[scheduler] owner-digest pass: 2 subscriber(s), MRR $19.17/mo, net 24h -$0.74, 3 event(s), 0 in trial — sent")),
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
advanceClock(25 * 3600 * 1000); // cross the durable 24h window
resetStub();
stub.failPaths = ["/v1/balance", "/v1/balance/history", "/v1/subscriptions"];
captured.length = 0;
const allFail = await digest.runDailyOwnerDigest(db, deps);
check("(c) returns failure without throwing", allFail.success === false && allFail.skipped === true, allFail.message);
check("(c) no digest emailed", digestLogRows().length === 2, JSON.stringify(digestLogRows()));
check("(c) failure recorded in send_logs", digestLogRows()[1].status === "failed" && allFail.message.includes("all Stripe calls failed"), allFail.message);
check("(c) log line names the failures", logLines().some((l) => l.includes("[scheduler] owner-digest pass: no digest sent")), JSON.stringify(logLines()));

// ── (d) one dead call degrades that line only ──
advanceClock(25 * 3600 * 1000); // cross the durable 24h window
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
  activeSubscribers: 0, mrrCents: 0, events: [], trialMerchants: [], trialExpirySends: 0, historyTruncated: false, errors: [],
});
check("(e) zeros render as $0.00", empty.body.includes("Balance available:   $0.00") && empty.body.includes("Revenue last 24h:    $0.00") && empty.body.includes("MRR:                 $0.00/mo"), empty.body);
check("(e) no activity is stated, not invented", empty.body.includes("(no payments, refunds or new subscriptions in the last 24h)"), empty.body);
check("(e) trial section is ALWAYS present (explicit zero, never omitted)",
  empty.body.includes("Merchants in free trial (0):") && empty.body.includes("(none — no merchant is inside the 30-day trial right now)"), empty.body);
check("(e) unavailable renders honestly", digest.buildOwnerDigestEmail({ ...emptyDataNulls() }).body.includes("Balance available:   unavailable"));
check("(e) money helper negative", digest.formatUsd(-74) === "-$0.74", digest.formatUsd(-74));

// ── (f) capped history page is disclosed ──
advanceClock(25 * 3600 * 1000); // cross the durable 24h window
resetStub();
seedStripe();
const cappedRows = Array.from({ length: 100 }, (_, i) => ({
  id: `txn_${i}`, type: "charge", amount: 100, fee: 3, currency: "usd", created: nowSeconds() - 60 - i, livemode: true,
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

// ── (i) free-trial merchants (owner visibility 2026-10-26) ──
// NEW merchant rows are aged relative to SQLite's OWN clock
// (datetime('now','-N days')) because isWithinFreeTrial compares created_at
// against datetime('now') — the injected NOW above only drives the Stripe 24h
// window. That keeps the boundary assertions exact without faking time.
function addMerchant(email: string, ageDays: number): number {
  const info = db.run(
    "INSERT INTO merchants (stripe_account_id, email, trust_mode, created_at) VALUES (?, ?, 'draft', datetime('now', ?))",
    [`acct_trial_${email.replace(/[^a-z0-9]/gi, "_")}`, email, `-${ageDays} days`]
  );
  return Number(info.lastInsertRowid);
}
addMerchant("trial5@example.com", 5); // 25 days left
addMerchant("trial1@example.com", 29); // 1 day left (singular)
addMerchant("trial-done@example.com", 31); // expired
addMerchant("trial-boundary@example.com", 30); // exactly 30 days → OUT (strict <)
addMerchant("devonly@install.local", 2); // .local placeholder → dev/test
const trialDevPro = addMerchant("devpro@example.com", 2); // dev_pro flag → excluded
db.run("UPDATE merchants SET dev_pro = 1 WHERE id = ?", [trialDevPro]);
const trialPaying = addMerchant("paying@example.com", 2); // active subscriber → not "in trial"
db.run(
  "INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_trial_paying', 'pro', 'active')",
  [trialPaying]
);

advanceClock(25 * 3600 * 1000); // cross the durable 24h window
resetStub();
seedStripe();
captured.length = 0;
const trialRun = await digest.runDailyOwnerDigest(db, deps);
const trials = trialRun.data!.trialMerchants;
check("(i) digest still sent with the trial section", trialRun.success === true, trialRun.message);
check(
  "(i) only real in-trial merchants listed",
  trials.length === 2 && trials.every((m) => m.email === "trial5@example.com" || m.email === "trial1@example.com"),
  JSON.stringify(trials)
);
check("(i) days-left = 25 for a 5-day-old merchant", trials.find((m) => m.email === "trial5@example.com")?.daysLeft === 25, JSON.stringify(trials));
check("(i) days-left = 1 for a 29-day-old merchant", trials.find((m) => m.email === "trial1@example.com")?.daysLeft === 1, JSON.stringify(trials));
check("(i) oldest first — closest to expiring leads", trials[0]?.email === "trial1@example.com", JSON.stringify(trials));
check("(i) exactly 30 days is OUT (strict boundary)", !trials.some((m) => m.email === "trial-boundary@example.com"), JSON.stringify(trials));
check("(i) expired merchant not listed", !trials.some((m) => m.email === "trial-done@example.com"), JSON.stringify(trials));
check(
  "(i) dev/test placeholders + dev_pro excluded",
  !trials.some((m) => m.email.endsWith(".local") || m.email === "devpro@example.com"),
  JSON.stringify(trials)
);
check("(i) an active subscriber is never 'in trial'", !trials.some((m) => m.email === "paying@example.com"), JSON.stringify(trials));
const trialBody = digest.buildOwnerDigestEmail(trialRun.data!).body;
check("(i) body: header carries the count", trialBody.includes("Merchants in free trial (2):"), trialBody);
check(
  "(i) body: one line per merchant 'email · N days left'",
  trialBody.includes("trial5@example.com · 25 days left") && trialBody.includes("trial1@example.com · 1 day left"),
  trialBody
);
check(
  "(i) log line carries the trial count",
  logLines().some((l) => l.includes("3 event(s), 2 in trial — sent")),
  JSON.stringify(logLines())
);

// ── (j) DURABLE once-per-24h guard (owner-digest double-send fix, 2026-10-29) ──
// The production defect this covers: send_logs id 137 @ 2026-10-28 20:54:41 and
// id 138 @ 2026-10-29 16:12:23 — one digest per Railway deploy, 19h apart,
// because the "already sent today" state lived only in the process's timer.
// Every call below is ONE PROCESS BOOT against the SAME DB; nothing here depends
// on process memory or on a timer surviving.
function digestRowsFull(): { id: number; status: string; created_at: string }[] {
  return db
    .query("SELECT id, status, created_at FROM send_logs WHERE type='owner_digest' ORDER BY id ASC")
    .all() as { id: number; status: string; created_at: string }[];
}
const sqliteAt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const successRows = () => digestRowsFull().filter((r) => r.status === "success");
db.run("DELETE FROM send_logs WHERE type='owner_digest'"); // clean ledger for this scenario

// boot 1 — nothing on record → sends
advanceClock(25 * 3600 * 1000);
resetStub();
seedStripe();
captured.length = 0;
const BOOT1 = clockMs;
const boot1 = await digest.runDailyOwnerDigest(db, deps);
check("(j) boot 1 sends (empty ledger)", boot1.success === true && boot1.skipped !== true, boot1.message);
check("(j) boot 1 wrote exactly one success row", successRows().length === 1 && digestRowsFull().length === 1, JSON.stringify(digestRowsFull()));
check(
  "(j) the ledger row carries the pass clock, so the guard can read it back",
  digestRowsFull()[0].created_at === sqliteAt(BOOT1),
  `${digestRowsFull()[0].created_at} vs ${sqliteAt(BOOT1)}`
);

// boot 2 — a deploy 40 minutes later → SKIP: no Stripe call, no row, elapsed logged
clockMs = BOOT1 + 40 * 60 * 1000;
resetStub();
seedStripe();
captured.length = 0;
const boot2 = await digest.runDailyOwnerDigest(db, deps);
check("(j) boot 2 inside the window is SKIPPED", boot2.skipped === true && boot2.success === false, boot2.message);
check(
  "(j) skip log names the elapsed time since the last digest",
  logLines().some((l) => l.includes("[scheduler] owner-digest pass: skipped — last digest sent 40m ago")),
  JSON.stringify(logLines())
);
check(
  "(j) skip log says when the next attempt is due",
  logLines().some((l) => l.includes("next attempt") && l.includes("(in 23h 20m)")),
  JSON.stringify(logLines())
);
check("(j) skip writes NO send_logs row", digestRowsFull().length === 1, JSON.stringify(digestRowsFull()));
check("(j) skip costs no Stripe call", stub.calls.length === 0, JSON.stringify(stub.calls));
check("(j) the pass reports the next allowed attempt", boot2.nextAttemptMs === BOOT1 + 24 * 3600 * 1000, String(boot2.nextAttemptMs));

// boot 3 — 23h59m after boot 1, still inside the window → SKIP
clockMs = BOOT1 + 23 * 3600 * 1000 + 59 * 60 * 1000;
resetStub();
seedStripe();
captured.length = 0;
const boot3 = await digest.runDailyOwnerDigest(db, deps);
check("(j) boot 3 at 23h59m is still SKIPPED", boot3.skipped === true, boot3.message);
check(
  "(j) boot 3 skip log shows 23h 59m elapsed",
  logLines().some((l) => l.includes("last digest sent 23h 59m ago")),
  JSON.stringify(logLines())
);
check("(j) boot 3 sent nothing", successRows().length === 1, JSON.stringify(digestRowsFull()));

// boot 4 — past 24h → the digest DOES send again
clockMs = BOOT1 + 25 * 3600 * 1000;
resetStub();
seedStripe();
captured.length = 0;
const boot4 = await digest.runDailyOwnerDigest(db, deps);
check("(j) boot 4 (>24h later) sends", boot4.success === true, boot4.message);
check("(j) boot 4 added a second success row", successRows().length === 2, JSON.stringify(digestRowsFull()));
check(
  "(j) boot 4 logs a SEND, not a guard skip",
  logLines().some((l) => l.includes("owner-digest pass:") && l.includes("— sent")) &&
    !logLines().some((l) => l.includes("owner-digest pass: skipped —")),
  JSON.stringify(logLines())
);

// ── failed sends are RETRIED, never swallowed for 24h ──
db.run("DELETE FROM send_logs WHERE type='owner_digest'");
clockMs += 60 * 60 * 1000;
resetStub();
stub.failPaths = ["/v1/balance", "/v1/balance/history", "/v1/subscriptions"];
captured.length = 0;
const failedRun = await digest.runDailyOwnerDigest(db, deps);
check("(j) failed attempt writes a FAILED row and no success", digestRowsFull().length === 1 && digestRowsFull()[0].status === "failed", JSON.stringify(digestRowsFull()));
check("(j) failed attempt is not reported as sent", failedRun.success === false && failedRun.skipped === true, failedRun.message);

clockMs += 60 * 60 * 1000; // one hour later
resetStub();
seedStripe();
captured.length = 0;
const retryRun = await digest.runDailyOwnerDigest(db, deps);
check("(j) a failed attempt does NOT suppress the retry an hour later", retryRun.success === true, retryRun.message);
check("(j) the retry wrote the success row", successRows().length === 1, JSON.stringify(digestRowsFull()));

// ── the rule itself (pure, no DB) ──
const T = clockMs;
const state = (lastSuccessMs: number | null) => ({
  lastSuccessMs,
  lastSuccessAt: lastSuccessMs === null ? null : sqliteAt(lastSuccessMs),
  lastAttemptMs: lastSuccessMs,
  lastAttemptStatus: lastSuccessMs === null ? null : "success",
});
check("(j) guard: no ledger → send", digest.evaluateDigestGuard(state(null), T).shouldSend === true);
check("(j) guard: 1m after a send → skip", digest.evaluateDigestGuard(state(T - 60_000), T).shouldSend === false);
check("(j) guard: 23h59m after a send → skip", digest.evaluateDigestGuard(state(T - (23 * 3600_000 + 59 * 60_000)), T).shouldSend === false);
check("(j) guard: exactly 24h after a send → send", digest.evaluateDigestGuard(state(T - 24 * 3600_000), T).shouldSend === true);
check("(j) guard: 24h01m after a send → send", digest.evaluateDigestGuard(state(T - (24 * 3600_000 + 60_000)), T).shouldSend === true);
check("(j) guard: a FUTURE timestamp is treated as just sent (never double-send on clock skew)", digest.evaluateDigestGuard(state(T + 60_000), T).shouldSend === false);
check("(j) guard: next attempt = last success + 24h", digest.evaluateDigestGuard(state(T - 3 * 3600_000), T).nextAttemptMs === T + 21 * 3600_000);
check("(j) elapsed formatter", digest.formatElapsed(3 * 3600_000 + 5 * 60_000) === "3h 05m" && digest.formatElapsed(45_000) === "45s" && digest.formatElapsed(26 * 3600_000) === "1d 2h", `${digest.formatElapsed(3 * 3600_000 + 5 * 60_000)} / ${digest.formatElapsed(45_000)} / ${digest.formatElapsed(26 * 3600_000)}`);

// ── the scheduler arms its first tick from that same ledger ──
db.run("DELETE FROM send_logs WHERE type='owner_digest'");
check("(j) scheduler delay: no digest on record → due now", digest.ownerDigestDueInMs(db, T) === 0);
db.run("INSERT INTO send_logs (type, status, provider_message, created_at) VALUES ('owner_digest','success','seed',?)", [sqliteAt(T - 3 * 3600 * 1000)]);
check(
  "(j) scheduler delay: last digest 3h ago → next tick ~21h out, not 60s",
  digest.ownerDigestDueInMs(db, T) === 21 * 3600 * 1000,
  String(digest.ownerDigestDueInMs(db, T))
);
check("(j) scheduler delay: window open → due now", digest.ownerDigestDueInMs(db, T + 21 * 3600 * 1000) === 0);

const bootLogs: string[] = [];
const bootHandle = sched.startScheduler(
  db,
  {
    startDelayMs: 60_000,
    syncInitialDelayMs: 9_000_000,
    syncIntervalMs: 9_000_000,
    advanceIntervalMs: 9_000_000,
    summaryIntervalMs: 9_000_000,
    purgeIntervalMs: 9_000_000,
    ownerDigestIntervalMs: 9_000_000,
    trialExpiryIntervalMs: 9_000_000,
  },
  { now: nowDate, log: (m: string) => bootLogs.push(m) }
);
bootHandle.stop(); // armed, never fired — this suite must not run a real pass
check(
  "(j) boot log arms the digest tick 21h out and says this boot does not send",
  bootLogs.some((l) => l.includes("[scheduler] owner-digest: first tick in 21h 00m") && l.includes("does not send")),
  JSON.stringify(bootLogs)
);

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
    activeSubscribers: null, mrrCents: null, events: [], trialMerchants: [], trialExpirySends: 0, historyTruncated: false, errors: [],
  };
}
