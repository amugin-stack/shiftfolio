-- ============================================================
-- Per-brand contracted hours / month (drives admin dashboard Fill %)
-- ============================================================
-- Admin-only, internal contract figure. Same privacy model as
-- client_rate_cents (migration 034/036): never selected by non-admin
-- code paths, kept out of BRAND_PUBLIC_COLUMNS, and write-protected by
-- the brand-pricing admin-only triggers below. NULL = "not configured"
-- (dashboard renders "—").
-- ============================================================

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS contracted_hours_per_month INTEGER
    CHECK (contracted_hours_per_month IS NULL OR contracted_hours_per_month >= 0);

-- Extend the existing admin-only-write guard (migration 036) to also cover
-- contracted_hours_per_month on UPDATE.
CREATE OR REPLACE FUNCTION public.enforce_admin_for_brand_pricing()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.client_rate_cents IS DISTINCT FROM OLD.client_rate_cents
      OR NEW.contracted_hours_per_month IS DISTINCT FROM OLD.contracted_hours_per_month)
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can modify brand pricing/contract fields';
  END IF;
  RETURN NEW;
END;
$$;

-- Recreate the UPDATE trigger so its column list (OF ...) includes the new column.
DROP TRIGGER IF EXISTS brands_pricing_admin_only ON public.brands;
CREATE TRIGGER brands_pricing_admin_only
  BEFORE UPDATE OF client_rate_cents, contracted_hours_per_month ON public.brands
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_brand_pricing();

-- Extend the INSERT guard the same way (BEFORE INSERT trigger already covers
-- all columns; only the function body needs to change).
CREATE OR REPLACE FUNCTION public.enforce_admin_for_brand_pricing_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.client_rate_cents IS NOT NULL
      OR NEW.contracted_hours_per_month IS NOT NULL)
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can set brand pricing/contract fields on insert';
  END IF;
  RETURN NEW;
END;
$$;
