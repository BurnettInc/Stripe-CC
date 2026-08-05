import type { Database } from "bun:sqlite";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function getSessionMerchantId(db: Database, req: Request): number | null {
  const token = readCookie(req, "session");
  if (!token) return null;
  const row = db.query("SELECT merchant_id FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token) as { merchant_id: number } | null;
  return row?.merchant_id ?? null;
}

export function requireSession(db: Database, req: Request): { merchant_id: number } | Response {
  const merchant_id = getSessionMerchantId(db, req);
  if (merchant_id === null) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return { merchant_id };
}
