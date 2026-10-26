-- ============================================================
-- apply_rate_template: snapshot a week's rates as the new defaults
-- and wipe future per-date overrides in one server-side transaction.
-- ============================================================
-- Background: the old client-side flow ran the upsert + DELETE as two
-- separate HTTP calls. With many override rows the DELETE never returned
-- in time. This RPC moves both into one Postgres call so the operation
-- completes in a single network round-trip and a single transaction.
-- Admin-gated inside the function via is_admin().
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

  -- 1. Upsert the new defaults from a JSONB array of
  --    {day_of_week, block_index, rate_cents, is_blocked}
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

  -- 2. Wipe every per-date override on or after p_from_date so the
  --    new defaults take effect for all future weeks.
  WITH d AS (
    DELETE FROM public.brand_shift_overrides
    WHERE brand_id = p_brand_id
      AND shift_date >= p_from_date
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_cleared FROM d;

  RETURN v_cleared;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_rate_template(UUID, JSONB, DATE) TO authenticated;
