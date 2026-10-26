-- ============================================================
-- Producer-write protection on pricing columns
-- ============================================================
-- Migration 035 widened brands + moderators UPDATE policies from
-- is_admin() to is_scheduler(). That broke migration 034's contract
-- that "brands UPDATE policy is already admin-only" — a producer
-- using the supabase-js client could fire
--   .from('brands').update({client_rate_cents: 0}).eq('id', …)
-- and overwrite pricing despite the UI hiding the field. Same shape
-- for moderators.rate_cents.
--
-- Postgres RLS WITH CHECK can't reference OLD, only NEW, so we can't
-- enforce "column unchanged unless admin" via a policy. The standard
-- fix is a BEFORE UPDATE trigger that compares OLD vs NEW and raises
-- if a non-admin tries to change a protected column.
--
-- Schedulers can still update every other column on these rows; only
-- the pricing columns require is_admin().
-- ============================================================

-- 1. brands.client_rate_cents ---------------------------------

CREATE OR REPLACE FUNCTION public.enforce_admin_for_brand_pricing()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.client_rate_cents IS DISTINCT FROM OLD.client_rate_cents
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can modify brand pricing (client_rate_cents)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brands_pricing_admin_only ON public.brands;
CREATE TRIGGER brands_pricing_admin_only
  BEFORE UPDATE OF client_rate_cents ON public.brands
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_brand_pricing();

-- Also guard INSERT — a producer creating a new brand should not be
-- able to set client_rate_cents on the way in. A separate trigger
-- because BEFORE INSERT has no OLD row to compare against.
CREATE OR REPLACE FUNCTION public.enforce_admin_for_brand_pricing_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.client_rate_cents IS NOT NULL
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can set brand pricing (client_rate_cents) on insert';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brands_pricing_admin_only_insert ON public.brands;
CREATE TRIGGER brands_pricing_admin_only_insert
  BEFORE INSERT ON public.brands
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_brand_pricing_insert();

-- 2. moderators.rate_cents ------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_admin_for_moderator_rate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.rate_cents IS DISTINCT FROM OLD.rate_cents
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can modify moderator pay rate (rate_cents)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moderators_rate_admin_only ON public.moderators;
CREATE TRIGGER moderators_rate_admin_only
  BEFORE UPDATE OF rate_cents ON public.moderators
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_moderator_rate();

CREATE OR REPLACE FUNCTION public.enforce_admin_for_moderator_rate_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- moderators.rate_cents has NOT NULL DEFAULT 0; treat "DEFAULT 0"
  -- as no pricing change. Only block explicit non-zero values from
  -- a non-admin. (Producers should never need to set it; default
  -- accepts NULL or 0 transparently.)
  IF NEW.rate_cents <> 0
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can set moderator pay rate (rate_cents) on insert';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moderators_rate_admin_only_insert ON public.moderators;
CREATE TRIGGER moderators_rate_admin_only_insert
  BEFORE INSERT ON public.moderators
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_moderator_rate_insert();
