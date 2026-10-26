-- 078: Admin-managed, inclusive all-day absences in Pacific calendar dates.
-- Apply after 073 and BEFORE deploying the Unavailability page. No existing
-- rows or pay calculations change. Test with scripts/test-unavailability.mjs (local PostgreSQL engine).
-- Rollback: revert the app first; drop the three *_unavailability_guard triggers
-- and staff_unavailability_guard() to stop enforcement. Keep the table so saved
-- absences survive; removing enforcement requires explicit operational approval.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'extra_pay_slots'
      AND column_name = 'moderator_id') THEN
    RAISE EXCEPTION '078 requires migration 073 (moderator extra-pay support) first.';
  END IF;
END $$;

CREATE TABLE public.staff_unavailability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID REFERENCES public.hosts(id) ON DELETE RESTRICT,
  moderator_id UUID REFERENCES public.moderators(id) ON DELETE RESTRICT,
  start_date DATE NOT NULL CHECK (isfinite(start_date)),
  end_date DATE NOT NULL CHECK (isfinite(end_date)),
  CHECK (num_nonnulls(host_id, moderator_id) = 1),
  CHECK (end_date >= start_date)
);
CREATE INDEX ON public.staff_unavailability(host_id, end_date, start_date);
CREATE INDEX ON public.staff_unavailability(moderator_id, end_date, start_date);
ALTER TABLE public.staff_unavailability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_unavailability FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.staff_unavailability TO authenticated;
CREATE POLICY "unavailability: admin only" ON public.staff_unavailability
  FOR ALL TO authenticated USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- Scheduling takes a shared transaction lock; recording an absence takes the
-- exclusive counterpart. Unrelated bookings run concurrently, while an absence
-- cannot pass a booking check (or another absence check) before commit.
-- VOLATILE (the default) gives each check a fresh READ COMMITTED snapshot after
-- the lock. Supabase/PostgREST writes use READ COMMITTED; reject other isolation
-- levels rather than checking a stale snapshot. Names/reasons are never exposed
-- by these errors; the absence table itself is admin-only.
CREATE FUNCTION public.staff_unavailability_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_conflict RECORD;
  v_users UUID[];
  v_hosts UUID[];
  v_moderators UUID[];
  v_prep_start TIMESTAMPTZ;
  v_moderator_user UUID;
