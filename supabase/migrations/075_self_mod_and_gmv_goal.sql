-- 075_self_mod_and_gmv_goal.sql
--
-- INTENT (the support team, 2026-09-03, "Performance Tab Upgrade" checklist): moderators
-- become the people who report GMV. Hosts lose that ability -- EXCEPT hosts
-- flagged as "self-moderating", who moderate their own shifts and so are the
-- moderator for the purposes of this rule.
--
-- Also adds the per-host "monthly GMV goal per hour" that the new host-facing
-- dashboard card reads, and a tag recording WHICH ROLE entered each figure so
-- self-entered and moderator-entered numbers can be told apart later.
--
-- DECISION (Alex, 2026-09-03): removing GMV input from ordinary hosts is
-- deliberate and reverses part of migration 074, shipped this morning. 074 gave
-- both roles input; the spec wants moderators to be the single source.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE COVERAGE GAP THIS CREATES -- READ BEFORE APPLYING
-- ---------------------------------------------------------------------------
--
-- After this migration, a session whose shift has NO MODERATOR assigned and
-- whose host is NOT flagged self-moderating has NOBODY who can report its GMV.
-- It will silently never be reported, and nothing will say so.
--
-- This migration closes that by giving ADMINS a write path. They have none
-- today -- set_session_gmv has always been worker-only -- so an admin currently
-- cannot fix or backfill a single figure. That is the safety valve, and it is
-- also just an obvious missing capability.
--
-- Operationally: any host who regularly works unmoderated shifts needs the
-- self_moderating flag set, or an admin has to enter their numbers.
--
-- ---------------------------------------------------------------------------
-- ⚠️ COLUMN GRANTS ARE DENY-BY-DEFAULT -- THE OTHER WAY THIS BREAKS THE SITE
-- ---------------------------------------------------------------------------
--
-- Migration 061 replaced the table-level `GRANT SELECT ON hosts` with an
-- explicit COLUMN LIST, later narrowed by 066. A column added to `hosts` is
-- therefore UNREADABLE by `authenticated` the moment it exists, and PostgREST
-- fails the ENTIRE QUERY rather than returning the field as null. So the first
-- page to `select(... self_moderating ...)` would 500 for every user.
--
-- The GRANT below is therefore not optional. It is written ADDITIVELY -- naming
-- only the two new columns -- rather than restating the whole list. 061's own
-- header records that its lists had to be generated from the LIVE schema
-- because the migration files had drifted from it; restating a list from the
-- files risks re-introducing exactly that. Adding to a column grant does not
-- disturb the existing grants.
--
-- ---------------------------------------------------------------------------
-- APPLY ORDER: after 074. Apply BEFORE deploying the code.
--
-- Applying early is safe for the ADMIN pages (they do not select the new
-- columns until the deploy). It does immediately change WHO MAY WRITE GMV --
-- an ordinary host loses the ability the moment this runs, before the UI stops
-- offering it. Their save would fail with "Not authorized for this session".
-- That window is seconds if you deploy straight after, and the alternative
-- (deploy first) would show self-mod UI backed by a rule that rejects it, which
-- is worse. Apply, then deploy immediately.
--
-- Paste the WHOLE FILE and Run once.
--
-- NO EXISTING GMV VALUE IS READ, MOVED OR CHANGED. Tie-out below.
--
-- ROLLBACK:
--   Re-apply migration 074's set_session_gmv and get_my_session_gmv verbatim.
--   DROP TRIGGER IF EXISTS hosts_gmv_goal_admin_only ON public.hosts;
--   DROP FUNCTION IF EXISTS public.enforce_admin_for_host_gmv_goal();
--   ALTER TABLE public.hosts DROP COLUMN monthly_gmv_goal_cents, DROP COLUMN self_moderating;
--   ALTER TABLE public.streams DROP COLUMN gmv_entered_by_role;
--   (Dropping the columns also drops their grants. Do the code rollback first.)

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Pre-flight
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_session_gmv';

  IF v_src IS NULL THEN
    RAISE EXCEPTION '075 ABORT: set_session_gmv() is missing. Apply 062 and 074 first.';
  END IF;

  -- 074 introduced server-side anchor resolution. This migration rewrites the
  -- function and must carry that forward; if it is not present, the database
  -- predates 074 and rewriting from here would silently drop the anchor fix.
  IF v_src NOT LIKE '%gmv_session_anchor%' THEN
    RAISE EXCEPTION
      '075 ABORT: the live set_session_gmv does not resolve gmv_session_anchor, so 074 was not applied here. Apply 074 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_my_session_gmv'
  ) THEN
    RAISE EXCEPTION '075 ABORT: get_my_session_gmv() is missing. Apply 074 first.';
  END IF;

  RAISE NOTICE '075 pre-flight OK: 074 is live. Proceeding.';
