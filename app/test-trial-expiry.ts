/**
 * Free-trial expiry email engine suite (feature/trial-expiry-emails).
 *
 * Standalone in-process tests — NO real network, NO real sends (the pass takes
 * an injectable sender; provider keys are deleted before the modules load so
 * even the default path would be log-only), NO real timers.
 *
 * The engine ships FLAG-OFF: TRIAL_EXPIRY_EMAILS_ENABLED is absent here for the
 * first section, and every later section sets it explicitly. The environment is
 * pinned to a production-looking one (BASE_URL=https://app.example.com, no
 * NODE_ENV) so the dev/test gate can be proven separately.
 *
 * Coverage:
 *   (a) flag OFF (default) → zero sends, zero mail-log rows, tick still logged
 *   (b) bucket math: every touchpoint window's edges (144/168, 72/96, 24/48,
 *       0/24, -72/0) and the gaps between them
 *   (c) active track → T-7 / T-3 / T-1 / T-0 / T+3, one email each, correct
 *       merge fields, placeholder copy, support@ sender, ledger row per send
 *   (d) idle track → day-10 check-in + T-3 + T-0 + T+3, and NEVER T-7 / T-1
 *   (e) track selection: a synced invoice OR a draft body makes a merchant
 *       ACTIVE; a merchant with neither is IDLE
 *   (f) dedupe: a second tick in the same window sends nothing (at most once
 *       ever, per merchant per touchpoint)
 *   (g) exclusions: active paid subscriber, dev_pro, .local placeholder,
 *       disconnected merchant, opted-out merchant
 *   (h) dev/test environment → zero sends even with the flag on
 *   (i) failed send releases its reservation (retry works, still one send)
 *   (j) scheduler wiring: exported pass + 6h interval + 60s start delay
 *   (k) owner digest: the "Trial-expiry emails sent (24h): N" line appears only
 *       when N > 0, and the count reads the mail log
 *   (l) data-rights purge deletes the ledger rows (FK safe)
 *
 * Run: cd app && bun run test-trial-expiry.ts
 */
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-trial-expiry-test.db";
const NOW = new Date("2026-11-01T14:00:00Z"); // the natural 14:00 UTC tick
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TRIAL_DAYS = 30;

// ── Environment BEFORE any module import ──
process.env.DB_PATH = DB_PATH;
process.env.FROM_EMAIL = "test@example.com";
process.env.BASE_URL = "https://app.example.com";
delete process.env.NODE_ENV;
delete process.env.TRIAL_EXPIRY_EMAILS_ENABLED;
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
const { getDb, recordUnsubscribe, purgeMerchantData } = await import("./src/db");
const trial = await import("./src/pipeline/trial-expiry");
const copy = await import("./src/pipeline/trial-expiry-copy");
const sched = await import("./src/pipeline/scheduler");
const digest = await import("./src/pipeline/owner-digest");
const db = getDb();

// ── Sender recorder: never a provider ──
interface Sent {
  to: string;
  from?: string;
  subject: string;
  body: string;
  skipCanspam?: boolean;
}
const sent: Sent[] = [];
let failNext = false;
const send = async (
  _db: unknown,
  _task: null,
  draft: { subject: string; body: string },
  toEmail: string,
  fromEmail?: string,
  opts?: { skipCanspam?: boolean },
) => {
  if (failNext) {
    failNext = false;
    return { success: false, message: "stub provider failure" };
  }
  sent.push({ to: toEmail, from: fromEmail, subject: draft.subject, body: draft.body, skipCanspam: opts?.skipCanspam });
  return { success: true, message: `stub sent to ${toEmail}` };
};

const logs: string[] = [];
function deps(at: Date = NOW) {
  return { now: () => at, log: (m: string) => logs.push(m), send: send as never };
}

