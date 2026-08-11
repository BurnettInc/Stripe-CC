/**
 * Support backend pack — endpoint tests (Pro-lookup + first-response log).
 *
 * The /support/* routes are token-gated (Authorization: Bearer
 * SUPPORT_API_TOKEN), not session-authed — this suite never sends a session
 * cookie. Runs against a booted server (TEST_BASE, default :3100) sharing the
 * seeded SQLite DB (TEST_DB_PATH, default /tmp/cc-test.db).
 *
 * Boot the server WITH SUPPORT_API_TOKEN set (and provider keys stripped so
 * the boot log shows log-only mode):
 *
 *   env -u RESEND_API_KEY -u SENDGRID_API_KEY -u OPENAI_API_KEY \
 *     DB_PATH=/tmp/cc-test.db PORT=3100 SUPPORT_API_TOKEN=test-support-token \
 *     bun run src/index.ts
 *
 *   TEST_BASE=http://localhost:3100 TEST_DB_PATH=/tmp/cc-test.db \
 *     SUPPORT_API_TOKEN=test-support-token bun run test-support-endpoints.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || join(import.meta.dirname, "app.db");
const TOKEN = process.env.SUPPORT_API_TOKEN || "test-support-token";

// ── helpers ──

function db(): Database {
  // Bun 1.3.x throws SQLITE_MISUSE with `create: false` — default constructor.
  return new Database(DB_PATH);
}

/** Merchant 1 (acct_default) is auto-created by the server's first request. */
function setMerchantEmail(email: string, senderName: string | null = null): void {
  const d = db();
  d.run("UPDATE merchants SET email=?, sender_name=? WHERE id=1", [email, senderName]);
  d.close();
}

function setSubscription(tier: "standard" | "pro" | null, status: "active" | "cancelled" | "past_due" = "active"): void {
  const d = db();
  const existing = d.query("SELECT id FROM subscriptions WHERE merchant_id=1").get() as { id: number } | null;
  if (existing) {
    if (tier === null) {
      d.run("DELETE FROM subscriptions WHERE merchant_id=1");
    } else {
      d.run("UPDATE subscriptions SET status=?, tier=? WHERE merchant_id=1", [status, tier]);
    }
  } else if (tier !== null) {
    d.run("INSERT INTO subscriptions (merchant_id, stripe_subscription_id, tier, status) VALUES (1, 'sub_support_test', ?, ?)", [tier, status]);
  }
  d.close();
}

/** Fetch WITHOUT any auth — for the 403 assertions. */
function anonFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, opts);
}

/** Fetch WITH the SUPPORT_API_TOKEN bearer header. */
function sf(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${TOKEN}`);
  return fetch(`${BASE}${path}`, { ...opts, headers });
}

const results: { name: string; pass: boolean; details: string }[] = [];
function record(name: string, pass: boolean, details = "") {
  results.push({ name, pass, details });
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass && details) console.log(`   FAIL: ${details}`);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${BASE} did not become healthy`);
}

// ── tests ──

