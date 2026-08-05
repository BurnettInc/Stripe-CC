import type { Database } from "bun:sqlite";

const jsonHeaders = { "Content-Type": "application/json" };
const modes = ["draft", "semi", "full"];

function resolveInvoice(db: Database, rawId: string) {
  const numericId = Number(rawId);
  if (Number.isInteger(numericId) && numericId > 0) {
    const byId = db.query("SELECT * FROM invoices WHERE id=?").get(numericId);
    if (byId) return byId as Record<string, unknown>;
  }
  return db.query("SELECT * FROM invoices WHERE stripe_invoice_id=?").get(rawId) as Record<string, unknown> | null;
}

function notFound() { return new Response(JSON.stringify({ error: "Invoice not found" }), { status: 404, headers: jsonHeaders }); }

export async function handleInvoices(db: Database, req: Request, rawPath: string, merchantId: number): Promise<Response> {
  const match = rawPath.match(/^\/([^/]+)(?:\/trust-mode)?$/);
  if (!match) return notFound();
  const rawId = decodeURIComponent(match[1]);
  const invoice = resolveInvoice(db, rawId);
  if (!invoice || invoice.merchant_id !== merchantId) return notFound();
  const id = invoice.id as number;
  const isTrustMode = rawPath.endsWith("/trust-mode");

  if (!isTrustMode && req.method === "GET") {
    const task = db.query("SELECT * FROM reminder_tasks WHERE invoice_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(id) as Record<string, unknown> | null;
    const sent = db.query("SELECT COUNT(*) as count, MAX(created_at) as last_send_date FROM send_logs WHERE reminder_task_id=? AND type='reminder' AND status='success'").get((task?.id as number | undefined) ?? -1) as { count: number; last_send_date: string | null };
    const sequenceStatus = task ? { emails_sent: sent.count, last_send_date: sent.last_send_date, next_scheduled: null, active: !["cancelled", "paused"].includes(String(task.status)), paused: task.status === "paused", stage: task.stage, status: task.status } : null;
    return new Response(JSON.stringify({ ...invoice, sequence_status: sequenceStatus }), { headers: jsonHeaders });
  }

  if (isTrustMode && req.method === "GET") {
    return new Response(JSON.stringify({ trust_mode: invoice.trust_mode_override ?? null }), { headers: jsonHeaders });
  }

  if (isTrustMode && req.method === "PUT") {
    let body: { trust_mode?: string | null };
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: jsonHeaders }); }
    if (body.trust_mode !== null && !modes.includes(body.trust_mode ?? "")) {
      return new Response(JSON.stringify({ error: "trust_mode must be draft, semi, full, or null" }), { status: 400, headers: jsonHeaders });
    }
    db.run("UPDATE invoices SET trust_mode_override=? WHERE id=?", [body.trust_mode ?? null, id]);
    return new Response(JSON.stringify({ trust_mode: body.trust_mode ?? null }), { headers: jsonHeaders });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
}
