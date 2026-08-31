-- Owner admin-dashboard rework (2026-08): two additive changes.
--
-- 1. page_visits: verified-visit signal + request-header bot signals.
--    * verified — 1 when a SECOND, post-render beacon fired from real JS (the
--      immediate <head> beacon fires before JS runs and is indistinguishable
--      from a bot that fetched the HTML; the post-render beacon only a real
--      browser round-trips. Default 0, so a raw server hit that never executed
--      JS stays 0).
--    * accept_language / accept_encoding — the request's Accept-Language and
--      Accept-Encoding header values (captured server-side in POST /api/track
--      alongside User-Agent). A request with NEITHER header is bot-like (real
--      browsers always send both). Storing the raw values lets the aggregation
--      recompute classification over history without re-seeing the headers.
--    Applied once via the schema_migrations tracker (same pattern as 030's ADD
--    COLUMN — SQLite has no ADD COLUMN IF NOT EXISTS, so a re-run fails loudly
--    rather than silently corrupting). Pre-existing rows get verified=0 and
--    empty header columns, which is honest (never observed executing JS).
--
-- 2. funnel_events — a per-(merchant, event) lifecycle log between landing
--    visit and paid, so the admin dashboard can show the drop-off funnel
--    visits → oauth started → completed → synced → draft → sent → reply → paid
--    (owner ask 2026-08). `visitor_id` carries the originating landing visitor
--    (from cc_vid via merchants.visitor_id) where known, so events can be
--    joined back to page_visits for visitor-attributed funnels. Idempotency:
--    UNIQUE(merchant_id, event) + INSERT OR IGNORE means each event type is
--    recorded at most once per merchant — exactly the "first X per merchant"
--    the funnel wants, with no app-level bookkeeping.
CREATE TABLE IF NOT EXISTS funnel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  event TEXT NOT NULL,
  visitor_id TEXT DEFAULT '',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_events_merchant_event ON funnel_events(merchant_id, event);
CREATE INDEX IF NOT EXISTS idx_funnel_events_ts ON funnel_events(ts);

ALTER TABLE page_visits ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
-- accept_language / accept_encoding are intentionally NULLABLE with NO default:
-- pre-migration rows carry NULL (headers were never captured → the aggregation
-- must NOT apply the absent-header bot heuristic to them, or every historical
-- visit would wrongly become bot). Going forward, POST /api/track ALWAYS writes
-- the header values (the empty string '' when the header is genuinely absent),
-- so '' means "server saw the request and both headers were absent" — the real
-- bot signal — while NULL means "we never looked".
ALTER TABLE page_visits ADD COLUMN accept_language TEXT;
ALTER TABLE page_visits ADD COLUMN accept_encoding TEXT;
