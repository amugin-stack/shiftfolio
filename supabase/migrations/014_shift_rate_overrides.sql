-- ============================================================
-- Per-(date, block) shift rate overrides
-- ============================================================
-- brand_shift_rates holds the *default* per-(weekday, block) rates.
-- This table holds per-DATE overrides — useful for one-off weeks where
-- an admin wants to charge a different rate than the standing template.
--
-- Effective rate = override(date, block) || default(dow, block)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.brand_shift_overrides (
  brand_id    UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  shift_date  DATE NOT NULL,
  block_index INT  NOT NULL CHECK (block_index >= 0),
  rate_cents  INT  NOT NULL CHECK (rate_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, shift_date, block_index)
);

CREATE INDEX IF NOT EXISTS idx_shift_overrides_brand_date
  ON public.brand_shift_overrides(brand_id, shift_date);

ALTER TABLE public.brand_shift_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_overrides: authenticated read" ON public.brand_shift_overrides;
CREATE POLICY "shift_overrides: authenticated read"
  ON public.brand_shift_overrides FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "shift_overrides: admin insert" ON public.brand_shift_overrides;
CREATE POLICY "shift_overrides: admin insert"
  ON public.brand_shift_overrides FOR INSERT WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "shift_overrides: admin update" ON public.brand_shift_overrides;
CREATE POLICY "shift_overrides: admin update"
  ON public.brand_shift_overrides FOR UPDATE USING (public.is_admin());

DROP POLICY IF EXISTS "shift_overrides: admin delete" ON public.brand_shift_overrides;
CREATE POLICY "shift_overrides: admin delete"
  ON public.brand_shift_overrides FOR DELETE USING (public.is_admin());
