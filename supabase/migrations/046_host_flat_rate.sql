-- ============================================================
-- Hosts move to a flat hourly rate (like moderators)
-- ============================================================
-- 1. hosts.rate_cents — flat per-host $/hr, default $30 (3000 cents).
--    Admin-only writes via triggers mirroring migration 036's
--    moderators.rate_cents pattern. The INSERT guard treats the
--    DEFAULT (3000) as "unset" so request_brand() (migration 045,
--    SECURITY DEFINER but caller is non-admin) keeps working.
-- 2. streams.host_rate_cents — frozen historical rate. Backfilled
--    below for shifts already COMPLETED at migration time using the
--    old rate-card resolution (per-date override → weekday/block
--    default → $20/hr fallback, mirroring src/lib/payout.ts
--    resolveShiftRateCents + utils.ts DEFAULT_RATE_CENTS=2000).
--    NULL = "use the host's live flat rate".
-- The rate-card tables are dropped in migration 047, applied only
-- AFTER the new app code deploys (see the design doc's deployment
-- ordering). This migration is purely additive — old code keeps
-- working between 046 and the deploy.
-- ============================================================

-- 1. hosts.rate_cents ------------------------------------------

ALTER TABLE public.hosts
  ADD COLUMN IF NOT EXISTS rate_cents INT NOT NULL DEFAULT 3000
  CHECK (rate_cents >= 0);

CREATE OR REPLACE FUNCTION public.enforce_admin_for_host_rate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.rate_cents IS DISTINCT FROM OLD.rate_cents
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can modify host pay rate (rate_cents)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hosts_rate_admin_only ON public.hosts;
CREATE TRIGGER hosts_rate_admin_only
  BEFORE UPDATE OF rate_cents ON public.hosts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_host_rate();

CREATE OR REPLACE FUNCTION public.enforce_admin_for_host_rate_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- hosts.rate_cents has NOT NULL DEFAULT 3000; treat "DEFAULT 3000"
  -- as no pricing change so self-serve host creation via
  -- request_brand() is unaffected. Only block explicit non-default
  -- values from a non-admin.
  IF NEW.rate_cents <> 3000
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can set host pay rate (rate_cents) on insert';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hosts_rate_admin_only_insert ON public.hosts;
CREATE TRIGGER hosts_rate_admin_only_insert
  BEFORE INSERT ON public.hosts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_host_rate_insert();

-- 2. streams.host_rate_cents (frozen history) ------------------

ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS host_rate_cents INT
  CHECK (host_rate_cents IS NULL OR host_rate_cents >= 0);

COMMENT ON COLUMN public.streams.host_rate_cents IS
  'Frozen host $/hr for shifts completed before the flat-rate migration (046). NULL = use hosts.rate_cents. Backfilled once from the old brand_shift_rates/brand_shift_overrides cards.';

-- Backfill: every COMPLETED shift (end_time <= PT-now) gets the rate
-- the old TypeScript logic would have produced. All completed shifts
-- are frozen — even host-less ones — so a host assigned to a past
-- shift later still pays out at the historical cell rate.
--
-- Old resolution (resolveShiftRateCents):
--   block_index = round((ptHour*60 + ptMin − day_start_minutes) / block_size_minutes)
--   dow         = PT day-of-week (0=Sun)
--   date_key    = PT calendar date
--   rate        = override(date_key, block) ?? default(dow, block) ?? 2000
-- PT fields == UTC fields of the stored timestamp (PT-as-UTC scheme),
-- hence the explicit AT TIME ZONE 'UTC' extracts (session-TZ-proof).
-- Numeric ROUND (half away from zero) matches Math.round here because
-- every operand is non-negative.

WITH resolved AS (
  SELECT
    s.id,
    COALESCE(o.rate_cents, r.rate_cents, 2000) AS rate_cents
  FROM public.streams s
  JOIN public.brands b ON b.id = s.brand_id
  CROSS JOIN LATERAL (
    SELECT
      (EXTRACT(HOUR   FROM (s.start_time AT TIME ZONE 'UTC'))::int * 60
     + EXTRACT(MINUTE FROM (s.start_time AT TIME ZONE 'UTC'))::int)   AS slot_mins,
      EXTRACT(DOW FROM (s.start_time AT TIME ZONE 'UTC'))::int        AS dow,
      (s.start_time AT TIME ZONE 'UTC')::date                          AS date_key
  ) t
  CROSS JOIN LATERAL (
    SELECT ROUND(
      (t.slot_mins - b.day_start_minutes)::numeric
      / NULLIF(b.block_size_minutes, 0)
    )::int AS block_index
  ) bi
  LEFT JOIN public.brand_shift_overrides o
    ON o.brand_id = s.brand_id
   AND o.shift_date = t.date_key
   AND o.block_index = bi.block_index
  LEFT JOIN public.brand_shift_rates r
    ON r.brand_id = s.brand_id
   AND r.day_of_week = t.dow
   AND r.block_index = bi.block_index
  WHERE s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
)
UPDATE public.streams s
SET host_rate_cents = resolved.rate_cents
FROM resolved
WHERE s.id = resolved.id
  AND s.host_rate_cents IS NULL;
