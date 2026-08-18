-- Reply detection v1 (owner 8/18) — deterministic keyword/pattern classification
-- stored on the inbound_replies row at capture time. ADDITIVE to the AI
-- classification (column `classification` from 011) so the two layers never
-- collide: the AI layer keeps its own classification/confidence/draft columns,
-- the deterministic layer owns these three. All three are written once at
-- capture by routes/inbound.ts (never re-written), and are surfaced to the
-- merchant in the notification email, the /replies review queue, and the
-- dashboard task rows.
--
-- detect_classification: payment_claim | promise_to_pay | dispute | question | ambiguous
-- detect_extracted_date: rough date mention extracted for promise_to_pay (e.g.
--                        "Friday", "end of the month", "next week", "15th").
-- action_flag:           exact merchant-facing flag text (owner-approved copy).
ALTER TABLE inbound_replies ADD COLUMN detect_classification TEXT DEFAULT NULL;
ALTER TABLE inbound_replies ADD COLUMN detect_extracted_date TEXT DEFAULT NULL;
ALTER TABLE inbound_replies ADD COLUMN action_flag TEXT DEFAULT NULL;
