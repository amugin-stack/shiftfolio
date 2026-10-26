-- 089: Auto-scheduler engine (SMS yes/no coverage offers). ADDITIVE ONLY.
--
-- INTENT: fill EMPTY host/moderator roles on shifts an admin already created.
-- The bot texts one eligible person at a time, books the first YES through the
-- normal guarded UPDATE on public.streams, moves on after NO/timeout, and
-- escalates to the studio manager when it runs out of people. It never creates,
-- moves, splits or deletes shifts and never touches shifts that have started, so
-- its only payroll effect is "this person worked a block the admin created".
-- Every bot booking is recorded in public.bot_bookings and can be undone.
--
-- SAFETY DEFAULTS: scheduler_runtime ships enabled=false AND dry_run=true, and
-- no cron job is scheduled here. Nothing is texted: this migration only queues
-- rows into public.sms_outbox; the Twilio dispatcher ships in a later migration.
--
-- TIME: stream times are PT-naive (PT wall clock stored in UTC fields). "Now"
-- for comparisons against streams is always public._sched_now_pt(). Offer
-- expiry, quiet-hour checks and the daily cap use real instants.
--
-- APPLY: after 088. No app deploy dependency (no existing code reads these).
-- ROLLBACK: cron.unschedule('auto-scheduler') if scheduled, then
--   restore 078's staff_unavailability_guard body (identity line only differs),
--   UPDATE public.scheduler_runtime SET enabled=false; tables may stay (history).
--   To remove entirely (irreversible, loses the audit log): drop the functions,
--   then bot_bookings, sms_inbound_log, sms_outbox, coverage_offers,
--   coverage_requests, scheduler_runtime, sms_contacts, brand_moderators.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Pools, contacts, runtime
-- ---------------------------------------------------------------------------
-- Moderator pool per brand (mirrors brand_hosts from 011, but admin-only read).
CREATE TABLE public.brand_moderators (
  brand_id     UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  moderator_id UUID NOT NULL REFERENCES public.moderators(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, moderator_id)
);
CREATE INDEX ON public.brand_moderators (moderator_id);

-- One row per textable phone. A dual-role worker has one phone mapped to both
-- their host and moderator rows. Kept out of hosts/moderators because those
-- tables have column-level contact grants (061/066) we must not loosen.
CREATE TABLE public.sms_contacts (
  phone_e164      TEXT PRIMARY KEY CHECK (phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  host_id         UUID UNIQUE REFERENCES public.hosts(id) ON DELETE CASCADE,
  moderator_id    UUID UNIQUE REFERENCES public.moderators(id) ON DELETE CASCADE,
  opt_in_at       TIMESTAMPTZ,
  opt_in_source   TEXT,
  opted_out_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No "must belong to a worker" check on purpose: when a worker changes
  -- number, the old row is detached (both ids NULL) but KEPT, so its consent
  -- and STOP history survive (TCPA record-keeping). Detached rows are never
  -- offered shifts because candidates join through host_id / moderator_id.
);

CREATE TABLE public.scheduler_runtime (
  singleton                  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled                    BOOLEAN NOT NULL DEFAULT false,
  dry_run                    BOOLEAN NOT NULL DEFAULT true,
  lookahead_days             INTEGER NOT NULL DEFAULT 14 CHECK (lookahead_days BETWEEN 1 AND 60),
  expiry_same_day_minutes    INTEGER NOT NULL DEFAULT 20 CHECK (expiry_same_day_minutes BETWEEN 5 AND 240),
  expiry_soon_minutes        INTEGER NOT NULL DEFAULT 120 CHECK (expiry_soon_minutes BETWEEN 5 AND 1440),
  expiry_later_minutes       INTEGER NOT NULL DEFAULT 720 CHECK (expiry_later_minutes BETWEEN 5 AND 2880),
  escalate_before_minutes    INTEGER NOT NULL DEFAULT 90 CHECK (escalate_before_minutes BETWEEN 0 AND 1440),
  quiet_start_hour           INTEGER NOT NULL DEFAULT 21 CHECK (quiet_start_hour BETWEEN 0 AND 23),
  quiet_end_hour             INTEGER NOT NULL DEFAULT 8 CHECK (quiet_end_hour BETWEEN 0 AND 23),
  daily_send_cap             INTEGER NOT NULL DEFAULT 300 CHECK (daily_send_cap BETWEEN 0 AND 5000),
  escalation_phone_e164      TEXT CHECK (escalation_phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  brand_allowlist            UUID[],          -- NULL = all brands; set for a one-brand pilot
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.scheduler_runtime DEFAULT VALUES;

-- ---------------------------------------------------------------------------
-- Coverage work: requests (one per open run), offers, outbound/inbound logs
-- ---------------------------------------------------------------------------
-- A "run" is a set of touching stream rows on one brand missing the same role
-- (the calendar shows them as one shift). run_key = role + sorted stream ids, so
-- an admin edit that reshapes the run naturally resolves the old request.
CREATE TABLE public.coverage_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('host','moderator')),
  brand_id      UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  stream_ids    UUID[] NOT NULL CHECK (cardinality(stream_ids) >= 1),
  run_start     TIMESTAMPTZ NOT NULL,   -- PT-naive
  run_end       TIMESTAMPTZ NOT NULL,   -- PT-naive
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','escalated','parked','filled','resolved')),
  escalated_at  TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (run_end > run_start)
);
CREATE UNIQUE INDEX coverage_requests_one_active
  ON public.coverage_requests (run_key) WHERE status IN ('open','escalated','parked');
CREATE INDEX ON public.coverage_requests (status, run_start);

CREATE TABLE public.coverage_offers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES public.coverage_requests(id) ON DELETE CASCADE,
  worker_id     UUID NOT NULL,          -- hosts.id or moderators.id per request.role
  phone_e164    TEXT NOT NULL,
  reply_code    TEXT NOT NULL CHECK (reply_code ~ '^[0-9]{4}$'),
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','yes','no','timeout','stale','dry_run')),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  responded_at  TIMESTAMPTZ
);
-- At most one live offer per request: the bot can never double-offer a slot.
CREATE UNIQUE INDEX coverage_offers_one_pending
  ON public.coverage_offers (request_id) WHERE state = 'pending';
