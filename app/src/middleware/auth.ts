import type { Database } from "bun:sqlite";

export interface StripeConnection {
  id: string;
  merchant_id: number;
  access_token: string;
  refresh_token: string | null;
  stripe_publishable_key: string;
  created_at: string;
  updated_at: string;
}

/**
 * Get a Stripe connection for a merchant from the stripe_connections table.
 * Returns null if no OAuth connection exists.
 */
export function getStripeConnection(db: Database, merchantId: number): StripeConnection | null {
  return db
    .query("SELECT * FROM stripe_connections WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(merchantId) as StripeConnection | null;
}

/**
 * Returns the Stripe secret key to use for API calls.
 * 
 * Priority:
 * 1. OAuth access_token from stripe_connections for the given merchant
 * 2. STRIPE_SECRET_KEY env var (backward compat)
 * 
 * Returns null if neither is available.
 */
export function getStripeKey(db: Database, merchantId: number): string | null {
  const conn = getStripeConnection(db, merchantId);
  if (conn?.access_token) {
    return conn.access_token;
  }
  return process.env.STRIPE_SECRET_KEY || null;
}

/**
 * Store an OAuth connection for a merchant.
 * Upserts: if the same Stripe account ID already exists for this merchant, update it.
 */
export function saveStripeConnection(
  db: Database,
  params: {
    stripe_account_id: string;
    merchant_id: number;
    access_token: string;
    refresh_token: string | null;
    stripe_publishable_key: string;
  }
): void {
  const existing = db
    .query("SELECT id FROM stripe_connections WHERE id = ?")
    .get(params.stripe_account_id) as { id: string } | null;

  const now = new Date().toISOString();

  if (existing) {
    db.run(
      `UPDATE stripe_connections 
       SET access_token = ?, refresh_token = ?, stripe_publishable_key = ?, updated_at = ?
       WHERE id = ?`,
      [params.access_token, params.refresh_token, params.stripe_publishable_key, now, params.stripe_account_id]
    );
  } else {
    db.run(
      `INSERT INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [params.stripe_account_id, params.merchant_id, params.access_token, params.refresh_token, params.stripe_publishable_key, now, now]
    );
  }
}
