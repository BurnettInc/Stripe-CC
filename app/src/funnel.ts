/**
 * Funnel-event recording for the admin dashboard (owner rework 2026-08).
 *
 * The `funnel_events` table (migration 033) logs one row per lifecycle event
 * a merchant reaches between their first landing visit and becoming a paying
 * customer: oauth_started → oauth_completed → invoices_synced → first_draft →
 * first_sent → first_reply → paid. The admin dashboard renders these as the
 * visits → … → paid drop-off funnel, so the owner can see where the middle
 * stretch (visit → draft) loses people instead of the old "visit → draft"
 * leap that implied OAuth already happened.
 *
 * Idempotency is structural: the table has UNIQUE(merchant_id, event) and we
 * INSERT OR IGNORE, so each event type is recorded at most once per merchant
 * — exactly the "first X per merchant" the funnel wants, with no app-side
 * bookkeeping and no risk of double counting across webhook retries or sync
 * passes.
 *
 * `visitor_id` (the landing-site cc_vid) is stamped when known so the
 * dashboard can join an event back to its originating landing visitor (and
 * onward to page_visits) for visitor-attributed funnels.
 */
import type { Database } from "bun:sqlite";

/** The funnel event keys recorded against a merchant. */
export type FunnelEvent =
  | "oauth_started"
  | "oauth_completed"
  | "invoices_synced"
  | "first_draft"
  | "first_sent"
  | "first_reply"
  | "paid";

/**
 * Record a funnel event for a merchant. Safe to call anywhere a merchant is
 * known — idempotent per (merchant_id, event). Never throws into a caller's
 * hot path: any DB error is swallowed and logged, because funnel telemetry
 * must never take down webhook handling, sends, or the pipeline.
 */
export function recordFunnelEvent(
  db: Database,
  merchantId: number | null | undefined,
  event: FunnelEvent,
  visitorId?: string | null,
): void {
  if (!merchantId) return;
  try {
    // For the first-draft / first-sent / first-reply / paid events, if no
    // visitor was passed, fall back to the merchant's captured origin visitor.
    const vid =
      (typeof visitorId === "string" && visitorId.trim() ? visitorId : "") ||
      ((
        db
          .query("SELECT visitor_id FROM merchants WHERE id = ?")
          .get(merchantId) as { visitor_id: string | null } | null
      )?.visitor_id ?? "");
    db.run(
      "INSERT OR IGNORE INTO funnel_events (merchant_id, event, visitor_id) VALUES (?, ?, ?)",
      [merchantId, event, vid],
    );
  } catch (err: unknown) {
    console.error(
      `[funnel] recordFunnelEvent(${merchantId}, ${event}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Record a funnel event when the caller only has a reminder_task id (draft /
 * send sites) — resolves the merchant by joining reminder_tasks → invoices.
 * No-op when the task/invoice/merchant chain can't be resolved.
 */
export function recordFunnelEventForTask(
  db: Database,
  taskId: number | null | undefined,
  event: FunnelEvent,
): void {
  if (!taskId) return;
  try {
    const row = db
      .query(
        `SELECT i.merchant_id AS merchant_id, m.visitor_id AS visitor_id
         FROM reminder_tasks rt
         JOIN invoices i ON i.id = rt.invoice_id
         JOIN merchants m ON m.id = i.merchant_id
         WHERE rt.id = ?`,
      )
      .get(taskId) as { merchant_id: number; visitor_id: string } | null;
    if (!row) return;
    recordFunnelEvent(db, row.merchant_id, event, row.visitor_id);
  } catch (err: unknown) {
    console.error(
      `[funnel] recordFunnelEventForTask(${taskId}, ${event}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Compute the funnel stages for the admin dashboard: per-stage merchant counts
 * PLUS a visitor-attributed funnel (stages joined back to the originating
 * landing visitor via funnel_events.visitor_id, so the owner sees the
 * visit → … → paid drop-off as it relates to landing traffic).
 *
 * Returns an ordered list of {event, merchants, visitors}; `visitors` counts
 * distinct funnel_events rows (per merchant) that carry a visitor_id, which is
 * the attribution denominator closest to "landing visits that made it here".
 */
export function funnelStages(db: Database): Array<{ event: string; merchants: number; visitors: number }> {
  const order: FunnelEvent[] = [
    "oauth_started",
    "oauth_completed",
    "invoices_synced",
    "first_draft",
    "first_sent",
    "first_reply",
    "paid",
  ];
  const rows = db
    .query("SELECT event, COUNT(*) AS merchants, COUNT(DISTINCT CASE WHEN visitor_id != '' THEN merchant_id END) AS visitors FROM funnel_events GROUP BY event")
    .all() as Array<{ event: string; merchants: number; visitors: number }>;
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  return order.map((e) => byEvent.get(e) ?? { event: e, merchants: 0, visitors: 0 });
}