// ── Seeding helpers ──
function sqliteAt(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
/** created_at such that the trial expires in `hoursToExpiry` hours from NOW. */
function createdAtForHours(hoursToExpiry: number): string {
  return sqliteAt(new Date(NOW.getTime() + (hoursToExpiry - TRIAL_DAYS * 24) * HOUR_MS));
}
let seq = 0;
function addMerchant(
  email: string,
  createdAt: string,
  extra: { devPro?: boolean; disconnected?: boolean; accountId?: string } = {},
): number {
  seq++;
  const info = db.run(
    "INSERT INTO merchants (stripe_account_id, email, trust_mode, created_at, dev_pro, disconnected) VALUES (?, ?, 'draft', ?, ?, ?)",
    [`acct_te_${seq}_${email.replace(/[^a-z0-9]/gi, "_")}`, email, createdAt, extra.devPro ? 1 : 0, extra.disconnected ? 1 : 0]
  );
  if (extra.accountId) {
    db.run("UPDATE merchants SET stripe_account_id = ? WHERE id = ?", [extra.accountId, Number(info.lastInsertRowid)]);
  }
  return Number(info.lastInsertRowid);
}
function addInvoice(merchantId: number, withDraft = false): number {
  const info = db.run(
    "INSERT INTO invoices (stripe_invoice_id, merchant_id, customer_name, customer_email, amount_cents, currency, due_date, status) VALUES (?, ?, 'Acme Co', 'ap@acme.test', 45000, 'usd', '2026-10-01', 'overdue')",
    [`in_te_${++seq}`, merchantId]
  );
  const invoiceId = Number(info.lastInsertRowid);
  if (withDraft) {
    db.run(
      "INSERT INTO reminder_tasks (invoice_id, stage, status, draft_subject, draft_body) VALUES (?, 1, 'reviewed', 'Friendly reminder', 'Hi Acme, a quick nudge about invoice.')",
      [invoiceId]
    );
  }
  return invoiceId;
}
function ledgerFor(merchantId: number): { touchpoint: string; status: string }[] {
  return db
    .query("SELECT touchpoint, status FROM trial_expiry_sends WHERE merchant_id = ? ORDER BY id ASC")
    .all(merchantId) as { touchpoint: string; status: string }[];
}
function mailRows(): { type: string; status: string; provider_message: string }[] {
  return db.query("SELECT type, status, provider_message FROM send_logs WHERE type = 'trial_expiry' ORDER BY id ASC")
    .all() as { type: string; status: string; provider_message: string }[];
}
function sentTo(email: string): Sent[] {
  return sent.filter((s) => s.to === email);
}

// ── (a) FLAG OFF (the default) is a total no-op ──
const flagOffMerchant = addMerchant("flagoff@example.com", createdAtForHours(12));
addInvoice(flagOffMerchant);
sent.length = 0;
logs.length = 0;
const offResult = await trial.runTrialExpiryPass(db, deps());
check("(a) flag absent → zero sends", offResult.sent === 0 && sent.length === 0, JSON.stringify(offResult));
check("(a) flag absent → zero mail-log rows", mailRows().length === 0, JSON.stringify(mailRows()));
check("(a) flag absent → no ledger rows", ledgerFor(flagOffMerchant).length === 0, JSON.stringify(ledgerFor(flagOffMerchant)));
const offLine = logs.find((l) => l.startsWith("[scheduler] trial-expiry pass:")) ?? "";
check("(a) the tick is still logged, with the standard shape", offLine.includes("0 in scope, 0 sent,") && offLine.includes("(flag "), offLine);
check("(a) the log line states why it is disabled", offLine.includes('TRIAL_EXPIRY_EMAILS_ENABLED is not "true"'), offLine);
check("(a) an explicit false is still OFF", trial.isTrialExpiryEnabled({ TRIAL_EXPIRY_EMAILS_ENABLED: "false" } as never) === false);
check("(a) only an explicit truthy value enables it",
  trial.isTrialExpiryEnabled({ TRIAL_EXPIRY_EMAILS_ENABLED: "true" } as never) === true &&
    trial.isTrialExpiryEnabled({ TRIAL_EXPIRY_EMAILS_ENABLED: "1" } as never) === true &&
    trial.isTrialExpiryEnabled({ TRIAL_EXPIRY_EMAILS_ENABLED: "yes" } as never) === true &&
    trial.isTrialExpiryEnabled({ TRIAL_EXPIRY_EMAILS_ENABLED: "TRUE " } as never) === true &&
    trial.isTrialExpiryEnabled({ TRIAL_EXPIRY_EMAILS_ENABLED: "on" } as never) === false &&
    trial.isTrialExpiryEnabled({} as never) === false);

// The flag-off probe merchant served its purpose; retiring it keeps the
// flag-on sections' counts exact (it would otherwise be a legitimate 10th send).
purgeMerchantData(db, flagOffMerchant);

// ── (b) bucket math, including the exact edges ──
const W = trial.touchpointForHours;
check("(b) T-7 upper edge 168", W(168) === "t_minus_7");
check("(b) T-7 just inside 167.9", W(167.9) === "t_minus_7");
check("(b) T-7 lower edge 144 is OUT", W(144) === null);
check("(b) gap 100 → no touchpoint", W(100) === null);
check("(b) T-3 upper edge 96", W(96) === "t_minus_3" && W(90) === "t_minus_3");
check("(b) T-3 lower edge 72 is OUT", W(72) === null);
check("(b) gap 60 → no touchpoint", W(60) === null);
check("(b) T-1 upper edge 48", W(48) === "t_minus_1" && W(30) === "t_minus_1");
check("(b) T-1 lower edge 24 belongs to T-0", W(24) === "t_zero");
check("(b) T-0 covers 0..24", W(12) === "t_zero" && W(0) === "t_zero");
check("(b) T+3 covers -72..0 (exclusive of both 0 and -72)", W(-0.5) === "t_plus_3" && W(-71.9) === "t_plus_3");
check("(b) T+3 lower edge -72 is OUT", W(-72) === null && W(-80) === null);
check("(b) far-future trial (200h) has no touchpoint", W(200) === null);
check("(b) mid-trial window is exactly [10d, 11d)",
  trial.inMidTrialWindow(NOW.getTime() - 10.5 * DAY_MS, NOW.getTime()) === true &&
    trial.inMidTrialWindow(NOW.getTime() - 9.9 * DAY_MS, NOW.getTime()) === false &&
    trial.inMidTrialWindow(NOW.getTime() - 11 * DAY_MS, NOW.getTime()) === false);
check("(b) hoursToExpiry = created_at + 30d − now", trial.hoursToExpiry(NOW.getTime() - 20 * DAY_MS, NOW.getTime()) === 240);

// ── (c)+(d) flag ON: active vs idle arc on one tick ──
process.env.TRIAL_EXPIRY_EMAILS_ENABLED = "true";
sent.length = 0;
logs.length = 0;

// ACTIVE track (has a synced invoice)
const a7 = addMerchant("active-t7@example.com", createdAtForHours(160));
addInvoice(a7);
const a3 = addMerchant("active-t3@example.com", createdAtForHours(90));
addInvoice(a3);
const a1 = addMerchant("active-t1@example.com", createdAtForHours(30));
addInvoice(a1);
const a0 = addMerchant("active-t0@example.com", createdAtForHours(12));
addInvoice(a0);
const aPlus3 = addMerchant("active-plus3@example.com", createdAtForHours(-10));
addInvoice(aPlus3);
// IDLE track (nothing synced, nothing drafted)
const iCheckin = addMerchant("idle-checkin@example.com", sqliteAt(new Date(NOW.getTime() - 10.5 * DAY_MS)));
const i7 = addMerchant("idle-t7@example.com", createdAtForHours(160));
const i1 = addMerchant("idle-t1@example.com", createdAtForHours(30));
const i3 = addMerchant("idle-t3@example.com", createdAtForHours(90));
const i0 = addMerchant("idle-t0@example.com", createdAtForHours(12));
const iPlus3 = addMerchant("idle-plus3@example.com", createdAtForHours(-10));

const onResult = await trial.runTrialExpiryPass(db, deps());
check("(c) active track fires 5 touchpoints", ledgerFor(a7).some((r) => r.touchpoint === "t_minus_7") &&
  ledgerFor(a3).some((r) => r.touchpoint === "t_minus_3") &&
  ledgerFor(a1).some((r) => r.touchpoint === "t_minus_1") &&
  ledgerFor(a0).some((r) => r.touchpoint === "t_zero") &&
  ledgerFor(aPlus3).some((r) => r.touchpoint === "t_plus_3"),
  JSON.stringify([ledgerFor(a7), ledgerFor(a3), ledgerFor(a1), ledgerFor(a0), ledgerFor(aPlus3)]));
check("(c) every active send landed as status 'sent'",
  [a7, a3, a1, a0, aPlus3].every((id) => ledgerFor(id).length === 1 && ledgerFor(id)[0].status === "sent"),
  JSON.stringify([a7, a3, a1, a0, aPlus3].map(ledgerFor)));
check("(d) idle track gets the day-10 check-in", ledgerFor(iCheckin).some((r) => r.touchpoint === "mid_trial_checkin"));
check("(d) idle track gets T-3, T-0 and T+3",
  ledgerFor(i3).some((r) => r.touchpoint === "t_minus_3") &&
    ledgerFor(i0).some((r) => r.touchpoint === "t_zero") &&
    ledgerFor(iPlus3).some((r) => r.touchpoint === "t_plus_3"),
  JSON.stringify([ledgerFor(i3), ledgerFor(i0), ledgerFor(iPlus3)]));
check("(d) idle track NEVER gets T-7 or T-1",
  ledgerFor(i7).length === 0 && ledgerFor(i1).length === 0 && sentTo("idle-t7@example.com").length === 0 &&
    sentTo("idle-t1@example.com").length === 0,
  JSON.stringify([ledgerFor(i7), ledgerFor(i1)]));
check("(c) one mail-log row per send, all success",
  mailRows().length === 9 && mailRows().every((r) => r.status === "success"),
  `${mailRows().length} rows: ${JSON.stringify(mailRows())}`);
check("(c) 9 merchants in scope, 9 sent", onResult.inScope === 9 && onResult.sent === 9, JSON.stringify(onResult));
check("(d) idle T-7/T-1 merchants counted as no-window skips", onResult.skipped.noWindow >= 2, JSON.stringify(onResult.skipped));

const t7Mail = sentTo("active-t7@example.com")[0];
check("(c) sender identity is support@ (welcome-email continuity)", t7Mail?.from === "support@getcollectionscopilot.com", String(t7Mail?.from));
check("(c) CAN-SPAM invoice footer is skipped (merchant email, own opt-out line)",
  t7Mail?.skipCanspam === true && !/stop receiving reminders for this invoice/i.test(t7Mail?.body ?? ""), t7Mail?.body);
const a7Expiry = copy.formatExpiryDateUtc(new Date(createdAtForHours(160)).getTime() + TRIAL_DAYS * DAY_MS);
check("(c) subject is the owner-approved T-7 line (date merged)",
  t7Mail?.subject === `Your free trial ends ${a7Expiry}`, `${t7Mail?.subject} vs ${a7Expiry}`);
check("(c) merge fields are substituted (no {{tokens}} left)",
  !/\{\{\w+\}\}/.test(`${t7Mail?.subject}\n${t7Mail?.body}`) && (t7Mail?.body ?? "").startsWith("Hello,"), t7Mail?.body);
check("(c) expiry date merged into the approved sentence", (t7Mail?.body ?? "").includes(`free trial ends on ${a7Expiry}`), `${a7Expiry}\n${t7Mail?.body}`);
check("(c) approved opt-out line closes the body",
  (t7Mail?.body ?? "").includes(copy.TRIAL_EMAIL_OPT_OUT) &&
    (t7Mail?.body ?? "").trimEnd().endsWith(copy.TRIAL_EMAIL_OPT_OUT), t7Mail?.body);
check("(c) approved signature line present", (t7Mail?.body ?? "").includes("— Collections Copilot"), t7Mail?.body);
check("(c) CTA token links to the dashboard checkout route via BASE_URL",
  (t7Mail?.body ?? "").includes("[Choose a plan →] https://app.example.com/billing/checkout?tier=standard"), t7Mail?.body);
const t0Mail = sentTo("active-t0@example.com")[0];
check("(c) T-0 subject says today", /ends today/i.test(t0Mail?.subject ?? ""), t0Mail?.subject);
const plus3Mail = sentTo("active-plus3@example.com")[0];
check("(c) T+3 subject is the approved win-back line", plus3Mail?.subject === "Your trial ended — your reminders are paused", plus3Mail?.subject);
check("(c) T+3 resume CTA links to the checkout route",
  (plus3Mail?.body ?? "").includes("[Subscribe to resume →] https://app.example.com/billing/checkout?tier=standard"), plus3Mail?.body);
check("(c) idle T-3 uses the approved idle copy (3b), not the active T-3",
  sentTo("idle-t3@example.com")[0]?.subject === "3 days left in your trial" &&
    sentTo("active-t3@example.com")[0]?.subject === "3 days left in your trial — keep your reminders running",
  JSON.stringify([sentTo("idle-t3@example.com")[0]?.subject, sentTo("active-t3@example.com")[0]?.subject]));
check("(c) every trial email body ends with the approved opt-out line",
  sent.length > 0 && sent.every((m) => m.body.trimEnd().endsWith(copy.TRIAL_EMAIL_OPT_OUT) &&
    m.body.includes("— Collections Copilot")) &&
    sent.every((m) => !/PLACEHOLDER/i.test(`${m.subject}\n${m.body}`)),
  JSON.stringify(sent.map((m) => m.subject)));

// ── (e) track selection ──
// Seeded far from every touchpoint window (400h to expiry): this section is
// about track selection only and must not add sends to the next tick's counts.
const trackInvoiceOnly = addMerchant("track-invoice@example.com", createdAtForHours(400));
addInvoice(trackInvoiceOnly, false);
const trackDraft = addMerchant("track-draft@example.com", createdAtForHours(400));
addInvoice(trackDraft, true);
const trackIdle = addMerchant("track-idle@example.com", createdAtForHours(400));
check("(e) a synced invoice → ACTIVE", trial.trackForMerchant(db, trackInvoiceOnly) === "active");
check("(e) a draft body → ACTIVE", trial.trackForMerchant(db, trackDraft) === "active");
check("(e) nothing synced and nothing drafted → IDLE", trial.trackForMerchant(db, trackIdle) === "idle");
check("(e) active-only touchpoints stay off the idle track",
  trial.touchpointAppliesToTrack("t_minus_7", "idle") === false && trial.touchpointAppliesToTrack("t_minus_1", "idle") === false &&
    trial.touchpointAppliesToTrack("t_minus_7", "active") === true && trial.touchpointAppliesToTrack("t_minus_3", "idle") === true);
check("(e) the check-in is idle-only",
  trial.touchpointAppliesToTrack("mid_trial_checkin", "active") === false &&
    trial.touchpointAppliesToTrack("mid_trial_checkin", "idle") === true);

// ── (f) dedupe: a second tick in the same windows sends nothing ──
sent.length = 0;
logs.length = 0;
const beforeRows = mailRows().length;
const secondRun = await trial.runTrialExpiryPass(db, deps());
check("(f) second tick sends nothing", secondRun.sent === 0 && sent.length === 0, JSON.stringify(secondRun));
check("(f) second tick adds no mail-log rows", mailRows().length === beforeRows, `${beforeRows} → ${mailRows().length}`);
check("(f) second tick counts the duplicates", secondRun.skipped.duplicate === 9, JSON.stringify(secondRun.skipped));
check("(f) ledger still holds exactly one row per merchant",
  [a7, a3, a1, a0, aPlus3, iCheckin, i3, i0, iPlus3].every((id) => ledgerFor(id).length === 1));
check("(f) three ticks later still nothing (at most once EVER)", await (async () => {
  await trial.runTrialExpiryPass(db, deps(new Date(NOW.getTime() + 1 * HOUR_MS)));
  const r = await trial.runTrialExpiryPass(db, deps(new Date(NOW.getTime() + 2 * HOUR_MS)));
  return r.sent === 0 && sent.length === 0;
})(), JSON.stringify(sent.map((s) => s.to)));

// ── (g) exclusions ──
const paying = addMerchant("paying@example.com", createdAtForHours(12));
addInvoice(paying);
db.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (?, 'sub_te_paying', 'pro', 'active')", [paying]);
const devPro = addMerchant("devpro@example.com", createdAtForHours(12), { devPro: true });
addInvoice(devPro);
const placeholder = addMerchant("someone@install.local", createdAtForHours(12));
addInvoice(placeholder);
const disconnected = addMerchant("disconnected@example.com", createdAtForHours(12), { disconnected: true });
addInvoice(disconnected);
const optedOut = addMerchant("optedout@example.com", createdAtForHours(12));
addInvoice(optedOut);
recordUnsubscribe(db, optedOut, "optedout@example.com");
sent.length = 0;
logs.length = 0;
const exclRun = await trial.runTrialExpiryPass(db, deps());
check("(g) active subscriber excluded", sentTo("paying@example.com").length === 0 && ledgerFor(paying).length === 0, JSON.stringify(exclRun.skipped));
check("(g) dev_pro excluded", sentTo("devpro@example.com").length === 0 && ledgerFor(devPro).length === 0);
check("(g) .local placeholder excluded", sentTo("someone@install.local").length === 0 && ledgerFor(placeholder).length === 0);
check("(g) disconnected merchant excluded", sentTo("disconnected@example.com").length === 0 && ledgerFor(disconnected).length === 0);
check("(g) opted-out merchant excluded", sentTo("optedout@example.com").length === 0 && ledgerFor(optedOut).length === 0);
check("(g) counters show why", exclRun.skipped.subscriber >= 1 && exclRun.skipped.devPro >= 1 &&
  exclRun.skipped.placeholder >= 1 && exclRun.skipped.inactive >= 1 && exclRun.skipped.unsubscribed >= 1,
  JSON.stringify(exclRun.skipped));
check("(g) nothing else went out on this tick", exclRun.sent === 0 && sent.length === 0, JSON.stringify(exclRun));

// ── (h) dev/test environment never sends, even with the flag on ──
const envProbe = addMerchant("envprobe@example.com", createdAtForHours(12));
addInvoice(envProbe);
sent.length = 0;
logs.length = 0;
process.env.NODE_ENV = "test";
const envRun = await trial.runTrialExpiryPass(db, deps());
check("(h) NODE_ENV=test → zero sends", envRun.sent === 0 && sent.length === 0, JSON.stringify(envRun));
check("(h) NODE_ENV=test → the probe merchant was not touched", ledgerFor(envProbe).length === 0 && sentTo("envprobe@example.com").length === 0);
check("(h) the log line says dev/test", (logs.find((l) => l.includes("trial-expiry pass:")) ?? "").includes("dev/test environment"),
  JSON.stringify(logs));
delete process.env.NODE_ENV;
process.env.BASE_URL = "http://localhost:3002";
check("(h) a localhost BASE_URL is dev/test too", trial.isDevOrTestEnv() === true);
process.env.BASE_URL = "https://app.example.com";
check("(h) a production BASE_URL with no NODE_ENV is not dev/test", trial.isDevOrTestEnv() === false);
check("(h) NODE_ENV=production is not dev/test", trial.isDevOrTestEnv({ NODE_ENV: "production" } as never) === false);

// ── (i) a failed send releases its reservation so a retry can go out ──
sent.length = 0;
failNext = true;
const retryRun = await trial.runTrialExpiryPass(db, deps());
const envProbeAfterFail = sentTo("envprobe@example.com");
check("(i) the failing send is counted, not swallowed", retryRun.failed === 1 && envProbeAfterFail.length === 0, JSON.stringify(retryRun));
check("(i) a failed attempt leaves no ledger row", ledgerFor(envProbe).length === 0, JSON.stringify(ledgerFor(envProbe)));
check("(i) the failure is in the mail log", mailRows().some((r) => r.status === "failed"), JSON.stringify(mailRows().slice(-2)));
const retryRun2 = await trial.runTrialExpiryPass(db, deps());
check("(i) the retry sends it exactly once", sentTo("envprobe@example.com").length === 1 && sentTo("envprobe@example.com")[0].to === "envprobe@example.com",
  JSON.stringify(sent.map((s) => s.to)));
check("(i) after the retry the ledger holds one 'sent' row",
  ledgerFor(envProbe).length === 1 && ledgerFor(envProbe)[0].status === "sent", JSON.stringify(ledgerFor(envProbe)));
check("(i) exactly one success row per delivered email (9 arc + this retry)", mailRows().filter((r) => r.status === "success").length === 10,
  `${mailRows().filter((r) => r.status === "success").length} successes of ${mailRows().length} rows`);

// ── (j) scheduler wiring ──
const cfg = sched.DEFAULT_SCHEDULER_CONFIG;
check("(j) 6h interval registered", cfg.trialExpiryIntervalMs === 6 * 60 * 60 * 1000, String(cfg.trialExpiryIntervalMs));
check("(j) first tick 60s after boot", cfg.startDelayMs === 60 * 1000, String(cfg.startDelayMs));
check("(j) the pass is exported from the scheduler module", typeof sched.runTrialExpiryPass === "function" &&
  sched.runTrialExpiryPass === trial.runTrialExpiryPass);
check("(j) existing pass cadences untouched",
  cfg.syncIntervalMs === 15 * 60 * 1000 && cfg.advanceIntervalMs === DAY_MS && cfg.summaryIntervalMs === DAY_MS &&
    cfg.purgeIntervalMs === DAY_MS && cfg.ownerDigestIntervalMs === DAY_MS);

// ── (k) owner digest line ──
const baseData = {
  date: "2026-11-01", windowEnd: "2026-11-01 14:00 UTC",
  availableCents: 0, pendingCents: 0, netCents: 0, paymentsCents: 0, refundsCents: 0, feesCents: 0,
  activeSubscribers: 0, mrrCents: 0, events: [], trialMerchants: [],
  trialExpirySends: 0, historyTruncated: false, errors: [],
};
const zeroBody = digest.buildOwnerDigestEmail(baseData).body;
check("(k) no line when nothing was sent", !zeroBody.includes("Trial-expiry emails sent"), zeroBody);
const someBody = digest.buildOwnerDigestEmail({ ...baseData, trialExpirySends: 3 }).body;
check("(k) the line appears when N > 0", someBody.includes("Trial-expiry emails sent (24h): 3"), someBody);
check("(k) everything else stays identical", someBody.replace("Trial-expiry emails sent (24h): 3", "").replace(/\n{3,}/g, "\n\n") ===
  zeroBody.replace(/\n{3,}/g, "\n\n"), `${someBody}\n---\n${zeroBody}`);
const counted = digest.countTrialExpirySends24h(db);
check("(k) the count reads the mail log's successes", counted === mailRows().filter((r) => r.status === "success").length,
  `${counted} vs ${mailRows().filter((r) => r.status === "success").length}`);
db.run("UPDATE send_logs SET created_at = datetime('now', '-2 days') WHERE type = 'trial_expiry'");
check("(k) sends older than 24h stop counting", digest.countTrialExpirySends24h(db) === 0, String(digest.countTrialExpirySends24h(db)));
db.run("UPDATE send_logs SET created_at = datetime('now') WHERE type = 'trial_expiry'");

// ── (m) a copy bug can never be mailed: unresolved merge field → no send ──
const copyBug = addMerchant("copybug@example.com", createdAtForHours(12));
addInvoice(copyBug);
const savedTemplate = copy.TRIAL_EXPIRY_COPY.t_zero;
copy.TRIAL_EXPIRY_COPY.t_zero = { subject: savedTemplate.subject, body: `${savedTemplate.body}\n{{not_a_field}}` };
sent.length = 0;
logs.length = 0;
const bugRun = await trial.runTrialExpiryPass(db, deps());
check("(m) an unresolved merge field blocks the send", sentTo("copybug@example.com").length === 0 && ledgerFor(copyBug).length === 0,
  JSON.stringify({ sent: sentTo("copybug@example.com").length, ledger: ledgerFor(copyBug) }));
check("(m) the copy bug is reported as an error", bugRun.errors.some((e) => e.includes("unresolved merge field")), JSON.stringify(bugRun.errors));
copy.TRIAL_EXPIRY_COPY.t_zero = savedTemplate;
const fixedRun = await trial.runTrialExpiryPass(db, deps());
check("(m) after fixing the copy the email goes out", sentTo("copybug@example.com").length === 1 && ledgerFor(copyBug)[0]?.status === "sent",
  JSON.stringify({ sent: sentTo("copybug@example.com").length, ledger: ledgerFor(copyBug), run: fixedRun.sent }));

// ── (l) purge deletes the ledger rows (FK safe) ──
check("(l) the merchant has ledger rows before the purge", ledgerFor(i0).length === 1);
let purgeThrew = false;
try {
  purgeMerchantData(db, i0);
} catch (err) {
  purgeThrew = true;
  console.log(`purge error: ${err instanceof Error ? err.message : String(err)}`);
}
check("(l) purge succeeds", purgeThrew === false);
check("(l) the ledger rows are gone", ledgerFor(i0).length === 0);
check("(l) other merchants' ledger rows survive", ledgerFor(i3).length === 1);

db.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