END $$;

-- ---------------------------------------------------------------------------
-- 1. hosts.self_moderating
-- ---------------------------------------------------------------------------
--
-- Copies is_active (migration 054) exactly: additive, NOT NULL with a DEFAULT,
-- no backfill, no new RLS policy (existing hosts policies cover the table and a
-- new column inherits them). No write trigger -- this is not money, and
-- schedulers already manage the roster.
--
-- DEFAULT false is the safe direction: it means "not self-moderating", so
-- nobody gains GMV write access by accident. Every existing host therefore
-- LOSES input when this is applied, which is the intended behaviour -- flag the
-- ones who genuinely self-moderate afterwards.

ALTER TABLE public.hosts
  ADD COLUMN IF NOT EXISTS self_moderating BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.hosts.self_moderating IS
  'This host moderates their own shifts, so they may report session GMV like a moderator. Admin-only write (trigger), because flipping it GRANTS a write path into revenue data. Default false -- see migration 075.';

-- Admin-only to write, unlike is_active.
--
-- is_active needs no trigger because it only takes access AWAY. This flag GIVES
-- it: set_session_gmv below authorizes a host precisely when self_moderating is
-- true, so anyone who can flip it can hand out write access to revenue data.
-- The hosts table is UPDATE-able by any SCHEDULER ("hosts: scheduler update",
-- migration 035), which includes producers -- who are deliberately kept away
-- from money and pricing everywhere else. Without this trigger the UI checkbox
-- would be the only thing standing in the way, and CLAUDE.md rule 26 is explicit
-- that UI role checks are UX, never the boundary.

CREATE OR REPLACE FUNCTION public.enforce_admin_for_host_self_moderating()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.self_moderating IS DISTINCT FROM OLD.self_moderating
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can change whether a host is self-moderating (self_moderating)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hosts_self_moderating_admin_only ON public.hosts;
CREATE TRIGGER hosts_self_moderating_admin_only
  BEFORE UPDATE OF self_moderating ON public.hosts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_host_self_moderating();

-- No INSERT guard: the column defaults to false, so a non-admin creating a host
-- (the self-serve request_brand() path) cannot grant anything. An INSERT that
-- explicitly sets it true is only reachable from admin code, and adding a guard
-- would risk breaking that self-serve path for no gain.

-- ---------------------------------------------------------------------------
-- 2. hosts.monthly_gmv_goal_cents
-- ---------------------------------------------------------------------------
--
-- A GMV-per-hour TARGET, set by an admin, shown to the host on their own page.
--
-- NULLABLE on purpose, so "no goal set" is distinguishable from "a goal of $0".
-- This is the pattern migration 042 used for brands.contracted_hours_per_month
-- and it avoids re-inventing 046's "<> 3000 means unset" hack, which only
-- exists because hosts.rate_cents is NOT NULL with a default.
--
-- READABLE, unlike rate_cents. Migration 055's threat model is other people's
-- PAY and client PRICING; a host's own performance target is neither, and the
-- host is meant to see it. Locking it would cost an accessor RPC, a merge, and
-- a "if the RPC fails it renders 0" footgun for no security gain.
--
-- WRITE-GUARDED, like it. Precedent: migration 042 gave
-- brands.contracted_hours_per_month a full admin-only trigger even though it is
-- a contractual target rather than pay. A goal that a producer or scheduler
-- could quietly move is a goal that means nothing.

