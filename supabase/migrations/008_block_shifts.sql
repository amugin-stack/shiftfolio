-- ============================================================
-- Blocked shift cells
-- ============================================================
-- A blocked cell is hidden from hosts and crossed out in the
-- admin view. Lives on brand_shift_rates so it's per-(brand,
-- weekday, block_index) like the rate.
-- ============================================================

ALTER TABLE public.brand_shift_rates
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
