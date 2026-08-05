import type { Database } from "bun:sqlite";
import { ensureDefaultMerchant } from "../db";

export async function handleSettings(db: Database, req: Request, merchantId: number): Promise<Response> {
  const headers = { "Content-Type": "application/json" };

  ensureDefaultMerchant(db);

  // GET /settings — return merchant settings
  if (req.method === "GET") {
    const merchant = db.query("SELECT * FROM merchants WHERE id=?").get(merchantId) as { id: number; stripe_account_id: string; email: string; trust_mode: string; created_at: string } | null;
    if (!merchant) {
      return new Response(JSON.stringify({ error: "No merchant found" }), { status: 404, headers });
    }
    return new Response(JSON.stringify({
      id: merchant.id,
      stripe_account_id: merchant.stripe_account_id,
      email: merchant.email,
      trust_mode: merchant.trust_mode,
      created_at: merchant.created_at,
    }), { status: 200, headers });
  }

  // PUT /settings — update trust_mode
  if (req.method === "PUT") {
    let body: { trust_mode?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    if (!body.trust_mode || !["draft", "semi", "full"].includes(body.trust_mode)) {
      return new Response(
        JSON.stringify({ error: "trust_mode must be one of: draft, semi, full" }),
        { status: 400, headers }
      );
    }

    const merchant = db.query("SELECT * FROM merchants WHERE id=?").get(merchantId) as { id: number; stripe_account_id: string; email: string; trust_mode: string; created_at: string } | null;
    if (!merchant) {
      return new Response(JSON.stringify({ error: "No merchant found" }), { status: 404, headers });
    }

    db.run("UPDATE merchants SET trust_mode=? WHERE id=?", [body.trust_mode, merchant.id]);

    const updated = db.query("SELECT * FROM merchants WHERE id = ?").get(merchant.id) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: updated.id,
      stripe_account_id: updated.stripe_account_id,
      email: updated.email,
      trust_mode: updated.trust_mode,
      created_at: updated.created_at,
    }), { status: 200, headers });
  }

  return new Response("Method not allowed", { status: 405 });
}