ALTER TABLE public.hosts
  ADD COLUMN IF NOT EXISTS monthly_gmv_goal_cents INT
  CHECK (monthly_gmv_goal_cents IS NULL OR monthly_gmv_goal_cents >= 0);

COMMENT ON COLUMN public.hosts.monthly_gmv_goal_cents IS
  'Admin-set monthly GMV-per-hour goal, integer cents. NULL = no goal set (distinct from a zero goal). Admin-only write (trigger). Migration 075.';

CREATE OR REPLACE FUNCTION public.enforce_admin_for_host_gmv_goal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.monthly_gmv_goal_cents IS DISTINCT FROM OLD.monthly_gmv_goal_cents
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can modify a host GMV goal (monthly_gmv_goal_cents)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hosts_gmv_goal_admin_only ON public.hosts;
CREATE TRIGGER hosts_gmv_goal_admin_only
  BEFORE UPDATE OF monthly_gmv_goal_cents ON public.hosts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_host_gmv_goal();

CREATE OR REPLACE FUNCTION public.enforce_admin_for_host_gmv_goal_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- IS NOT NULL rather than 046's "<> default" test: the column is nullable, so
  -- "absent" is unambiguous and the self-serve host-creation path in
  -- request_brand() (which sets no goal) is unaffected. This is 042's cleaner
  -- shape for a nullable guarded column.
  IF NEW.monthly_gmv_goal_cents IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can set a host GMV goal (monthly_gmv_goal_cents) on insert';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hosts_gmv_goal_admin_only_insert ON public.hosts;
CREATE TRIGGER hosts_gmv_goal_admin_only_insert
  BEFORE INSERT ON public.hosts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_for_host_gmv_goal_insert();

-- ---------------------------------------------------------------------------
-- 3. THE GRANT. Without this the site 500s. See the header.
-- ---------------------------------------------------------------------------
--
-- Additive -- names only the new columns, leaves 066's list untouched.
-- Both are safe to expose: a boolean about how someone works, and a host's own
-- performance target. Neither is a pay rate or client pricing.

GRANT SELECT (self_moderating, monthly_gmv_goal_cents) ON public.hosts TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. streams.gmv_entered_by_role
-- ---------------------------------------------------------------------------
--
-- "Self-entered shifts should feed into the same GMV data set/calculations as
-- moderator-entered ones, just tagged so we can tell them apart if needed."
--
-- One shared figure, one column, one pipeline -- exactly as 074 established.
-- This only records WHO TYPED IT. gmv_updated_by already stores the user id,
-- but a user id cannot tell you which HAT they were wearing: the same person
-- can be a host on one shift and a moderator on another, and a self-mod host is
-- a host acting as a moderator. So the role is recorded explicitly rather than
-- derived later from a join that would guess wrong.
--
-- NOT granted to authenticated, matching gmv_updated_by/at from 074: it is
-- read through the accessor, not off the table.

ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS gmv_entered_by_role TEXT
  CHECK (gmv_entered_by_role IS NULL
         OR gmv_entered_by_role IN ('host', 'moderator', 'admin'));

COMMENT ON COLUMN public.streams.gmv_entered_by_role IS
  'Which role the person was acting as when they set gmv_cents: host (self-moderating), moderator, or admin. Derived inside set_session_gmv from auth.uid(), never client-supplied. Migration 075.';