BEGIN
  -- BEFORE triggers run before RLS WITH CHECK: reject unauthorized writes here
  -- before reading protected dates or acquiring a lock.
  IF auth.uid() IS NULL OR NOT coalesce(public.is_admin(), false) THEN
    RAISE EXCEPTION 'Only admins can change scheduling availability.';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Scheduling availability checks require READ COMMITTED isolation.';
  END IF;
  IF TG_TABLE_NAME = 'staff_unavailability' THEN
    PERFORM pg_advisory_xact_lock(780078);
  ELSE
    PERFORM pg_advisory_xact_lock_shared(780078);
  END IF;
  -- One person may have both roster roles. Link by account UUID only, never
  -- by name; unlinked workers remain identified by their own roster row.
  SELECT array_agg(user_id) INTO v_users FROM (
    SELECT user_id FROM public.hosts WHERE id = NEW.host_id
    UNION SELECT user_id FROM public.moderators WHERE id = NEW.moderator_id
  ) people WHERE user_id IS NOT NULL;
  v_hosts := ARRAY(SELECT id FROM public.hosts
    WHERE id = NEW.host_id OR user_id = ANY(v_users));
  v_moderators := ARRAY(SELECT id FROM public.moderators
    WHERE id = NEW.moderator_id OR user_id = ANY(v_users));
  IF TG_TABLE_NAME = 'staff_unavailability' THEN
    IF EXISTS (SELECT 1 FROM public.staff_unavailability u
      WHERE u.id <> NEW.id
        AND (u.host_id = ANY(v_hosts) OR u.moderator_id = ANY(v_moderators))
        AND u.start_date <= NEW.end_date AND u.end_date >= NEW.start_date) THEN
      RAISE EXCEPTION 'This person already has unavailable dates in this range. Remove the existing entry first if you need to replace it.';
    END IF;
    -- Dates describe PT wall-clock fields stored as UTC, NOT actual PT instants.
    v_start := NEW.start_date::timestamp AT TIME ZONE 'UTC';
    v_end := (NEW.end_date + 1)::timestamp AT TIME ZONE 'UTC';
    IF EXISTS (
      SELECT 1 FROM public.streams s
      WHERE (s.host_id = ANY(v_hosts) OR s.moderator_id = ANY(v_moderators))
        AND s.end_time > v_start
        AND (s.start_time < v_end OR (
          s.moderator_id = ANY(v_moderators)
          AND s.start_time >= '2026-07-22T00:00:00Z'::timestamptz
          AND s.start_time - CASE
            WHEN s.start_time >= '2026-08-24T00:00:00Z'::timestamptz
              THEN interval '60 minutes' ELSE interval '30 minutes' END < v_end
        ))
    ) OR EXISTS (
      SELECT 1 FROM public.extra_pay_slots e
      WHERE (e.host_id = ANY(v_hosts) OR e.moderator_id = ANY(v_moderators))
        AND e.status <> 'canceled' AND e.start_time < v_end AND e.end_time > v_start
    ) THEN
      RAISE EXCEPTION 'This person already has scheduled work during these dates. Reassign or cancel that work before adding unavailability.';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'extra_pay_slots' THEN
    IF NEW.status = 'canceled' THEN RETURN NEW; END IF;
  END IF;
  -- All-day absences cover moderator arrival/prep as well as the stream.
  -- Extending each row is equivalent for whole-day checks: a continuation or
  -- suppressed prep crossing midnight already has earlier moderator work on
  -- that day. No payroll/session calculations are changed here.
  v_prep_start := NEW.start_time;
  IF TG_TABLE_NAME = 'streams' AND NEW.moderator_id IS NOT NULL
     AND NEW.start_time >= '2026-07-22T00:00:00Z'::timestamptz THEN
    v_prep_start := NEW.start_time - CASE
      WHEN NEW.start_time >= '2026-08-24T00:00:00Z'::timestamptz
        THEN interval '60 minutes' ELSE interval '30 minutes' END;
    SELECT user_id INTO v_moderator_user FROM public.moderators WHERE id = NEW.moderator_id;
  END IF;
  SELECT u.start_date, u.end_date,
         CASE WHEN u.host_id IS NOT NULL THEN 'Host' ELSE 'Moderator' END AS role
    INTO v_conflict FROM public.staff_unavailability u
    WHERE (u.host_id = ANY(v_hosts) OR u.moderator_id = ANY(v_moderators))
      AND u.end_date >= (v_prep_start AT TIME ZONE 'UTC')::date
      AND (NEW.start_time < ((u.end_date + 1)::timestamp AT TIME ZONE 'UTC') OR (
        v_prep_start < ((u.end_date + 1)::timestamp AT TIME ZONE 'UTC')
        AND (u.moderator_id = NEW.moderator_id
          OR u.host_id IN (SELECT id FROM public.hosts WHERE user_id = v_moderator_user)
          OR u.moderator_id IN (SELECT id FROM public.moderators WHERE user_id = v_moderator_user))
      ))
      AND NEW.end_time > (u.start_date::timestamp AT TIME ZONE 'UTC')
    ORDER BY u.start_date, u.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is unavailable from % through % (Pacific dates). Choose another person or date.',
      v_conflict.role, v_conflict.start_date, v_conflict.end_date;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_unavailability_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER staff_unavailability_guard BEFORE INSERT OR UPDATE
  ON public.staff_unavailability FOR EACH ROW
  EXECUTE FUNCTION public.staff_unavailability_guard();
CREATE TRIGGER streams_unavailability_guard
  BEFORE INSERT OR UPDATE OF host_id, moderator_id, start_time, end_time
  ON public.streams FOR EACH ROW EXECUTE FUNCTION public.staff_unavailability_guard();
CREATE TRIGGER extra_pay_unavailability_guard
  BEFORE INSERT OR UPDATE OF host_id, moderator_id, start_time, end_time, status
  ON public.extra_pay_slots FOR EACH ROW EXECUTE FUNCTION public.staff_unavailability_guard();
NOTIFY pgrst, 'reload schema';
COMMIT;
