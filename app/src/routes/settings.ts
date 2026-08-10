import type { Database } from "bun:sqlite";
import { ensureDefaultMerchant, getSubscriptionByMerchantId } from "../db";

interface MerchantRow {
  id: number;
  stripe_account_id: string;
  email: string;
  trust_mode: string;
  paused: number;
  disconnected: number;
  created_at: string;
}

function settingsPayload(merchant: MerchantRow) {
  return {
    id: merchant.id,
    stripe_account_id: merchant.stripe_account_id,
    email: merchant.email,
    trust_mode: merchant.trust_mode,
    paused: merchant.paused === 1,
    // Read-only: set by the account.application.deauthorized webhook handler;
    // surfaced so the UI can show a reconnect prompt. Never writable via PUT.
    disconnected: merchant.disconnected === 1,
    created_at: merchant.created_at,
  };
}

export async function handleSettings(db: Database, req: Request, merchantId: number): Promise<Response> {
  const headers = { "Content-Type": "application/json" };

  ensureDefaultMerchant(db);

  // GET /settings — return merchant settings
  if (req.method === "GET") {
    const merchant = db.query("SELECT * FROM merchants WHERE id=?").get(merchantId) as MerchantRow | null;
    if (!merchant) {
      return new Response(JSON.stringify({ error: "No merchant found" }), { status: 404, headers });
    }
    return new Response(JSON.stringify(settingsPayload(merchant)), { status: 200, headers });
  }

  // PUT /settings — update trust_mode and/or paused (both in one call).
  if (req.method === "PUT") {
    let body: { trust_mode?: unknown; paused?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    const hasTrustMode = body.trust_mode !== undefined;
    const hasPaused = body.paused !== undefined;
    if (!hasTrustMode && !hasPaused) {
      return new Response(
        JSON.stringify({ error: "Nothing to update: provide trust_mode and/or paused" }),
        { status: 400, headers }
      );
    }

    if (hasTrustMode && (typeof body.trust_mode !== "string" || !["draft", "semi", "full"].includes(body.trust_mode))) {
      return new Response(
        JSON.stringify({ error: "trust_mode must be one of: draft, semi, full" }),
        { status: 400, headers }
      );
    }
    const trustMode = body.trust_mode as string | undefined;

    if (hasPaused && typeof body.paused !== "boolean") {
      return new Response(
        JSON.stringify({ error: "paused must be a boolean" }),
        { status: 400, headers }
      );
    }
    const paused = hasPaused ? (body.paused as boolean ? 1 : 0) : null;

    // Full Auto (hands-off sending) is a Pro-only feature: require an active
    // Pro subscription before allowing the merchant to switch to it.
    if (trustMode === "full") {
      const sub = getSubscriptionByMerchantId(db, merchantId);
      if (!sub || sub.tier !== "pro" || sub.status !== "active") {
        return new Response(
          JSON.stringify({ error: "Full Auto mode requires a Pro subscription. Upgrade to unlock." }),
          { status: 402, headers }
        );
      }
    }

    const merchant = db.query("SELECT * FROM merchants WHERE id=?").get(merchantId) as MerchantRow | null;
    if (!merchant) {
      return new Response(JSON.stringify({ error: "No merchant found" }), { status: 404, headers });
    }

    // COALESCE keeps the existing value for fields not supplied in this call.
    db.run("UPDATE merchants SET trust_mode=COALESCE(?, trust_mode), paused=COALESCE(?, paused) WHERE id=?", [
      trustMode ?? null,
      paused,
      merchant.id,
    ]);

    const updated = db.query("SELECT * FROM merchants WHERE id = ?").get(merchant.id) as MerchantRow;
    return new Response(JSON.stringify(settingsPayload(updated)), { status: 200, headers });
  }

  return new Response("Method not allowed", { status: 405 });
}
