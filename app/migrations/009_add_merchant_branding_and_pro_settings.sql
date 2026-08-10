-- Merchant settings pack (homepage parity): custom sender branding (Standard),
-- custom escalation timing (Pro) and late-fee automation (Pro, informational).
-- All six columns land in one migration; the API gates each group by tier.
ALTER TABLE merchants ADD COLUMN sender_name TEXT DEFAULT NULL;
ALTER TABLE merchants ADD COLUMN reply_to TEXT DEFAULT NULL;
ALTER TABLE merchants ADD COLUMN stage1_days INTEGER NOT NULL DEFAULT 6;
ALTER TABLE merchants ADD COLUMN stage2_days INTEGER NOT NULL DEFAULT 20;
ALTER TABLE merchants ADD COLUMN late_fee_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE merchants ADD COLUMN late_fee_value REAL NOT NULL DEFAULT 0;