CREATE UNIQUE INDEX coverage_offers_code_per_phone
  ON public.coverage_offers (phone_e164, reply_code) WHERE state = 'pending';
CREATE INDEX ON public.coverage_offers (worker_id, sent_at);
CREATE INDEX ON public.coverage_offers (state, expires_at);

CREATE TABLE public.sms_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_e164         TEXT NOT NULL CHECK (to_e164 ~ '^\+1[2-9][0-9]{9}$'),
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 480),
  kind            TEXT NOT NULL CHECK (kind IN ('offer','escalation')),
  offer_id        UUID REFERENCES public.coverage_offers(id) ON DELETE SET NULL,
  request_id      UUID REFERENCES public.coverage_requests(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','accepted','failed','canceled','dry_run')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_sid    TEXT UNIQUE,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at     TIMESTAMPTZ
);
CREATE INDEX ON public.sms_outbox (state, next_attempt_at);
CREATE INDEX ON public.sms_outbox (created_at);

-- Every inbound text, kept as the consent/"who said yes first" record.
-- provider_sid makes replies idempotent when the provider retries a webhook.
CREATE TABLE public.sms_inbound_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_sid  TEXT NOT NULL UNIQUE,
  from_e164     TEXT NOT NULL,
  body          TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  reply_body    TEXT,
  offer_id      UUID REFERENCES public.coverage_offers(id) ON DELETE SET NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.bot_bookings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES public.coverage_requests(id),
  offer_id    UUID NOT NULL UNIQUE REFERENCES public.coverage_offers(id),
  role        TEXT NOT NULL CHECK (role IN ('host','moderator')),
  worker_id   UUID NOT NULL,
  stream_ids  UUID[] NOT NULL,
  booked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at   TIMESTAMPTZ,
  undone_by   UUID REFERENCES public.profiles(id)
);
CREATE INDEX ON public.bot_bookings (booked_at DESC);

