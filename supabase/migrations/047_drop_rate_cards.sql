-- ============================================================
-- Drop the per-(brand, weekday, block) rate-card system
-- ============================================================
-- APPLY ONLY AFTER the flat-rate app code (PR for migration 046) is
-- deployed to production. Old deployed code reads these tables; new
-- code never touches them. History is preserved: migration 046 froze
-- every completed shift's rate into streams.host_rate_cents BEFORE
-- this drop, so no payroll figure changes.
-- Removes:
--   * brand_shift_overrides (migration 014) — per-date rate exceptions
--   * brand_shift_rates (migrations 005/006) — weekday/block defaults
--     + is_blocked slot blocking (feature removed with the rate card)
--   * apply_rate_template RPC (migrations 027/028)
-- ============================================================

DROP FUNCTION IF EXISTS public.apply_rate_template(uuid, jsonb, date);

-- book_shift / unbook_shift (migration 010) are dead code — the app books
-- via direct inserts since the StreamEventModal rewrite — and book_shift's
-- body reads brand_shift_rates, which this migration drops. Remove them in
-- the same migration so no broken function is left behind.
DROP FUNCTION IF EXISTS public.book_shift(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.unbook_shift(uuid, timestamptz);

DROP TABLE IF EXISTS public.brand_shift_overrides;
DROP TABLE IF EXISTS public.brand_shift_rates;