async function run() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Support backend pack — endpoint tests");
  console.log("═══════════════════════════════════════════════");
  await waitForServer();

  // ── A. Token gate: 403 without/with wrong token on every endpoint ──
  try {
    const lookupNoAuth = await anonFetch("/support/lookup?email=x@example.com");
    const logGetNoAuth = await anonFetch("/support/log");
    const logPostNoAuth = await anonFetch("/support/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@example.com", direction: "in" }),
    });
    const lookupWrong = await fetch(`${BASE}/support/lookup?email=x@example.com`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const pass =
      lookupNoAuth.status === 403 &&
      logGetNoAuth.status === 403 &&
      logPostNoAuth.status === 403 &&
      lookupWrong.status === 403;
    record("A1. All /support/* endpoints → 403 without (or with wrong) token", pass,
      pass ? "" : JSON.stringify({ lookupNoAuth: lookupNoAuth.status, logGetNoAuth: logGetNoAuth.status, logPostNoAuth: logPostNoAuth.status, lookupWrong: lookupWrong.status }));
  } catch (e: any) {
    record("A1. Token gate", false, `Exception: ${e.message}`);
  }

  // ── A2. Lookup validation: missing email → 400 (with valid token) ──
  try {
    const res = await sf("/support/lookup");
    const pass = res.status === 400;
    record("A2. Lookup without email param → 400", pass, pass ? "" : `status=${res.status}`);
  } catch (e: any) {
    record("A2. Lookup email validation", false, `Exception: ${e.message}`);
  }

  // ── B. Lookup found — Pro / active (tier + status from the same source of
  //      truth the rest of the app uses: getSubscriptionByMerchantId) ──
  try {
    setMerchantEmail("pro@merchant.com", "Acme Inc");
    setSubscription("pro", "active");
    const res = await sf("/support/lookup?email=pro@merchant.com");
    const body = await res.json();
    const pass =
      res.status === 200 &&
      body.found === true &&
      body.merchantId === 1 &&
      body.tier === "pro" &&
      body.subscriptionStatus === "active" &&
      body.accountEmail === "pro@merchant.com" &&
      body.senderName === "Acme Inc";
    record("B1. Lookup found: Pro/active merchant → tier+status+senderName correct", pass,
      pass ? "" : JSON.stringify({ status: res.status, body }));
  } catch (e: any) {
    record("B1. Lookup found (Pro)", false, `Exception: ${e.message}`);
  }

  // ── B2. Lookup found — Standard / active ──
  try {
    setSubscription("standard", "active");
    const res = await sf("/support/lookup?email=pro@merchant.com");
    const body = await res.json();
    const pass =
      res.status === 200 &&
      body.found === true &&
      body.tier === "standard" &&
      body.subscriptionStatus === "active";
    record("B2. Lookup found: Standard/active merchant → tier=standard, status=active", pass,
      pass ? "" : JSON.stringify({ status: res.status, body }));
  } catch (e: any) {
    record("B2. Lookup found (Standard)", false, `Exception: ${e.message}`);
  }

  // ── B3. Lookup found — cancelled subscription → status null, tier kept ──
  try {
    setSubscription("pro", "cancelled");
    const res = await sf("/support/lookup?email=pro@merchant.com");
    const body = await res.json();
    const pass =
      res.status === 200 &&
      body.found === true &&
      body.tier === "pro" &&
      body.subscriptionStatus === null;
    record("B3. Lookup found: cancelled sub → subscriptionStatus null, tier kept", pass,
      pass ? "" : JSON.stringify({ status: res.status, body }));
  } catch (e: any) {
    record("B3. Lookup found (cancelled)", false, `Exception: ${e.message}`);
  }

  // ── B4. Lookup found — no subscription at all → tier null, status 'none' ──
  try {
    setSubscription(null);
    const res = await sf("/support/lookup?email=pro@merchant.com");
    const body = await res.json();
    const pass =
      res.status === 200 &&
      body.found === true &&
      body.tier === null &&
      body.subscriptionStatus === "none";
    record("B4. Lookup found: no subscription → tier null, subscriptionStatus 'none'", pass,
      pass ? "" : JSON.stringify({ status: res.status, body }));
  } catch (e: any) {
    record("B4. Lookup found (no sub)", false, `Exception: ${e.message}`);
  }

  // ── B5. Lookup unknown email → found:false ──
  try {
    const res = await sf("/support/lookup?email=nobody@example.com");
    const body = await res.json();
    const pass =
      res.status === 200 &&
      body.found === false &&
      body.merchantId === undefined;
    record("B5. Lookup unknown email → found:false, no merchantId", pass,
      pass ? "" : JSON.stringify({ status: res.status, body }));
  } catch (e: any) {
    record("B5. Lookup unknown email", false, `Exception: ${e.message}`);
  }

  // ── B6. Lookup is case-insensitive ──
  try {
    const res = await sf("/support/lookup?email=PRO@Merchant.COM");
    const body = await res.json();
    const pass = res.status === 200 && body.found === true && body.accountEmail === "pro@merchant.com";
    record("B6. Lookup email matching is case-insensitive", pass,
      pass ? "" : JSON.stringify({ status: res.status, body }));
  } catch (e: any) {
    record("B6. Lookup case-insensitivity", false, `Exception: ${e.message}`);
  }

  // ── C. Support log: POST then GET roundtrip ──
  try {
    const stamp = Date.now();
    const inRes = await sf("/support/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pro@merchant.com", subject: `Can't log in ${stamp}`, direction: "in", note: "Customer says dashboard 500s" }),
    });
    const inBody = await inRes.json();
    const outRes = await sf("/support/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pro@merchant.com", subject: `Re: Can't log in ${stamp}`, direction: "out", note: "Replied — fixed, was a Stripe outage" }),
    });
    const outBody = await outRes.json();

    const listRes = await sf("/support/log?limit=10");
    const listBody = await listRes.json();
    const entries: any[] = listBody.entries || [];
    const latest = entries[0];
    const inbound = entries.find((e) => e.direction === "in" && e.note === "Customer says dashboard 500s");

    const pass =
      inRes.status === 201 && inBody.ok === true && inBody.responded_at === null &&
      outRes.status === 201 && outBody.ok === true && typeof outBody.responded_at === "string" &&
      listRes.status === 200 &&
      latest?.direction === "out" && latest?.note === "Replied — fixed, was a Stripe outage" && // most recent first
      !!inbound && inbound.responded_at === outBody.responded_at; // inbound backfilled with first-reply time
    record("C1. Log roundtrip: POST in+out → GET lists newest first, inbound stamped with first-reply time", pass,
      pass ? "" : JSON.stringify({ inRes: inRes.status, inBody, outRes: outRes.status, outBody, latest, inbound }));
  } catch (e: any) {
    record("C1. Log roundtrip", false, `Exception: ${e.message}`);
  }

  // ── C2. Log GET respects limit (default 50) ──
  try {
    for (let i = 0; i < 3; i++) {
      await sf("/support/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `bulk${i}@example.com`, subject: `Bulk ${i}`, direction: "in" }),
      });
    }
    const res2 = await sf("/support/log?limit=2");
    const body2 = await res2.json();
    const resDefault = await sf("/support/log");
    const bodyDefault = await resDefault.json();
    const pass =
      res2.status === 200 && (body2.entries || []).length === 2 &&
      resDefault.status === 200 && (bodyDefault.entries || []).length <= 50 &&
      (bodyDefault.entries || []).length >= 3;
    record("C2. Log GET limit param honored; default 50", pass,
      pass ? "" : JSON.stringify({ limit2: (body2.entries || []).length, defaultN: (bodyDefault.entries || []).length }));
  } catch (e: any) {
    record("C2. Log limit", false, `Exception: ${e.message}`);
  }

  // ── C3. Log POST validation: bad direction / missing email → 400 ──
  try {
    const badDir = await sf("/support/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@example.com", direction: "sideways" }),
    });
    const noEmail = await sf("/support/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "no email here", direction: "in" }),
    });
    const badJson = await sf("/support/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const pass = badDir.status === 400 && noEmail.status === 400 && badJson.status === 400;
    record("C3. Log POST validation → 400 (bad direction, missing email, bad JSON)", pass,
      pass ? "" : JSON.stringify({ badDir: badDir.status, noEmail: noEmail.status, badJson: badJson.status }));
  } catch (e: any) {
    record("C3. Log POST validation", false, `Exception: ${e.message}`);
  }

  // ── C4. Unknown /support path → 404 (token required first: 403 without) ──
  try {
    const noAuth = await anonFetch("/support/nonsense");
    const withAuth = await sf("/support/nonsense");
    const pass = noAuth.status === 403 && withAuth.status === 404;
    record("C4. Unknown /support path: 403 without token, 404 with token", pass,
      pass ? "" : JSON.stringify({ noAuth: noAuth.status, withAuth: withAuth.status }));
  } catch (e: any) {
    record("C4. Unknown /support path", false, `Exception: ${e.message}`);
  }

  // ── cleanup ──
  setSubscription("pro", "active");
  setMerchantEmail("default@collections-copilot.local", null);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n═══════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
