/**
 * AI-drafting health alert suite (owner alert, 2026-11-13).
 *
 * Disposable in-process tests — NO real network, NO real sends (provider keys
 * are deleted before the modules load, so the sender is the log-only stub), NO
 * real timers. The drafter's health is INJECTED through deps.health, so no
 * model call is made and the pass is exercised against a fixed state.
 *
 * Coverage:
 *   (a) healthy drafter → no email, no ledger row, one skip log line;
 *   (b) missing OPENAI_API_KEY → one alert email naming the cause;
 *   (c) a second tick inside 24h → skipped, still ONE ledger row (durable guard
 *       survives a restart: the state is in send_logs, not in memory);
 *   (d) 24h later → alerts again (the window really opens);
 *   (e) consecutive fallbacks → the alert NAMES the last fallback reason;
 *   (f) OWNER_NOTIFY_EMAIL unset → disabled, nothing sent, no throw;
 *   (g) an unreadable ledger fails CLOSED (no possible duplicate) and never throws;
 *   (h) pure rules: evaluateDrafterAlert + evaluateDrafterAlertGuard (future
 *       timestamp = treat as just sent);
 *   (i) scheduler wiring: hourly check interval, exported pass.
 *
 * Run: cd app && bun run test-drafter-alert.ts
 */
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-drafter-alert-test.db";
const OWNER = "owner@example.com";
const BASE_MS = Date.parse("2026-11-13T09:00:00Z");
let clockMs = BASE_MS;
const HOUR = 60 * 60 * 1000;
const nowDate = () => new Date(clockMs);