-- ---------------------------------------------------------------------------
-- 5. set_session_gmv -- SAME signature, so this genuinely REPLACES
-- ---------------------------------------------------------------------------
--
-- (uuid, integer) is unchanged, so no DROP is needed and no overload can be
-- created. Contrast migration 073, where the argument list changed and the old
-- signature had to be dropped -- the mistake behind the outage 072 cleaned up.
--
-- Carried forward from 074 UNCHANGED: server-side anchor resolution (the thing
-- that makes one shared figure per session true), the is_active guards, the
-- "session has ended" PT-naive comparison, the non-negative check, the
-- host_id IS NOT NULL rule, and the ERRCODEs.
--
-- WHAT CHANGES: an ordinary host is no longer authorized. The caller must be
-- the active MODERATOR, or the active host WITH self_moderating, or an ADMIN.

CREATE OR REPLACE FUNCTION public.set_session_gmv(
  p_stream_id uuid,
  p_gmv_cents integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_id      uuid;
  v_moderator_id uuid;
  v_end          timestamptz;
  v_anchor_id    uuid;
  v_role         text;
BEGIN
  SELECT s.host_id, s.moderator_id, s.end_time
    INTO v_host_id, v_moderator_id, v_end
  FROM public.streams s
  WHERE s.id = p_stream_id;

  -- Kept from 062/074. A session with no host has no host partition, so GMV
  -- recorded against it is invisible to every admin aggregate.
  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'Session not found or has no host' USING ERRCODE = '22023';
  END IF;

  -- Resolve which hat the caller is wearing. Order matters: moderator is
  -- checked first so that a person who is BOTH the moderator and the (self-mod)
  -- host of the same session is tagged as the moderator, which is the role the
  -- spec treats as the source of truth.
  IF EXISTS (
    SELECT 1 FROM public.moderators m
     WHERE m.id = v_moderator_id
       AND m.user_id = auth.uid()
       AND m.is_active
  ) THEN
    v_role := 'moderator';
  ELSIF EXISTS (
    SELECT 1 FROM public.hosts h
     WHERE h.id = v_host_id
       AND h.user_id = auth.uid()
       AND h.is_active
       AND h.self_moderating          -- the change: ordinary hosts fail here
  ) THEN
    v_role := 'host';
  ELSIF public.is_admin() THEN
    -- The safety valve. Without it, a shift with no moderator and a non-self-mod
    -- host has NOBODY who can report its GMV. Admins had no write path at all
    -- before this migration, so they also could not correct a wrong figure.
    v_role := 'admin';
  ELSE
    RAISE EXCEPTION 'Not authorized for this session' USING ERRCODE = '42501';
  END IF;

  -- Session must have ended (PT wall-clock comparison; see 007's header).
  IF (v_end AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'America/Los_Angeles') THEN
    RAISE EXCEPTION 'Session has not ended yet' USING ERRCODE = '22023';
  END IF;

  IF p_gmv_cents IS NOT NULL AND p_gmv_cents < 0 THEN
    RAISE EXCEPTION 'GMV must be non-negative' USING ERRCODE = '22023';
  END IF;

  -- Write to the CANONICAL anchor, not the row passed in (migration 074).
  v_anchor_id := public.gmv_session_anchor(p_stream_id);

  UPDATE public.streams
     SET gmv_cents          = p_gmv_cents,
         gmv_updated_by     = auth.uid(),
         gmv_updated_at     = NOW(),
         gmv_entered_by_role = v_role
   WHERE id = COALESCE(v_anchor_id, p_stream_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_session_gmv(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_session_gmv(uuid, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. get_my_session_gmv -- mirror the same rule
-- ---------------------------------------------------------------------------
--
-- Return type and arguments unchanged, so this is a plain replace.
--
-- The read rule must match the write rule, or an ordinary host is shown an
-- input box backed by a function that rejects them -- a save that fails for no
-- visible reason. A host who cannot write should not be offered the field.
--
-- Ordinary hosts still see their session GMV, just not through this accessor:
-- get_my_stream_pay already returns gmv_cents for their own shifts and the app
-- renders it read-only. Nobody loses sight of their numbers.

CREATE OR REPLACE FUNCTION public.get_my_session_gmv()
RETURNS TABLE(
  stream_id       UUID,
  gmv_cents       INT,
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.gmv_cents, p.full_name, s.gmv_updated_at
    FROM public.streams s
    LEFT JOIN public.profiles p ON p.id = s.gmv_updated_by
   WHERE s.host_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.moderators m
          WHERE m.id = s.moderator_id
            AND m.user_id = auth.uid()
            AND m.is_active
       )
       OR EXISTS (
         SELECT 1 FROM public.hosts h
          WHERE h.id = s.host_id
            AND h.user_id = auth.uid()
            AND h.is_active
            AND h.self_moderating
       )
     )
   ORDER BY s.id;
$$;

COMMENT ON FUNCTION public.get_my_session_gmv() IS
  'Sessions the caller may REPORT GMV for: ones they moderate, or host when self_moderating. Mirrors set_session_gmv so the UI never offers an input the write path rejects. Migrations 074, 075.';

REVOKE ALL ON FUNCTION public.get_my_session_gmv() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_session_gmv() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) TIE-OUT. Run BEFORE applying and again after -- must be IDENTICAL:
--
--       SELECT count(*) AS reported, sum(gmv_cents) AS total_cents
--         FROM public.streams WHERE gmv_cents IS NOT NULL;
--
-- (b) THE GRANT CHECK. This is the one that decides whether the site loads.
--     Run as a NON-ADMIN; it must return a row, NOT "permission denied":
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<ANY REAL user_id>","role":"authenticated"}';
--         SELECT id, name, self_moderating, monthly_gmv_goal_cents
--           FROM public.hosts LIMIT 1;
--       ROLLBACK;
--
-- (c) Exactly ONE set_session_gmv and ONE get_my_session_gmv (the 072 check):
--
--       SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname = 'public'
--          AND p.proname IN ('set_session_gmv','get_my_session_gmv')
--        ORDER BY p.proname;
--       -- expect exactly 2 rows
--
-- (d) Every host defaulted to NOT self-moderating, and no goal was invented:
--
--       SELECT count(*) FILTER (WHERE self_moderating)               AS self_mods,
--              count(*) FILTER (WHERE monthly_gmv_goal_cents IS NOT NULL) AS with_goal,
--              count(*)                                              AS total
--         FROM public.hosts;
--       -- self_mods = 0 and with_goal = 0 immediately after applying
--
-- (e) BOTH new host columns are admin-only to write. Run each as a NON-ADMIN
--     SCHEDULER (a producer will do) and expect a raise from each.
--
--     The self-mod flag matters most -- it is the one that GRANTS a write path
--     into revenue data, and the hosts table is UPDATE-able by any scheduler:
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A NON-ADMIN SCHEDULER user_id>","role":"authenticated"}';
--         UPDATE public.hosts SET self_moderating = true
--          WHERE id = (SELECT id FROM public.hosts LIMIT 1);
--       ROLLBACK;
--       -- expect: Only admins can change whether a host is self-moderating
--
--     And the goal:
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A NON-ADMIN SCHEDULER user_id>","role":"authenticated"}';
--         UPDATE public.hosts SET monthly_gmv_goal_cents = 12345
--          WHERE id = (SELECT id FROM public.hosts LIMIT 1);
--       ROLLBACK;
--       -- expect: Only admins can modify a host GMV goal
--
-- (f) An ORDINARY host can no longer write GMV. As a non-self-mod host with an
--     ended session, expect 42501 "Not authorized for this session":
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A NON-SELF-MOD HOST user_id>","role":"authenticated"}';
--         SELECT public.set_session_gmv('<one of their ENDED stream ids>', 100);
--       ROLLBACK;
--
--     Then flag that host self_moderating = true and repeat -- it must succeed.
--     THIS PAIR IS THE WHOLE MIGRATION. If it does not behave this way, the
--     access change did not take.
