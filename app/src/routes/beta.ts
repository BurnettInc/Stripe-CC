import type { Database } from "bun:sqlite";
import { requireSession } from "../middleware/session";
import { requireSupportToken } from "./support";
import { isDevPro } from "../db";

/**
 * Beta-code redemption — self-serve tester unlock (owner 8/21).
 *
 *   POST /api/beta/redeem  (session-authed, like every dashboard route)
 *     { "code": "..." }  → grants the merchant dev_pro=1 (active Pro preview)
 *   POST /api/beta/mint   (Bearer <SUPPORT_API_TOKEN>, same gate as /support/*)
 *     { "codes": [...], "expires_at"?, "max_uses"?, "label"? } → creates codes
 *
 * The redeem flow is the user-facing path that sets `merchants.dev_pro = 1`
 * (which the whole app already treats as an active Pro subscriber — see
 * isDevPro / isActiveProSubscriber). Mints are idempotent so the team/owner can
 * curl them without DB surgery. Mint is gated with the exact same
 * `Authorization: Bearer <SUPPORT_API_TOKEN>` check the /support/* routes use
 * (requireSupportToken), so SUPPORT_API_TOKEN is the one privileged token.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface BetaCodeRow {
  id: number;
  code: string;
  label: string | null;
  max_uses: number;
  used: number;
  expires_at: string | null;
  active: number;
}

type RedeemOutcome = "ok" | "invalid" | "expired" | "already redeemed" | "already active";

const ERROR_MESSAGES: Record<Exclude<RedeemOutcome, "ok">, string> = {
  invalid: "That code isn't valid. Check it and try again.",
  expired: "That code has expired.",
  "already redeemed": "That code has already been redeemed.",
  "already active": "Your Pro plan is already active.",
};

export async function handleBetaRedeem(db: Database, req: Request): Promise<Response> {
  const auth = requireSession(db, req);
  if (auth instanceof Response) return auth;
  const merchantId = auth.merchant_id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return json({ error: "code is required" }, 400);
  }

  // "now" in the same UTC 'YYYY-MM-DD HH:MM:SS' format mint stores expires_at
  // in, so the string comparison is lexicographic (both formats align).
  const now = (db.query("SELECT datetime('now') AS n").get() as { n: string }).n;

  // Single atomic transaction: re-validates inside the write lock and only
  // increments `used` via a guarded UPDATE, so concurrent redemptions of the
  // same code can never oversubscribe the slot (each succeeds exactly up to
  // max_uses). Code-level failures (invalid/expired/already redeemed) take
  // priority; a merchant who is already dev-flagged Pro never consumes a slot.
  // On success the merchant is flipped to dev_pro = 1 and the redemption is
  // recorded to the audit trail.
  const outcome: RedeemOutcome = db.transaction((): RedeemOutcome => {
    const row = db.query("SELECT * FROM beta_codes WHERE code = ?").get(code) as BetaCodeRow | null;
    if (!row || row.active !== 1) return "invalid";
    if (row.expires_at && row.expires_at <= now) return "expired";
    if (row.used >= row.max_uses) return "already redeemed";
    if (isDevPro(db, merchantId)) return "already active";
    const updated = db.run(
      "UPDATE beta_codes SET used = used + 1 " +
        "WHERE id = ? AND used < max_uses AND active = 1 AND (expires_at IS NULL OR expires_at > ?)",
      [row.id, now]
    );
    if (updated.changes === 0) return "already redeemed";
    db.run("INSERT INTO beta_redemptions (beta_code_id, merchant_id) VALUES (?, ?)", [row.id, merchantId]);
    db.run("UPDATE merchants SET dev_pro = 1 WHERE id = ?", [merchantId]);
    return "ok";
  })();

  if (outcome === "ok") {
    return json({ ok: true, message: "Code redeemed — your Pro plan is now active. Refresh the page to continue." }, 200);
  }
  return json({ error: ERROR_MESSAGES[outcome] }, 400);
}

/** Normalize an expires_at value to the stored UTC 'YYYY-MM-DD HH:MM:SS'. */
function normalizeExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept both "YYYY-MM-DDTHH:MM:SS" (ISO) and "YYYY-MM-DD HH:MM:SS".
  return trimmed.replace("T", " ").replace(/Z$/, "");
}

export async function handleBetaMint(db: Database, req: Request): Promise<Response> {
  if (!requireSupportToken(req)) {
    return json({ error: "Unauthorized — missing or invalid SUPPORT_API_TOKEN" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!Array.isArray(body.codes)) {
    return json({ error: "codes must be a non-empty array of strings" }, 400);
  }
  const rawCodes = body.codes.map((c) => (typeof c === "string" ? c.trim() : "")).filter((c) => c.length > 0);
  if (rawCodes.length === 0) {
    return json({ error: "codes must be a non-empty array of strings" }, 400);
  }

  // Explicit expires_at wins; otherwise (omitted/null/empty) default to a
  // code that expires 3 months after minting (owner 8/22). Stored in the same
  // UTC 'YYYY-MM-DD HH:MM:SS' format, so the redeem comparison stays
  // lexicographic. There is deliberately no "permanent code by omission".
  const expiresAt = normalizeExpiresAt(body.expires_at) ??
    (db.query("SELECT datetime('now', '+3 months') AS e").get() as { e: string }).e;
  const maxUsesRaw = body.max_uses === undefined ? 1 : Number(body.max_uses);
  const maxUses = Number.isInteger(maxUsesRaw) && maxUsesRaw >= 1 ? maxUsesRaw : 1;
  const label = typeof body.label === "string" ? body.label.trim() : null;

  const created: string[] = [];
  db.transaction(() => {
    for (const c of rawCodes) {
      const exists = db.query("SELECT id FROM beta_codes WHERE code = ?").get(c);
      if (exists) continue; // idempotent — skip duplicates
      db.run(
        "INSERT INTO beta_codes (code, label, max_uses, expires_at, active) VALUES (?, ?, ?, ?, 1)",
        [c, label, maxUses, expiresAt]
      );
      created.push(c);
    }
  })();

  return json({ ok: true, created }, 200);
}