// ── Environment BEFORE any module import ──
process.env.DB_PATH = DB_PATH;
process.env.OWNER_NOTIFY_EMAIL = OWNER;
process.env.FROM_EMAIL = "test@example.com";
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;
Bun.spawnSync(["rm", "-f", DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}  ${detail}`);
  }
}

// ── Dynamic imports (env above must be set first) ──
const { getDb } = await import("./src/db");
const alert = await import("./src/pipeline/drafter-alert");
const sched = await import("./src/pipeline/scheduler");
const db = getDb();

const captured: string[] = [];
const deps = (health: unknown) => ({
  now: nowDate,
  log: (m: string) => captured.push(m),
  health: () => health as never,
});

type DrafterHealth = Awaited<ReturnType<typeof import("./src/pipeline/drafter").drafterHealth>>;
function health(over: Partial<DrafterHealth> = {}): DrafterHealth {
  return {
    status: "ok",
    key_configured: true,
    tracking_since: "2026-11-13T08:00:00.000Z",
    last_success_at: "2026-11-13T08:55:00.000Z",
    last_fallback: null,
    successes_total: 4,
    fallbacks_total: 0,
    consecutive_fallbacks: 0,
    ...over,
  };
}
const FALLBACK = {
  at: "2026-11-13T08:58:00.000Z",
  reason: "credit_balance_exhausted",
  http_status: 429,
  detail: "status=429 type=insufficient_quota code=credit_balance_exhausted",
};

function alertRows(): { status: string; provider_message: string }[] {
  return db
    .query("SELECT status, provider_message FROM send_logs WHERE type = 'drafter_alert' ORDER BY id ASC")
    .all() as { status: string; provider_message: string }[];
}

// ── (a) healthy drafter: nothing sent, no ledger row ──
captured.length = 0;
const healthyRun = await alert.runDrafterHealthAlertPass(db, deps(health()));
check("A1 healthy drafter is skipped", healthyRun.skipped === true && healthyRun.success === false, JSON.stringify(healthyRun));
check("A2 …no send_logs row is written for a healthy tick", alertRows().length === 0, JSON.stringify(alertRows()));
check(
  "A3 …and the log line says why",
  captured.some((l) => l.startsWith("[scheduler] drafter-alert pass: skipped — drafting healthy")),
  captured.join(" | "),
);

// ── (b) missing key: alert sent ──
captured.length = 0;
const missingKey = health({ key_configured: false, status: "degraded", last_success_at: null, successes_total: 0 });
const keyRun = await alert.runDrafterHealthAlertPass(db, deps(missingKey));
check("B1 a missing OPENAI_API_KEY sends the alert", keyRun.success === true, JSON.stringify(keyRun));
check("B2 …and records ONE successful ledger row", alertRows().length === 1 && alertRows()[0]!.status === "success", JSON.stringify(alertRows()));
check(
  "B3 …naming the missing key in the ledger line",
  alertRows()[0]!.provider_message.includes("OPENAI_API_KEY is not set"),
  alertRows()[0]!.provider_message,
);
check(
  "B4 …and the pass log line says sent",
  captured.some((l) => l.startsWith("[scheduler] drafter-alert pass:") && l.endsWith("— sent")),
  captured.join(" | "),
);

// ── (c) second tick inside 24h: skipped, still ONE row ──
clockMs += 10 * 60 * 1000;
captured.length = 0;
const secondRun = await alert.runDrafterHealthAlertPass(db, deps(missingKey));
check("C1 a tick 10 minutes later does not send again", secondRun.skipped === true, JSON.stringify(secondRun));
check("C2 …the ledger still holds exactly one alert", alertRows().length === 1, JSON.stringify(alertRows()));
check(
  "C3 …and the skip line names the window",
  captured.some((l) => l.includes("window is 24h")),
  captured.join(" | "),
);
check("C4 …and offers the next attempt time", typeof secondRun.nextAttemptMs === "number", JSON.stringify(secondRun));

// ── (d) 24h later: alerts again ──
clockMs = BASE_MS + 24 * HOUR + 60 * 1000;
captured.length = 0;
const reopened = await alert.runDrafterHealthAlertPass(db, deps(missingKey));
check("D1 once the 24h window opens the alert is sent again", reopened.success === true, JSON.stringify(reopened));
check("D2 …two ledger rows total", alertRows().length === 2, JSON.stringify(alertRows()));

// ── (e) consecutive fallbacks name the last reason ──
clockMs += 25 * HOUR;
const degraded = health({
  status: "degraded",
  last_fallback: FALLBACK,
  fallbacks_total: 3,
  consecutive_fallbacks: 3,
  successes_total: 0,
  last_success_at: null,
});
captured.length = 0;
const fallbackRun = await alert.runDrafterHealthAlertPass(db, deps(degraded));
check("E1 consecutive fallbacks send the alert", fallbackRun.success === true, JSON.stringify(fallbackRun));
const row = alertRows().at(-1)!;
check(
  "E2 …the subject names the count and the last fallback reason",
  row.provider_message.includes("3 consecutive template fallbacks") &&
    row.provider_message.includes("credit_balance_exhausted"),
  row.provider_message,
);
const composed = alert.formatDrafterAlertEmail(degraded, alert.evaluateDrafterAlert(degraded), new Date(clockMs));
check(
  "E3 …the body carries the reason, the detail, the HTTP status and the fix",
  composed.body.includes("Last fallback reason:  credit_balance_exhausted") &&
    composed.body.includes("code=credit_balance_exhausted") &&
    composed.body.includes("HTTP 429") &&
    composed.body.includes("Fix:"),
  composed.body,
);
check(
  "E4 …the body is an internal owner alert (no CAN-SPAM footer, no urgency theatre)",
  composed.body.includes("Internal owner alert — never sent to a customer") &&
    !/unsubscribe/i.test(composed.body) &&
    !/urgent|action required|final notice/i.test(composed.body),
  composed.body,
);
check(
  "E5 …and the subject is truthful, not manufactured urgency",
  composed.subject.startsWith("⚠️ AI drafting is degraded") && !/urgent|action required/i.test(composed.subject),
  composed.subject,
);

// ── (f) OWNER_NOTIFY_EMAIL unset: disabled ──
delete process.env.OWNER_NOTIFY_EMAIL;
const before = alertRows().length;
captured.length = 0;
const disabled = await alert.runDrafterHealthAlertPass(db, deps(degraded));
check("F1 with no owner address the pass is a logged no-op", disabled.skipped === true, JSON.stringify(disabled));
check("F2 …and writes no ledger row", alertRows().length === before, JSON.stringify(alertRows()));
check(
  "F3 …and says so",
  captured.some((l) => l.includes("OWNER_NOTIFY_EMAIL not set")),
  captured.join(" | "),
);
process.env.OWNER_NOTIFY_EMAIL = OWNER;

// ── (g) unreadable ledger fails CLOSED and never throws ──
clockMs += 25 * HOUR;
const brokenDb = {
  query() {
    throw new Error("disk I/O error");
  },
} as unknown as Parameters<typeof alert.runDrafterHealthAlertPass>[0];
captured.length = 0;
let threw = false;
let brokenRun: Awaited<ReturnType<typeof alert.runDrafterHealthAlertPass>> | null = null;
try {
  brokenRun = await alert.runDrafterHealthAlertPass(brokenDb, deps(degraded));
} catch {
  threw = true;
}
check("G1 a broken ledger never throws into the scheduler", threw === false, String(threw));
check("G2 …it fails closed instead of risking a duplicate", brokenRun?.skipped === true && brokenRun.success === false, JSON.stringify(brokenRun));
check("G3 …and logs the reason", captured.some((l) => l.includes("guard read failed")), captured.join(" | "));

// ── (h) pure rules ──
check(
  "H1 a healthy reading does not alert",
  alert.evaluateDrafterAlert(health()).shouldAlert === false,
  JSON.stringify(alert.evaluateDrafterAlert(health())),
);
check(
  "H2 a missing key alerts even with no fallback recorded yet",
  alert.evaluateDrafterAlert(health({ key_configured: false, status: "degraded" })).cause === "missing_key",
);
check(
  "H3 one fallback followed by a success (consecutive = 0) does not alert",
  alert.evaluateDrafterAlert(health({ last_fallback: FALLBACK, fallbacks_total: 1, consecutive_fallbacks: 0 })).shouldAlert === false,
);
check(
  "H4 the alert names the last fallback reason",
  alert.evaluateDrafterAlert(health({ status: "degraded", last_fallback: FALLBACK, consecutive_fallbacks: 2 })).lastReason ===
    "credit_balance_exhausted",
);
check(
  "H5 a ledger timestamp in the future is treated as just sent",
  alert.evaluateDrafterAlertGuard(
    { lastSuccessMs: BASE_MS + HOUR, lastSuccessAt: "x", lastAttemptMs: null, lastAttemptStatus: null },
    BASE_MS,
  ).shouldSend === false,
);
check(
  "H6 no alert on record means due now",
  alert.evaluateDrafterAlertGuard({ lastSuccessMs: null, lastSuccessAt: null, lastAttemptMs: null, lastAttemptStatus: null }, BASE_MS)
    .shouldSend === true,
);

// ── (i) scheduler wiring ──
check(
  "I1 the pass is registered hourly (the 24h cap lives in the pass, not the timer)",
  sched.DEFAULT_SCHEDULER_CONFIG.drafterAlertIntervalMs === HOUR,
  String(sched.DEFAULT_SCHEDULER_CONFIG.drafterAlertIntervalMs),
);
check(
  "I2 the scheduler module exposes the pass for manual runs",
  typeof sched.runDrafterHealthAlertPass === "function",
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
Bun.spawnSync(["rm", "-f", DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]);
process.exit(failures === 0 ? 0 : 1);
