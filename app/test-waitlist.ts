/**
 * Waitlist suite — landing-page email capture (POST /api/waitlist, also
 * /waitlist). Public endpoint replacing the /stripe/connect CTAs.
 *
 * The endpoint rate-limits per IP (5 attempts/hour, in-memory). Each test
 * group therefore sends its requests from a DEDICATED X-Forwarded-For IP so
 * groups never consume each other's budget (the handler keys on the first
 * XFF hop; real visitors get their real IP from the platform proxy).
 *
 * Coverage:
 *   (a) valid email inserts a row (normalized: trimmed + lowercased) and
 *       returns 200 {ok:true};
 *   (b) duplicate email is idempotent — 200 {ok:true, duplicate:true}, no
 *       second row, no second owner notification;
 *   (c) case/whitespace normalization makes "  NEW@EXAMPLE.COM " a duplicate
 *       of "new@example.com";
 *   (d) invalid/missing emails → 400 {error} (no insert);
 *   (e) form-encoded email=... also accepted;
 *   (f) per-IP rate limit: a 6th request from the same IP within the hour →
 *       429 {error};
 *   (g) owner notification (OWNER_NOTIFY_EMAIL set) — a send_logs row with
 *       type 'owner_notification' whose message contains the new signup's
 *       subject; duplicates produce no additional row.
 *
 * Run:
 *   bash /tmp/run-suite.sh waitlist
 * (boots an isolated server on :3100 with a fresh DB, provider keys stripped,
 * OWNER_NOTIFY_EMAIL=owner@example.com — log-only mode means no real email
 * escapes.)
 */
import { Database } from "bun:sqlite";
// ── Defensive: never let an in-process send reach a real provider ──
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.OPENAI_API_KEY;
const BASE = process.env.TEST_BASE || "http://localhost:3100";
const DB_PATH = process.env.TEST_DB_PATH || "/tmp/cc-waitlist.db";
// Dedicated per-group source IPs (see header comment).
const IP_MAIN = "198.51.100.1";   // groups a–c (valid/duplicate/normalize)
const IP_INVALID = "198.51.100.2"; // group d (invalid emails)
const IP_BADJSON = "198.51.100.3"; // d6 (invalid JSON)
const IP_FORM = "198.51.100.4";    // group e (form-encoded)
const IP_RATE = "203.0.113.9";     // group f (rate limit)
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}
function q(sql: string, ...args: unknown[]): unknown[] {
  const d = new Database(DB_PATH);
  try {
    return d.query(sql).all(...args);
  } finally {
    d.close();
  }
}
function one(sql: string, ...args: unknown[]): Record<string, unknown> | null {
  const d = new Database(DB_PATH);
  try {
    return (d.query(sql).get(...args) as Record<string, unknown> | undefined) ?? null;
  } finally {
    d.close();
  }
}
async function post(body: unknown, xff: string, form = false): Promise<Response> {
  const headers: Record<string, string> = {
    "x-forwarded-for": xff,
    ...(form ? {} : { "Content-Type": "application/json" }),
  };
  if (form) headers["content-type"] = "application/x-www-form-urlencoded";
  return fetch(`${BASE}/api/waitlist`, {
    method: "POST",
    headers,
    body: form ? (body as string) : JSON.stringify(body),
  });
}

// ── (a) valid insert + (g) owner notification on new signup ──
{
  const r = await post({ email: "  New@Example.com  " }, IP_MAIN);
  const j = await r.json() as { ok?: boolean };
  check("a1 valid email → 200", r.status === 200, `status ${r.status}`);
  check("a2 body {ok:true}", r.status === 200 && j.ok === true, JSON.stringify(j));
  const row = one("SELECT email, created_at FROM waitlist WHERE email = 'new@example.com'");
  check("a3 row inserted + normalized", !!row && row.email === "new@example.com", JSON.stringify(row));
  check("a4 created_at stamped", !!row && typeof row.created_at === "string" && row.created_at.length > 0);
  const n1 = one(
    "SELECT COUNT(*) AS n FROM send_logs WHERE type = 'owner_notification' AND provider_message LIKE ?",
    "%New waitlist signup: new@example.com%",
  ) as { n: number };
  check("g1 owner notified on new signup (1 row)", n1.n === 1, `count ${n1.n}`);
  const log = one(
    "SELECT provider_message FROM send_logs WHERE type = 'owner_notification' ORDER BY id LIMIT 1",
  ) as { provider_message: string };
  check(
    "g2 log message carries the subject",
    typeof log.provider_message === "string" && log.provider_message.includes("New waitlist signup: new@example.com"),
    log.provider_message,
  );
}

