-- Waitlist signup source attribution (owner request 2026-08-13: "if 3 real
-- people signed up, who are they and where did they come from?"). The landing
-- page's WaitlistForm now forwards the same referrer / utm_* / visitor_id
-- fields the visit-tracking beacon already collects (see /api/track), so each
-- signup row can be attributed to a channel in the admin panel. Applied at
-- most once via the schema_migrations tracker (pattern of 008–015); columns
-- are NOT NULL with '' default so pre-existing rows stay valid and the
-- existing UNIQUE(email) dedupe is unaffected. Length conventions mirror
-- track.ts: referrer 500, utm_* 200, visitor_id 128 (clamped server-side).
ALTER TABLE waitlist ADD COLUMN referrer TEXT NOT NULL DEFAULT '';
ALTER TABLE waitlist ADD COLUMN utm_source TEXT NOT NULL DEFAULT '';
ALTER TABLE waitlist ADD COLUMN utm_medium TEXT NOT NULL DEFAULT '';
ALTER TABLE waitlist ADD COLUMN utm_campaign TEXT NOT NULL DEFAULT '';
ALTER TABLE waitlist ADD COLUMN utm_content TEXT NOT NULL DEFAULT '';
ALTER TABLE waitlist ADD COLUMN visitor_id TEXT NOT NULL DEFAULT '';
