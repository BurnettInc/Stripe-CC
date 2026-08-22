/**
 * Beta-code redemption — endpoint tests (mint + redeem lifecycle).
 *
 * Covers:
 *   POST /api/beta/mint   (Bearer <SUPPORT_API_TOKEN>): 403 without token,
 *                         creates single/multi/expired codes, idempotent on dup
 *   POST /api/beta/redeem (session-authed): valid → dev_pro=1 + 200 + audit
 *                         row; second redeem of a single-use code →
 *                         "already redeemed"; unknown → "invalid"; expired →
 *                         "expired"; multi-use code honors max_uses;
 *                         a dev-Pro merchant can't consume a fresh slot.
 *
 * Runs against a booted server (TEST_BASE, default :3100) sharing the seeded
 * SQLite DB (TEST_DB_PATH, default /tmp/cc-test.db).
 *
 * Boot the server WITH SUPPORT_API_TOKEN (and provider keys stripped):
 *   env -u RESEND_API_KEY -u SENDGRID_API_KEY -u OPENAI_API_KEY \
 *     DB_PATH=/tmp/cc-test.db PORT=3100 SUPPORT_API_TOKEN=test-support-token \
 *     bun run src/index.ts
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-test.db \
 *     SUPPORT_API_TOKEN=test-support-token bun run test-beta-codes.ts
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const TOKEN = process.env.SUPPORT_API_TOKEN || "test-support-token";

const S1 = "beta-session-merchant-1";
const S2 = "beta-session-merchant-2";
const S3 = "beta-session-merchant-3";
const S4 = "beta-session-merchant-4";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}

function db(): Database {
  // Bun 1.3.x throws SQLITE_MISUSE with `create:false` — default constructor.
  return new Database(DB_PATH);
}

function mintsig(token: string): string {
  return `Bearer ${token}`;
}
function post(path: string, body: unknown, extra?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extra?.headers || {}) },
    body: JSON.stringify(body),
    ...extra,
  });
}
function redeem(code: string, session: string): Promise<Response> {
  return post("/api/beta/redeem", { code }, { headers: { Cookie: `session=${session}` } });
}

// ── seed: reset merchant state, seed sessions ──
function seed(): void {
  const d = db();
  // Fresh tables for a clean run.
  d.run("DELETE FROM beta_redemptions");
  d.run("DELETE FROM beta_codes");
  d.run("UPDATE merchants SET dev_pro = 0 WHERE id IN (1,2,3,4)");
  // merchant 1 is the acct_default placeholder (auto-created). merchants 2–4
  // are distinct testers for the multi-use path (a multi-use code is shared
  // across DIFFERENT testers; one merchant redeems at most once).
  const mk = (id: number, acct: string, email: string) =>
    d.run(`INSERT OR IGNORE INTO merchants (id, stripe_account_id, email, trust_mode) VALUES (${id}, '${acct}', '${email}', 'draft')`);
  mk(2, "acct_beta_two", "beta2@example.com");
  mk(3, "acct_beta_three", "beta3@example.com");
  mk(4, "acct_beta_four", "beta4@example.com");
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 1, datetime('now','+30 days'))", [S1]);
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 2, datetime('now','+30 days'))", [S2]);
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 3, datetime('now','+30 days'))", [S3]);
  d.run("INSERT OR REPLACE INTO sessions (token, merchant_id, expires_at) VALUES (?, 4, datetime('now','+30 days'))", [S4]);
  d.run("UPDATE merchants SET dev_pro=0 WHERE id IN (2,3,4)");
  d.close();
}

// ── the suite ──
async function main(): Promise<void> {
  seed();

  // --- mint: 403 without token ---
  const noToken = await post("/api/beta/mint", { codes: ["X"] }, { headers: { Cookie: `session=${S1}` } });
  ok(noToken.status === 403, `mint without token → 403 (got ${noToken.status})`);

  // --- mint codes ---
  const mintRes = await post("/api/beta/mint", {
    codes: ["TEST-SINGLE", "TEST-MULTI", "TEST-EXPIRED"],
    expires_at: "2999-12-31 00:00:00",
    label: "beta tester",
  }, { headers: { Authorization: mintsig(TOKEN) } });
  ok(mintRes.status === 200, `mint → 200 (got ${mintRes.status})`);
  const mint = await mintRes.json() as { created: string[] };
  ok(mint.created.length === 3, `mint created 3 codes (got ${mint.created.length}: ${mint.created.join(",")})`);

  // Mint expires_at only applies to the minted batch — set EXPIRED's expiry
  // (in the past) directly so the redeem asserts an exact "expired" error.
  // Also hand the multi-use code max_uses=3 via a second mint (idempotent
  // re-mint would skip it, so set it directly on the row).
  const d = db();
  d.run("UPDATE beta_codes SET expires_at = '2000-01-01 00:00:00' WHERE code = 'TEST-EXPIRED'");
  d.run("UPDATE beta_codes SET max_uses = 3 WHERE code = 'TEST-MULTI'");
  d.close();

  // --- mint idempotency: re-minting the same code is skipped ---
  const reMint = await post("/api/beta/mint", { codes: ["TEST-SINGLE", "TEST-BRAND-NEW"] }, { headers: { Authorization: mintsig(TOKEN) } });
  const reMintJson = await reMint.json() as { created: string[] };
  ok(reMintJson.created.length === 1 && reMintJson.created[0] === "TEST-BRAND-NEW",
    `re-mint skipped dup, created only TEST-BRAND-NEW (got ${reMintJson.created.join(",")})`);

  // --- redeem: unknown code → invalid ---
  const unknown = await redeem("DOES-NOT-EXIST", S1);
  const unknownJson = await unknown.json() as { error: string };
  ok(unknown.status === 400 && /isn't valid|invalid/i.test(unknownJson.error),
    `unknown code → 400 invalid (got ${unknown.status} "${unknownJson.error}")`);

  // --- redeem: expired code → expired ---
  const expiredRes = await redeem("TEST-EXPIRED", S1);
  const expiredJson = await expiredRes.json() as { error: string };
  ok(expiredRes.status === 400 && /expired/i.test(expiredJson.error),
    `expired code → 400 expired (got ${expiredRes.status} "${expiredJson.error}")`);

  // --- redeem: valid single-use → 200 + dev_pro=1 + audit row ---
  const good = await redeem("TEST-SINGLE", S1);
  const goodJson = await good.json() as { ok: boolean; message: string };
  ok(good.status === 200 && goodJson.ok === true, `valid code → 200 ok (got ${good.status} ${JSON.stringify(goodJson)})`);
  {
    const check = db();
    const dev = check.query("SELECT dev_pro FROM merchants WHERE id=1").get() as { dev_pro: number };
    ok(dev.dev_pro === 1, `merchant 1 dev_pro=1 after redeem (got ${dev.dev_pro})`);
    // /subscription should now reflect active Pro (dev)
    const sub = await fetch(`${BASE}/subscription`, { headers: { Cookie: `session=${S1}` } });
    const subJson = await sub.json() as { tier: string; status: string; dev_pro?: boolean };
    ok(subJson.tier === "pro" && subJson.status === "active" && subJson.dev_pro === true,
      `dev-Pro merchant's /subscription → pro/active/dev_pro:true (got ${JSON.stringify(subJson)})`);
    const red = check.query("SELECT COUNT(*) as c FROM beta_redemptions WHERE beta_code_id = (SELECT id FROM beta_codes WHERE code='TEST-SINGLE') AND merchant_id=1").get() as { c: number };
    ok(red.c === 1, `redemption audit row recorded (got ${red.c})`);
    check.close();
  }

  // --- redeem: second redeem of the exhausted single-use code → already redeemed ---
  const second = await redeem("TEST-SINGLE", S1);
  const secondJson = await second.json() as { error: string };
  ok(second.status === 400 && /already been redeemed|already redeemed/i.test(secondJson.error),
    `second redeem of single-use code → 400 already redeemed (got ${second.status} "${secondJson.error}")`);

  // --- redeem: dev-Pro merchant can't consume a fresh slot ---
  const freshAsDev = await redeem("TEST-BRAND-NEW", S1);
  const freshAsDevJson = await freshAsDev.json() as { error: string };
  ok(freshAsDev.status === 400 && /already active/i.test(freshAsDevJson.error),
    `dev-Pro merchant redeeming fresh code → 400 already active (got ${freshAsDev.status} "${freshAsDevJson.error}")`);

  // --- redeem: multi-use code honors max_uses (shared across distinct testers) ---
  const m2a = await redeem("TEST-MULTI", S2);
  ok(m2a.status === 200, `merchant 2 redeem of multi-use → 200 (got ${m2a.status})`);
  const m3a = await redeem("TEST-MULTI", S3);
  ok(m3a.status === 200, `merchant 3 redeem of multi-use (used=2<3) → 200 (got ${m3a.status})`);
  const m4a = await redeem("TEST-MULTI", S4);
  ok(m4a.status === 200, `merchant 4 redeem of multi-use (used=3<3) → 200 (got ${m4a.status})`);
  const m4b = await redeem("TEST-MULTI", S4);
  ok(m4b.status === 400, `multi-use exhausted (used=3>=3) → 400 even for dev-Pro merchant (got ${m4b.status})`);
  const m4bJson = await m4b.json() as { error: string };
  ok(/already been redeemed|already redeemed/i.test(m4bJson.error), `multi-use exhausted → already redeemed (got "${m4bJson.error}")`);

  // --- redeem: unauthenticated → 401 ---
  const noSession = await post("/api/beta/redeem", { code: "TEST-SINGLE" });
  ok(noSession.status === 401, `redeem without session → 401 (got ${noSession.status})`);

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
