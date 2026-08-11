import type { Database } from "bun:sqlite";
import { ensureDefaultMerchant, getSubscriptionByMerchantId, isActivePaidSubscriber } from "../db";

interface MerchantRow {
  id: number;
  stripe_account_id: string;
  email: string;
  trust_mode: string;
  paused: number;
  created_at: string;
  // Merchant settings pack (migration 009):
  sender_name: string | null;
  reply_to: string | null;
  stage1_days: number;
  stage2_days: number;
  late_fee_type: string;
  late_fee_value: number;
}

function settingsPayload(merchant: MerchantRow) {
  return {
    id: merchant.id,
    stripe_account_id: merchant.stripe_account_id,
    email: merchant.email,
    trust_mode: merchant.trust_mode,
    paused: merchant.paused === 1,
    created_at: merchant.created_at,
    // Custom sender branding (Standard+) + Pro settings — always readable so
    // the dashboard can show the values even when the merchant isn't entitled
    // to edit them (locked UI + upgrade note).
    sender_name: merchant.sender_name,
    reply_to: merchant.reply_to,
    stage1_days: merchant.stage1_days,
    stage2_days: merchant.stage2_days,
    late_fee_type: merchant.late_fee_type,
    late_fee_value: merchant.late_fee_value,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A usable email address is required for Reply-To. Empty string clears it. */
function validReplyTo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return true; // empty clears
  return EMAIL_RE.test(v);
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

  // PUT /settings — update trust_mode, paused, and the merchant-settings-pack
  // fields (sender branding for Standard+, escalation timing + late fee for Pro).
  if (req.method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    const hasTrustMode = body.trust_mode !== undefined;
    const hasPaused = body.paused !== undefined;
    const hasBranding = body.sender_name !== undefined || body.reply_to !== undefined;
    const hasTiming = body.stage1_days !== undefined || body.stage2_days !== undefined;
    if (!hasTrustMode && !hasPaused && !hasBranding && !hasTiming) {
      return new Response(
        JSON.stringify({ error: "Nothing to update: provide trust_mode, paused, sender_name, reply_to, stage1_days and/or stage2_days" }),
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

    // ── Custom sender branding (Standard+) ──
    // sender_name: optional display name for the From header (trimmed, ≤80
    // chars; empty string clears). reply_to: optional email for the Reply-To
    // header (valid email, or empty to clear). The from-ADDRESS itself stays
    // the global verified FROM_EMAIL — merchants never get per-merchant
    // from-addresses (one verified Resend domain).
    let senderName: string | null = null;
    let replyTo: string | null = null;
    if (hasBranding) {
      if (body.sender_name !== undefined) {
        if (typeof body.sender_name !== "string") {
          return new Response(JSON.stringify({ error: "sender_name must be a string" }), { status: 400, headers });
        }
        const trimmed = body.sender_name.trim();
        if (trimmed.length > 80) {
          return new Response(
            JSON.stringify({ error: "sender_name must be 80 characters or fewer" }),
            { status: 400, headers }
          );
        }
        senderName = trimmed === "" ? null : trimmed;
      }
      if (body.reply_to !== undefined) {
        if (!validReplyTo(body.reply_to)) {
          return new Response(
            JSON.stringify({ error: "reply_to must be a valid email address (or empty to clear)" }),
            { status: 400, headers }
          );
        }
        replyTo = body.reply_to.trim() === "" ? null : body.reply_to.trim();
      }
      // Any paid plan (Standard or Pro) may brand their reminders.
      if (!isActivePaidSubscriber(db, merchantId)) {
        return new Response(
          JSON.stringify({ error: "Custom sender branding requires a subscription. Upgrade to unlock." }),
          { status: 402, headers }
        );
      }
    }

    // ── Custom escalation timing (Pro) ──
    // stage1_days / stage2_days move the 6-day / 20-day ladder boundaries.
    // Both must be supplied together (the pair defines the whole ladder) and
    // satisfy 1 <= stage1 < stage2 <= 90. Integers only.
    let stage1Days: number | null = null;
    let stage2Days: number | null = null;
    if (hasTiming) {
      if (body.stage1_days === undefined || body.stage2_days === undefined) {
        return new Response(
          JSON.stringify({ error: "stage1_days and stage2_days must be provided together" }),
          { status: 400, headers }
        );
      }
      const s1 = body.stage1_days;
      const s2 = body.stage2_days;
      if (
        typeof s1 !== "number" || !Number.isInteger(s1) ||
        typeof s2 !== "number" || !Number.isInteger(s2)
      ) {
        return new Response(
          JSON.stringify({ error: "stage1_days and stage2_days must be integers" }),
          { status: 400, headers }
        );
      }
      if (!(s1 >= 1 && s1 < s2 && s2 <= 90)) {
        return new Response(
          JSON.stringify({ error: "stage1_days and stage2_days must satisfy 1 <= stage1_days < stage2_days <= 90" }),
          { status: 400, headers }
        );
      }
      // Custom escalation timing is a Pro feature.
      const sub = getSubscriptionByMerchantId(db, merchantId);
      if (!sub || sub.tier !== "pro" || sub.status !== "active") {
        return new Response(
          JSON.stringify({ error: "Custom escalation timing requires a Pro subscription. Upgrade to unlock." }),
          { status: 402, headers }
        );
      }
      stage1Days = s1;
      stage2Days = s2;
    }

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

    // Build the UPDATE from the fields actually supplied — fields can be
    // explicitly cleared (sender_name/reply_to → NULL), so a blanket COALESCE
    // would be wrong for them. trust_mode/paused use the same dynamic shape.
    const sets: string[] = [];
    const params: Array<string | number | boolean | null> = [];
    if (trustMode !== undefined) { sets.push("trust_mode=?"); params.push(trustMode); }
    if (paused !== null) { sets.push("paused=?"); params.push(paused); }
    if (body.sender_name !== undefined) { sets.push("sender_name=?"); params.push(senderName); }
    if (body.reply_to !== undefined) { sets.push("reply_to=?"); params.push(replyTo); }
    if (body.stage1_days !== undefined) { sets.push("stage1_days=?"); params.push(stage1Days); }
    if (body.stage2_days !== undefined) { sets.push("stage2_days=?"); params.push(stage2Days); }
    db.run(`UPDATE merchants SET ${sets.join(", ")} WHERE id=?`, [...params, merchant.id]);

    const updated = db.query("SELECT * FROM merchants WHERE id = ?").get(merchant.id) as MerchantRow;
    return new Response(JSON.stringify(settingsPayload(updated)), { status: 200, headers });
  }

  return new Response("Method not allowed", { status: 405 });
}
