-- ============================================================
-- Per-brand client rate (what the brand pays Studio, in cents/hour)
-- ============================================================
-- Used to calculate expected revenue on the admin dashboard. This
-- is internal pricing — sensitive. Admin-only.
--
-- Postgres can't conditionally GRANT a column by role expression,
-- so the privacy layer here is defense-in-depth via code paths:
--   1. Non-admin selects in app code never include client_rate_cents.
--   2. An admin-only RPC `get_brand_client_rate` is the authoritative
--      isolated-read path.
--   3. The existing brands UPDATE policy is already admin-only, so
--      writes are safe.
-- ============================================================

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS client_rate_cents INTEGER;

CREATE OR REPLACE FUNCTION public.get_brand_client_rate(p_brand_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT client_rate_cents INTO v_rate FROM public.brands WHERE id = p_brand_id;
  RETURN v_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.get_brand_client_rate(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_brand_client_rate(UUID) TO authenticated;
