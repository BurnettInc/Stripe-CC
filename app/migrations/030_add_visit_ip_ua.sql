-- Enrich first-party visit attribution with device/bot/geo signals (owner
-- approved 2026-08-26: this is our own site's first-party, token-gated,
-- internal-only analytics — it never touches merchant data or the Stripe App).
--
-- POST /api/track now stores a MASKED IP and the User-Agent on every page
-- visit so query-less / no-referrer visits can be classified for device, bot,
-- and geo (instead of being silently bucketed into "direct"). The raw IP is
-- never stored — see src/visitor-signals.ts maskIp() (IPv4 last-octet dropped,
-- IPv6 host half masked). `country` is derived server-side from a proxy
-- country header (CF-IPCountry) when the platform forwards one — never from an
-- external geo service.
--
-- Applied once via the schema_migrations tracker (same pattern as 013/016/017/
-- 028/029's ADD COLUMN: SQLite has no ADD COLUMN IF NOT EXISTS, so a re-run
-- fails loudly with "duplicate column name" rather than silently corrupting
-- anything). Pre-existing rows are untouched (nullable-with-default), and the
-- UNIQUE(visitor_id, page, ts) dedupe index is unaffected.
ALTER TABLE page_visits ADD COLUMN ip TEXT DEFAULT '';
ALTER TABLE page_visits ADD COLUMN user_agent TEXT DEFAULT '';
ALTER TABLE page_visits ADD COLUMN country TEXT DEFAULT '';
