-- ============================================================
-- Per-block hourly rates (replaces flat hourly_rate_cents)
-- ============================================================
-- Each brand stores one rate per shift block as an INT array
-- where index 0 = first block of the day, index N-1 = last.
-- Length must equal blockCount = (day_end - day_start) / block_size.
-- ============================================================

-- 1. Add new array column
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS block_rates_cents INT[] NOT NULL DEFAULT ARRAY[]::INT[];

-- 2. Backfill: for each existing brand, build an array of the current
--    flat hourly_rate_cents repeated once per block.
--    Uses array_fill since aggregates aren't allowed directly in UPDATE
--    SET expressions referencing the row's own columns.
UPDATE public.brands
SET block_rates_cents = array_fill(
  hourly_rate_cents,
  ARRAY[GREATEST(
    1,
    FLOOR((day_end_minutes - day_start_minutes)::numeric / block_size_minutes)::int
  )]
)
WHERE COALESCE(array_length(block_rates_cents, 1), 0) = 0;

-- 3. Drop the old flat column
ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_valid_hourly_rate;

ALTER TABLE public.brands
  DROP COLUMN IF EXISTS hourly_rate_cents;
