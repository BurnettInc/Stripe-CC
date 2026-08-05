import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export interface StripeConnection {
  id: string;
  merchant_id: number;
  access_token: string;
  refresh_token: string | null;
  stripe_publishable_key: string;
  created_at: string;
  updated_at: string;
}

// ── Token encryption at rest ──
// access_token / refresh_token are Stripe OAuth credentials: if the database is
// ever leaked, plaintext tokens would let an attacker act as the merchant's
// Stripe account. We encrypt them with AES-256-GCM under a key derived from
// TOKEN_ENCRYPTION_KEY before writing, and decrypt on read.
//
// Encrypted values are stored as "enc:v1:<iv>:<authTag>:<ciphertext>" (all
// base64). Values without that prefix are legacy plaintext and are returned
// as-is, so existing databases keep working.
const ENC_PREFIX = "enc:v1:";
let encryptionWarningLogged = false;

/**
 * Derive the 32-byte AES-256 key from TOKEN_ENCRYPTION_KEY.
 * Returns null when the env var is unset (plaintext, backward compatible) —
 * a warning is logged once.
 */
function getEncryptionKey(): Buffer | null {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    if (!encryptionWarningLogged) {
      console.warn("[auth] TOKEN_ENCRYPTION_KEY not set — storing Stripe OAuth tokens in plaintext. Set it in production.");
      encryptionWarningLogged = true;
    }
    return null;
  }
  // SHA-256 derive: accepts any key length, always yields a valid 32-byte key.
  return createHash("sha256").update(key).digest();
}

function encryptValue(value: string | null, key: Buffer | null): string | null {
  if (value === null || value === "") return value;
  if (!key) return value; // no key configured — store plaintext (backward compat)
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptValue(value: string | null, key: Buffer | null): string | null {
  if (value === null || value === "") return value;
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext value
  if (!key) {
    console.error("[auth] Cannot decrypt token: TOKEN_ENCRYPTION_KEY is not set");
    return null;
  }
  // Format: enc:v1:<iv>:<authTag>:<ciphertext> — skip the "enc" and "v1"
  // prefix segments when destructuring.
  const [, , ivB64, tagB64, dataB64] = value.split(":");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[auth] Failed to decrypt stored token:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Get a Stripe connection for a merchant from the stripe_connections table.
 * Returns null if no OAuth connection exists. Tokens are decrypted on read.
 */
export function getStripeConnection(db: Database, merchantId: number): StripeConnection | null {
  const row = db
    .query("SELECT * FROM stripe_connections WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(merchantId) as StripeConnection | null;
  if (!row) return null;

  const key = getEncryptionKey();
  return {
    ...row,
    access_token: decryptValue(row.access_token, key) ?? "",
    refresh_token: decryptValue(row.refresh_token, key),
  };
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

  // Encrypt tokens at rest (no-op when TOKEN_ENCRYPTION_KEY is unset).
  const key = getEncryptionKey();
  const accessToken = encryptValue(params.access_token, key);
  const refreshToken = encryptValue(params.refresh_token, key);

  const now = new Date().toISOString();

  if (existing) {
    db.run(
      `UPDATE stripe_connections 
       SET access_token = ?, refresh_token = ?, stripe_publishable_key = ?, updated_at = ?
       WHERE id = ?`,
      [accessToken, refreshToken, params.stripe_publishable_key, now, params.stripe_account_id]
    );
  } else {
    db.run(
      `INSERT INTO stripe_connections (id, merchant_id, access_token, refresh_token, stripe_publishable_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [params.stripe_account_id, params.merchant_id, accessToken, refreshToken, params.stripe_publishable_key, now, now]
    );
  }
}