-- ---------------------------------------------------------------------------
-- RLS: admin-only everywhere. The engine runs as the table owner (cron) and the
-- webhook path goes through SECURITY DEFINER functions granted to service_role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.brand_moderators   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_contacts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_runtime  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coverage_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coverage_offers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_outbox         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_inbound_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_bookings       ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brand_moderators: admin all" ON public.brand_moderators
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "sms_contacts: admin all" ON public.sms_contacts
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "scheduler_runtime: admin read" ON public.scheduler_runtime
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "scheduler_runtime: admin update" ON public.scheduler_runtime
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "coverage_requests: admin read" ON public.coverage_requests
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "coverage_offers: admin read" ON public.coverage_offers
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "sms_outbox: admin read" ON public.sms_outbox
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "sms_inbound_log: admin read" ON public.sms_inbound_log
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "bot_bookings: admin read" ON public.bot_bookings
  FOR SELECT TO authenticated USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_moderators TO authenticated;
-- No DELETE on sms_contacts: consent/STOP history is kept (detach instead).
GRANT SELECT, INSERT, UPDATE ON public.sms_contacts TO authenticated;
GRANT SELECT, UPDATE ON public.scheduler_runtime TO authenticated;
GRANT SELECT ON public.coverage_requests, public.coverage_offers, public.sms_outbox,
  public.sms_inbound_log, public.bot_bookings TO authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION public._sched_now_pt() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT (now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'
$$;

-- "SAMPLE BRAND A Thu 9/25 2:00-6:00pm" from PT-naive bounds.
CREATE FUNCTION public._sched_shift_label(p_brand TEXT, p_start timestamptz, p_end timestamptz)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT upper(p_brand) || ' ' ||
    to_char(p_start AT TIME ZONE 'UTC', 'Dy FMMM/FMDD FMHH12:MI') ||
    CASE WHEN to_char(p_start AT TIME ZONE 'UTC','am') = to_char(p_end AT TIME ZONE 'UTC','am')
         THEN '' ELSE lower(to_char(p_start AT TIME ZONE 'UTC','am')) END ||
    '-' || lower(to_char(p_end AT TIME ZONE 'UTC', 'FMHH12:MIam'))
$$;

-- Open runs in the lookahead window, only for brand/role pairs with a pool.
-- Host runs: touching rows on one brand with
-- no host. Moderator runs: touching rows on one brand, same (non-self-moderating)
-- host, no moderator. Only shifts that have not started.
CREATE FUNCTION public._sched_open_runs()
RETURNS TABLE (run_key TEXT, role TEXT, brand_id UUID, stream_ids UUID[],
               run_start timestamptz, run_end timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH rt AS (SELECT * FROM public.scheduler_runtime WHERE singleton),
  cand AS (
    SELECT s.id, s.brand_id, s.start_time, s.end_time, 'host'::text AS role,
           NULL::uuid AS host_key
    FROM public.streams s, rt
    WHERE s.host_id IS NULL
      -- The bot manages a role on a brand only once that brand has a pool for it.
      AND EXISTS (SELECT 1 FROM public.brand_hosts bh WHERE bh.brand_id = s.brand_id)
      AND s.start_time > public._sched_now_pt()
      AND s.start_time < public._sched_now_pt() + make_interval(days => rt.lookahead_days)
      AND (rt.brand_allowlist IS NULL OR s.brand_id = ANY(rt.brand_allowlist))
    UNION ALL
    SELECT s.id, s.brand_id, s.start_time, s.end_time, 'moderator', s.host_id
    FROM public.streams s JOIN public.hosts h ON h.id = s.host_id, rt
    WHERE s.moderator_id IS NULL AND NOT h.self_moderating
      AND EXISTS (SELECT 1 FROM public.brand_moderators bm WHERE bm.brand_id = s.brand_id)
      AND s.start_time > public._sched_now_pt()
      AND s.start_time < public._sched_now_pt() + make_interval(days => rt.lookahead_days)
      AND (rt.brand_allowlist IS NULL OR s.brand_id = ANY(rt.brand_allowlist))
  ),
  marked AS (
    SELECT c.*, CASE WHEN lag(c.end_time) OVER w = c.start_time THEN 0 ELSE 1 END AS brk
    FROM cand c
    WINDOW w AS (PARTITION BY c.role, c.brand_id, c.host_key ORDER BY c.start_time, c.id)
  ),
  grouped AS (
    SELECT m.*, sum(m.brk) OVER (PARTITION BY m.role, m.brand_id, m.host_key
                                 ORDER BY m.start_time, m.id) AS grp
    FROM marked m
  )
  SELECT g.role || ':' || array_to_string(array_agg(g.id ORDER BY g.id), ','),
         g.role, g.brand_id, array_agg(g.id ORDER BY g.start_time),
         min(g.start_time), max(g.end_time)
  FROM grouped g
  GROUP BY g.role, g.brand_id, g.host_key, g.grp
$$;

-- Ranked eligible people for a request: in the brand pool, active, opted in,
-- not absent on any PT day the run touches (078), not booked or in an active
-- extra-pay slot at an overlapping time, not already offered this request, and
-- not holding another live offer that overlaps. Fewest booked minutes that PT
-- week first, then longest since their last offer.
CREATE FUNCTION public._sched_candidates(p_request UUID)
RETURNS TABLE (worker_id UUID, phone_e164 TEXT)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH r AS (SELECT * FROM public.coverage_requests WHERE id = p_request),
  pool AS (
    SELECT h.id AS worker_id, c.phone_e164
    FROM r JOIN public.brand_hosts bh ON bh.brand_id = r.brand_id AND r.role = 'host'
    JOIN public.hosts h ON h.id = bh.host_id AND h.is_active
    JOIN public.sms_contacts c ON c.host_id = h.id
    WHERE c.opt_in_at IS NOT NULL AND c.opted_out_at IS NULL
    UNION ALL
    SELECT m.id, c.phone_e164
    FROM r JOIN public.brand_moderators bm ON bm.brand_id = r.brand_id AND r.role = 'moderator'
    JOIN public.moderators m ON m.id = bm.moderator_id AND m.is_active
    JOIN public.sms_contacts c ON c.moderator_id = m.id
    WHERE c.opt_in_at IS NOT NULL AND c.opted_out_at IS NULL
  )
  SELECT p.worker_id, p.phone_e164
  FROM pool p, r
  WHERE NOT EXISTS (SELECT 1 FROM public.coverage_offers o
                    WHERE o.request_id = r.id AND o.worker_id = p.worker_id)
    AND NOT EXISTS (SELECT 1 FROM public.streams s
                    WHERE (CASE r.role WHEN 'host' THEN s.host_id ELSE s.moderator_id END) = p.worker_id
                      AND s.start_time < r.run_end AND s.end_time > r.run_start)
    AND NOT EXISTS (SELECT 1 FROM public.extra_pay_slots x
                    WHERE (CASE r.role WHEN 'host' THEN x.host_id ELSE x.moderator_id END) = p.worker_id
                      AND x.status <> 'canceled'
                      AND x.start_time < r.run_end AND x.end_time > r.run_start)
    AND NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
                    WHERE (CASE r.role WHEN 'host' THEN u.host_id ELSE u.moderator_id END) = p.worker_id
                      AND u.start_date <= ((r.run_end - interval '1 microsecond') AT TIME ZONE 'UTC')::date
                      AND u.end_date   >= (r.run_start AT TIME ZONE 'UTC')::date)
    AND NOT EXISTS (SELECT 1 FROM public.coverage_offers o2
                    JOIN public.coverage_requests r2 ON r2.id = o2.request_id
                    WHERE o2.worker_id = p.worker_id AND o2.state = 'pending'
                      AND r2.run_start < r.run_end AND r2.run_end > r.run_start)
  ORDER BY
    (SELECT coalesce(sum(extract(epoch FROM (s.end_time - s.start_time)) / 60), 0)
       FROM public.streams s
      WHERE (CASE r.role WHEN 'host' THEN s.host_id ELSE s.moderator_id END) = p.worker_id
        AND s.start_time >= date_trunc('week', r.run_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND s.start_time <  (date_trunc('week', r.run_start AT TIME ZONE 'UTC') + interval '7 days') AT TIME ZONE 'UTC'),
    (SELECT max(o.sent_at) FROM public.coverage_offers o WHERE o.worker_id = p.worker_id) NULLS FIRST,
    p.worker_id
$$;

-- Queue a text, honoring dry-run and the rolling 24h send cap.
CREATE FUNCTION public._sched_queue_sms(p_to TEXT, p_body TEXT, p_kind TEXT,
                                        p_offer UUID, p_request UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public AS $$
DECLARE rt public.scheduler_runtime;
BEGIN
  SELECT * INTO rt FROM public.scheduler_runtime WHERE singleton;
  IF (SELECT count(*) FROM public.sms_outbox
       WHERE created_at > now() - interval '24 hours' AND state <> 'dry_run') >= rt.daily_send_cap
     AND NOT rt.dry_run THEN
    RETURN false;
  END IF;
  INSERT INTO public.sms_outbox (to_e164, body, kind, offer_id, request_id, state)
  VALUES (p_to, p_body, p_kind, p_offer, p_request,
          CASE WHEN rt.dry_run THEN 'dry_run' ELSE 'queued' END);
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Let the bot's booking step past 078's admin-only gate (approved by Alex
-- 2026-09-24, CLAUDE.md rule 6). ONLY the identity line changes; the body is
-- 078's, verified byte-identical to production (md5(prosrc) below) first.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public._sched_bot_booking_active() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(current_setting('studio.sched_bot_txn', true), '') = txid_current()::text
$$;
REVOKE ALL ON FUNCTION public._sched_bot_booking_active() FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.staff_unavailability_guard()'::regprocedure)
     <> '4e7adc099da3a143c86ec4c5de7f3476' THEN
    RAISE EXCEPTION '089: staff_unavailability_guard differs from 078; rebase this change on the live definition first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.staff_unavailability_guard() RETURNS trigger
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
  -- 089: the auto-scheduler's booking step (sched_handle_sms_reply) is the one
  -- non-admin writer. It marks its own transaction; every conflict check below
  -- still runs for it. Nothing reachable through PostgREST can set the mark.
  IF NOT public._sched_bot_booking_active()
     AND (auth.uid() IS NULL OR NOT coalesce(public.is_admin(), false)) THEN
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

-- ---------------------------------------------------------------------------
-- The tick (pg_cron every 3 minutes once activated in a later migration)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public._run_auto_scheduler() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  rt public.scheduler_runtime;
  v_now_pt timestamptz := public._sched_now_pt();
  v_pt_hour integer := extract(hour FROM v_now_pt AT TIME ZONE 'UTC');
  v_quiet boolean;
  r record; c record;
  v_urgency text; v_expiry integer; v_code text; v_offer uuid; v_brand text;
  v_offers integer := 0;
BEGIN
  SELECT * INTO rt FROM public.scheduler_runtime WHERE singleton;
  IF NOT rt.enabled THEN RETURN 0; END IF;
  -- One tick at a time; a slow tick is skipped, never overlapped.
  IF NOT pg_try_advisory_xact_lock(hashtext('auto-scheduler')) THEN RETURN 0; END IF;

  v_quiet := CASE WHEN rt.quiet_start_hour > rt.quiet_end_hour
                  THEN v_pt_hour >= rt.quiet_start_hour OR v_pt_hour < rt.quiet_end_hour
                  ELSE v_pt_hour >= rt.quiet_start_hour AND v_pt_hour < rt.quiet_end_hour END;

  -- 1. Expire live offers.
  UPDATE public.coverage_offers SET state = 'timeout', responded_at = now()
   WHERE state = 'pending' AND expires_at <= now();

  -- 2. Sync requests with the calendar. Runs that vanished (admin filled,
  --    reshaped, deleted, or the shift started) resolve; their live offer
  --    becomes stale so a late YES cannot book it.
  DROP TABLE IF EXISTS pg_temp._runs;
  CREATE TEMP TABLE _runs ON COMMIT DROP AS SELECT * FROM public._sched_open_runs();
  UPDATE public.coverage_offers o SET state = 'stale', responded_at = now()
    FROM public.coverage_requests q
   WHERE o.request_id = q.id AND o.state = 'pending'
     AND q.status IN ('open','escalated')
     AND NOT EXISTS (SELECT 1 FROM _runs x WHERE x.run_key = q.run_key);
  UPDATE public.coverage_requests q SET status = 'resolved', closed_at = now()
   WHERE q.status IN ('open','escalated','parked')
     AND NOT EXISTS (SELECT 1 FROM _runs x WHERE x.run_key = q.run_key);
  INSERT INTO public.coverage_requests (run_key, role, brand_id, stream_ids, run_start, run_end)
  SELECT x.run_key, x.role, x.brand_id, x.stream_ids, x.run_start, x.run_end FROM _runs x
  ON CONFLICT (run_key) WHERE status IN ('open','escalated','parked') DO NOTHING;

  -- 3. Offer the next candidate on every active request with no live offer.
  FOR r IN
    SELECT q.* FROM public.coverage_requests q
     WHERE q.status IN ('open','escalated')
       AND NOT EXISTS (SELECT 1 FROM public.coverage_offers o
                        WHERE o.request_id = q.id AND o.state IN ('pending','dry_run'))
     ORDER BY q.run_start
     FOR UPDATE SKIP LOCKED
  LOOP
    v_urgency := CASE
      WHEN (r.run_start AT TIME ZONE 'UTC')::date = (v_now_pt AT TIME ZONE 'UTC')::date THEN 'same_day'
      WHEN r.run_start < v_now_pt + interval '48 hours' THEN 'soon'
      ELSE 'later' END;
    CONTINUE WHEN v_quiet AND v_urgency <> 'same_day';
    v_expiry := CASE v_urgency WHEN 'same_day' THEN rt.expiry_same_day_minutes
                               WHEN 'soon' THEN rt.expiry_soon_minutes
                               ELSE rt.expiry_later_minutes END;
    SELECT name INTO v_brand FROM public.brands WHERE id = r.brand_id;

    SELECT * INTO c FROM public._sched_candidates(r.id) LIMIT 1;
    IF NOT FOUND THEN
      IF r.status = 'open' THEN
        UPDATE public.coverage_requests SET status = 'escalated', escalated_at = now() WHERE id = r.id;
        IF rt.escalation_phone_e164 IS NOT NULL THEN
          PERFORM public._sched_queue_sms(rt.escalation_phone_e164,
            'Studio bot: could not fill ' || public._sched_shift_label(v_brand, r.run_start, r.run_end)
            || ' (' || r.role || '). Tried ' ||
            (SELECT count(*) FROM public.coverage_offers WHERE request_id = r.id) ||
            ' people. Open Live Hub to assign.', 'escalation', NULL, r.id);
        END IF;
      END IF;
      CONTINUE;
    END IF;

    -- Reply code unique among this phone's live offers.
    LOOP
      v_code := lpad((floor(random() * 10000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.coverage_offers
                             WHERE phone_e164 = c.phone_e164 AND reply_code = v_code AND state = 'pending');
    END LOOP;
    INSERT INTO public.coverage_offers (request_id, worker_id, phone_e164, reply_code, state, expires_at)
    VALUES (r.id, c.worker_id, c.phone_e164, v_code,
            CASE WHEN rt.dry_run THEN 'dry_run' ELSE 'pending' END,
            now() + make_interval(mins => v_expiry))
    RETURNING id INTO v_offer;
    IF NOT public._sched_queue_sms(c.phone_e164,
         'Studio: Open ' || r.role || ' shift, ' ||
         public._sched_shift_label(v_brand, r.run_start, r.run_end) ||
         '. Reply YES ' || v_code || ' to take it or NO ' || v_code ||
         '. Expires in ' || v_expiry || ' min.', 'offer', v_offer, r.id) THEN
      -- Daily cap hit: withdraw the offer and stop for this tick.
      DELETE FROM public.coverage_offers WHERE id = v_offer;
      EXIT;
    END IF;
    v_offers := v_offers + 1;
  END LOOP;

  -- 4. Same-day deadline escalation even while offers are still going out.
  FOR r IN
    SELECT q.* FROM public.coverage_requests q
     WHERE q.status = 'open'
       AND q.run_start <= v_now_pt + make_interval(mins => rt.escalate_before_minutes)
  LOOP
    UPDATE public.coverage_requests SET status = 'escalated', escalated_at = now() WHERE id = r.id;
    IF rt.escalation_phone_e164 IS NOT NULL THEN
      SELECT name INTO v_brand FROM public.brands WHERE id = r.brand_id;
      PERFORM public._sched_queue_sms(rt.escalation_phone_e164,
        'Studio bot: ' || public._sched_shift_label(v_brand, r.run_start, r.run_end)
        || ' (' || r.role || ') still open close to start. Still texting people; you may want to assign it in Live Hub.',
        'escalation', NULL, r.id);
    END IF;
  END LOOP;

  RETURN v_offers;
END $$;

-- ---------------------------------------------------------------------------
-- Inbound replies (called only by the sms-inbound Edge Function, service_role)
-- ---------------------------------------------------------------------------
-- Returns the text to send back (NULL = send nothing). Idempotent per
-- provider_sid. Identity comes only from the verified sender phone number.
CREATE FUNCTION public.sched_handle_sms_reply(p_provider_sid TEXT, p_from TEXT, p_body TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev public.sms_inbound_log;
  v_text text := upper(btrim(regexp_replace(coalesce(p_body,''), '\s+', ' ', 'g')));
  v_word text; v_code text;
  v_contact public.sms_contacts;
  o public.coverage_offers; q public.coverage_requests;
  v_brand text; v_reply text; v_outcome text; v_booked integer;
BEGIN
  SELECT * INTO v_prev FROM public.sms_inbound_log WHERE provider_sid = p_provider_sid;
  IF FOUND THEN RETURN v_prev.reply_body; END IF;

  SELECT * INTO v_contact FROM public.sms_contacts WHERE phone_e164 = p_from;
  v_word := coalesce(substring(v_text FROM '^[A-Z]+'), '');
  v_code := substring(v_text FROM '([0-9]{4})');

  IF v_contact.phone_e164 IS NULL THEN
    v_outcome := 'unknown_sender'; v_reply := NULL;
  ELSIF v_word IN ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','OPTOUT','REVOKE')
        OR v_text ~ '\m(STOP|DON''T) TEXT' THEN
    UPDATE public.sms_contacts SET opted_out_at = now() WHERE phone_e164 = p_from;
    UPDATE public.coverage_offers SET state = 'no', responded_at = now()
     WHERE phone_e164 = p_from AND state = 'pending';
    v_outcome := 'opt_out'; v_reply := NULL;       -- the provider sends the STOP confirmation
  ELSIF v_word IN ('START','UNSTOP') THEN
    UPDATE public.sms_contacts SET opted_out_at = NULL WHERE phone_e164 = p_from;
    v_outcome := 'opt_in'; v_reply := NULL;
  ELSIF v_word IN ('YES','Y','NO','N') THEN
    -- Resolve the offer: by code, or the only live offer for this phone.
    SELECT * INTO o FROM public.coverage_offers
     WHERE phone_e164 = p_from AND state = 'pending'
       AND (v_code IS NULL OR reply_code = v_code)
     ORDER BY sent_at DESC LIMIT 2;
    IF NOT FOUND THEN
      v_outcome := 'no_live_offer';
      v_reply := 'Studio: that offer has expired or was already filled. Thanks for replying!';
    ELSIF v_code IS NULL AND (SELECT count(*) FROM public.coverage_offers
                               WHERE phone_e164 = p_from AND state = 'pending') > 1 THEN
      v_outcome := 'ambiguous';
      v_reply := 'Studio: you have more than one open offer. Reply YES or NO with the 4-digit code from the text.';
    ELSIF v_word IN ('NO','N') THEN
      UPDATE public.coverage_offers SET state = 'no', responded_at = now() WHERE id = o.id;
      v_outcome := 'declined'; v_reply := 'Studio: no problem, thanks for letting us know.';
    ELSE
      -- YES: lock request, then offer, then the stream rows; all checks inside.
      SELECT * INTO q FROM public.coverage_requests WHERE id = o.request_id FOR UPDATE;
      SELECT * INTO o FROM public.coverage_offers WHERE id = o.id FOR UPDATE;
      SELECT name INTO v_brand FROM public.brands WHERE id = q.brand_id;
      IF o.state <> 'pending' OR o.expires_at <= now() OR q.status NOT IN ('open','escalated') THEN
        v_outcome := 'too_late';
        v_reply := 'Studio: sorry, that shift is no longer available.';
      ELSE
        PERFORM 1 FROM public.streams WHERE id = ANY(q.stream_ids) FOR UPDATE;
        BEGIN
          -- Scoped to this subtransaction: reverted automatically on error, and
          -- cleared explicitly below on success.
          PERFORM set_config('studio.sched_bot_txn', txid_current()::text, true);
          IF q.role = 'host' THEN
            UPDATE public.streams SET host_id = o.worker_id
             WHERE id = ANY(q.stream_ids) AND host_id IS NULL
               AND start_time > public._sched_now_pt();
          ELSE
            UPDATE public.streams SET moderator_id = o.worker_id
             WHERE id = ANY(q.stream_ids) AND moderator_id IS NULL
               AND start_time > public._sched_now_pt();
          END IF;
          GET DIAGNOSTICS v_booked = ROW_COUNT;
          IF v_booked <> cardinality(q.stream_ids) THEN
            RAISE EXCEPTION 'run changed' USING ERRCODE = 'P0001';
          END IF;
          PERFORM set_config('studio.sched_bot_txn', '', true);
          UPDATE public.coverage_offers SET state = 'yes', responded_at = now() WHERE id = o.id;
          UPDATE public.coverage_requests SET status = 'filled', closed_at = now() WHERE id = q.id;
          INSERT INTO public.bot_bookings (request_id, offer_id, role, worker_id, stream_ids)
          VALUES (q.id, o.id, q.role, o.worker_id, q.stream_ids);
          v_outcome := 'booked';
          v_reply := 'Studio: you''re booked for ' ||
            public._sched_shift_label(v_brand, q.run_start, q.run_end) || '. Thank you!';
        EXCEPTION WHEN OTHERS THEN
          -- A guard said no (double booking, unavailability, deactivation) or
          -- the run changed. Nothing above persisted; retire this offer.
          UPDATE public.coverage_offers SET state = 'stale', responded_at = now() WHERE id = o.id;
          v_outcome := 'booking_rejected:' || SQLSTATE;
          v_reply := 'Studio: sorry, we could not book that shift for you. the support team will follow up if needed.';
        END;
      END IF;
    END IF;
  ELSE
    v_outcome := 'help';
    v_reply := 'Studio shift bot: reply YES or NO with the 4-digit code from an offer. Reply STOP to stop texts. Questions: contact the support team.';
  END IF;

  INSERT INTO public.sms_inbound_log (provider_sid, from_e164, body, outcome, reply_body, offer_id)
  VALUES (p_provider_sid, p_from, left(coalesce(p_body,''), 1600), v_outcome, v_reply,
          CASE WHEN o.id IS NOT NULL THEN o.id END);
  RETURN v_reply;
END $$;

-- ---------------------------------------------------------------------------
-- Undo (admin, from the Bot bookings page)
-- ---------------------------------------------------------------------------
-- Clears ONLY the role the bot set, ONLY on rows still holding that worker and
-- not yet started. p_refill=false keeps the run from being re-offered.
CREATE FUNCTION public.sched_undo_bot_booking(p_booking UUID, p_refill BOOLEAN DEFAULT true)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.bot_bookings; v_n integer;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501'; END IF;
  SELECT * INTO b FROM public.bot_bookings WHERE id = p_booking FOR UPDATE;
  IF NOT FOUND OR b.undone_at IS NOT NULL THEN RETURN 0; END IF;
  IF b.role = 'host' THEN
    UPDATE public.streams SET host_id = NULL
     WHERE id = ANY(b.stream_ids) AND host_id = b.worker_id AND start_time > public._sched_now_pt();
  ELSE
    UPDATE public.streams SET moderator_id = NULL
     WHERE id = ANY(b.stream_ids) AND moderator_id = b.worker_id AND start_time > public._sched_now_pt();
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.bot_bookings SET undone_at = now(), undone_by = auth.uid() WHERE id = b.id;
  IF NOT p_refill AND v_n > 0 THEN
    -- Park the reopened run: tracked (so it resolves when an admin fills it)
    -- but never offered by the tick.
    INSERT INTO public.coverage_requests (run_key, role, brand_id, stream_ids, run_start, run_end, status)
    SELECT x.run_key, x.role, x.brand_id, x.stream_ids, x.run_start, x.run_end, 'parked'
      FROM public._sched_open_runs() x WHERE x.stream_ids && b.stream_ids AND x.role = b.role
    ON CONFLICT (run_key) WHERE status IN ('open','escalated','parked') DO NOTHING;
  END IF;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public._sched_now_pt(), public._sched_shift_label(text,timestamptz,timestamptz),
  public._sched_open_runs(), public._sched_candidates(uuid),
  public._sched_queue_sms(text,text,text,uuid,uuid), public._run_auto_scheduler(),
  public.sched_handle_sms_reply(text,text,text), public.sched_undo_bot_booking(uuid,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sched_handle_sms_reply(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sched_undo_bot_booking(uuid,boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
