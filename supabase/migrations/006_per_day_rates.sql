-- ============================================================
-- Per-(weekday, block) shift rates
-- ============================================================
-- Replaces the flat brands.block_rates_cents array with a row-per-cell
-- table so each (day_of_week × block_index) pair can have its own rate.
-- Backfills the new table from existing block_rates_cents (every weekday
-- gets the same rate as the legacy index value).
-- ============================================================

-- 1. New table
CREATE TABLE IF NOT EXISTS public.brand_shift_rates (
  brand_id    UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  day_of_week INT  NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  block_index INT  NOT NULL CHECK (block_index >= 0),
  rate_cents  INT  NOT NULL CHECK (rate_cents >= 0),
  PRIMARY KEY (brand_id, day_of_week, block_index)
);

CREATE INDEX IF NOT EXISTS idx_brand_shift_rates_brand ON public.brand_shift_rates(brand_id);

-- 2. RLS
ALTER TABLE public.brand_shift_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_rates: authenticated read" ON public.brand_shift_rates;
CREATE POLICY "shift_rates: authenticated read"
  ON public.brand_shift_rates FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "shift_rates: admin insert" ON public.brand_shift_rates;
CREATE POLICY "shift_rates: admin insert"
  ON public.brand_shift_rates FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "shift_rates: admin update" ON public.brand_shift_rates;
CREATE POLICY "shift_rates: admin update"
  ON public.brand_shift_rates FOR UPDATE
  USING (public.is_admin());

DROP POLICY IF EXISTS "shift_rates: admin delete" ON public.brand_shift_rates;
CREATE POLICY "shift_rates: admin delete"
  ON public.brand_shift_rates FOR DELETE
  USING (public.is_admin());

-- 3. Backfill from legacy block_rates_cents (each weekday gets the same rate)
INSERT INTO public.brand_shift_rates (brand_id, day_of_week, block_index, rate_cents)
SELECT b.id, dow.day_of_week, r.idx - 1, r.rate
FROM public.brands b
CROSS JOIN generate_series(0, 6) AS dow(day_of_week)
CROSS JOIN LATERAL unnest(b.block_rates_cents) WITH ORDINALITY AS r(rate, idx)
ON CONFLICT (brand_id, day_of_week, block_index) DO NOTHING;

-- 4. Drop the legacy array column
ALTER TABLE public.brands
  DROP COLUMN IF EXISTS block_rates_cents;