// ── (b) duplicate is idempotent, no re-notify ──
{
  const r = await post({ email: "new@example.com" }, IP_MAIN);
  const j = await r.json() as { ok?: boolean; duplicate?: boolean };
  check("b1 duplicate → 200", r.status === 200, `status ${r.status}`);
  check("b2 body {ok:true, duplicate:true}", j.ok === true && j.duplicate === true, JSON.stringify(j));
  const n = one("SELECT COUNT(*) AS n FROM waitlist") as { n: number };
  check("b3 still exactly 1 row", n.n === 1, `count ${n.n}`);
  const n2 = one(
    "SELECT COUNT(*) AS n FROM send_logs WHERE type = 'owner_notification' AND provider_message LIKE ?",
    "%New waitlist signup: new@example.com%",
  ) as { n: number };
  check("g3 duplicate did not re-notify", n2.n === 1, `count ${n2.n}`);
}

// ── (c) normalization makes case/space variants duplicates ──
{
  const r = await post({ email: "  NEW@EXAMPLE.COM " }, IP_MAIN);
  const j = await r.json() as { duplicate?: boolean };
  check("c1 case/space variant → duplicate:true", j.duplicate === true, JSON.stringify(j));
  const n = one("SELECT COUNT(*) AS n FROM waitlist") as { n: number };
  check("c2 still exactly 1 row", n.n === 1, `count ${n.n}`);
}

// ── (d) invalid / missing emails → 400 ──
{
  for (const [label, body] of [
    ["d1 no @", { email: "not-an-email" }],
    ["d2 no domain dot", { email: "a@b" }],
    ["d3 empty string", { email: "   " }],
    ["d4 missing field", {}],
    ["d5 wrong type", { email: 42 }],
  ] as const) {
    const r = await post(body, IP_INVALID);
    const j = await r.json() as { error?: string };
    check(`${label} → 400 {error}`, r.status === 400 && typeof j.error === "string" && j.error.length > 0, `status ${r.status} ${JSON.stringify(j)}`);
  }
  const r = await fetch(`${BASE}/api/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": IP_BADJSON },
    body: "{not json",
  });
  const j = await r.json() as { error?: string };
  check("d6 invalid JSON → 400 {error}", r.status === 400 && typeof j.error === "string", `status ${r.status} ${JSON.stringify(j)}`);
  const n = one("SELECT COUNT(*) AS n FROM waitlist") as { n: number };
  check("d7 nothing inserted by bad requests", n.n === 1, `count ${n.n}`);
}

// ── (e) form-encoded accepted ──
{
  const r = await post("email=form%40example.com", IP_FORM, true);
  const j = await r.json() as { ok?: boolean };
  check("e1 form-encoded → 200 {ok:true}", r.status === 200 && j.ok === true, `status ${r.status} ${JSON.stringify(j)}`);
  const row = one("SELECT email FROM waitlist WHERE email = 'form@example.com'");
  check("e2 form row inserted", !!row, JSON.stringify(row));
}

// ── (f) per-IP rate limit (dedicated IP) ──
{
  for (let i = 0; i < 5; i++) {
    const r = await post({ email: `rl-${i}@example.com` }, IP_RATE);
    check(`f${i + 1} attempt ${i + 1}/5 under limit → 200`, r.status === 200, `status ${r.status}`);
  }
  const r6 = await post({ email: "rl-6@example.com" }, IP_RATE);
  const j6 = await r6.json() as { ok?: boolean; error?: string };
  check("f6 6th request → 429 {error}", r6.status === 429 && typeof j6.error === "string", `status ${r6.status} ${JSON.stringify(j6)}`);
  const n = one("SELECT COUNT(*) AS n FROM waitlist WHERE email LIKE 'rl-%@example.com'") as { n: number };
  check("f7 only the 5 under-limit rows inserted", n.n === 5, `count ${n.n}`);
}

console.log(failures === 0 ? "\nALL WAITLIST CHECKS PASSED" : `\n${failures} WAITLIST CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
