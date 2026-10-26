-- ============================================================
-- apply_rate_template (v2): scope override-clearing to ONLY the
-- (day_of_week, block_index) pairs being updated.
-- ============================================================
-- Previously the RPC wiped EVERY future override for the brand,
-- which clobbered unrelated per-week customizations. Now the
-- delete filters by the same (dow, block) pairs found in the
-- p_defaults payload — so admins can lock in a specific cell's
-- rate forever without disturbing other cells' overrides.
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_rate_template(
  p_brand_id  UUID,
  p_defaults  JSONB,
  p_from_date DATE
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cleared INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can apply rate templates';
  END IF;

  -- 1. Upsert the new defaults
  INSERT INTO public.brand_shift_rates (brand_id, day_of_week, block_index, rate_cents, is_blocked)
  SELECT
    p_brand_id,
    (r->>'day_of_week')::int,
    (r->>'block_index')::int,
    (r->>'rate_cents')::int,
    COALESCE((r->>'is_blocked')::boolean, false)
  FROM jsonb_array_elements(p_defaults) r
  ON CONFLICT (brand_id, day_of_week, block_index) DO UPDATE
    SET rate_cents = EXCLUDED.rate_cents,
        is_blocked = EXCLUDED.is_blocked;

  -- 2. Wipe future overrides ONLY for the (dow, block_index) pairs we just
  --    updated. Other unrelated per-date overrides are preserved.
  --
  -- shift_date is stored as PT calendar date (DATE, no timezone). EXTRACT(dow)
  -- yields Sunday=0, matching JS Date.getDay() — same convention used by the
  -- per-(dow, block) defaults.
  WITH pairs AS (
    SELECT
      (r->>'day_of_week')::int AS dow,
      (r->>'block_index')::int AS idx
    FROM jsonb_array_elements(p_defaults) r
  ),
  d AS (
    DELETE FROM public.brand_shift_overrides o
    WHERE o.brand_id = p_brand_id
      AND o.shift_date >= p_from_date
      AND (EXTRACT(dow FROM o.shift_date)::int, o.block_index) IN
          (SELECT dow, idx FROM pairs)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_cleared FROM d;

  RETURN v_cleared;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_rate_template(UUID, JSONB, DATE) TO authenticated;
