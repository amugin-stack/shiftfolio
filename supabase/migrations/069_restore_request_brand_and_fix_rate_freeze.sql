-- 069_restore_request_brand_and_fix_rate_freeze.sql
--
-- INTENT: repair two regressions I introduced in migrations 065 and 067, both
-- of which are already applied to production.
--
-- ===========================================================================
-- PART 1 -- migration 065 silently reverted migration 045
-- ===========================================================================
--
-- 065's header claims its request_brand() body "was taken programmatically from
-- 023 and asserted byte-identical". The assertion was true and the BASELINE was
-- wrong. 023 is two revisions stale: the live definition was last set by
-- 045_request_brand_copies_phone.sql, which itself rebased on
-- agent2migrations/002. So CREATE OR REPLACE rolled BOTH newer changes back.
--
-- Verifying against the file I edited rather than against the function actually
-- in the database is the whole mistake. `pg_get_functiondef` would have caught
-- it in one query.
--
-- Two things were lost:
--
--   (a) THE PHONE COPY. 045 inserts `phone` when auto-creating a host from a
--       self-serve brand request. 065 dropped that column from the INSERT, so
--       every host auto-created since has hosts.phone = NULL even though they
--       entered a phone at signup. That is precisely the bug 045 was written to
--       fix. It is also now harder to notice: migration 066 moved phone behind
--       an admin accessor, so a missing value and a hidden value look alike.
--
--   (b) THE PRODUCER NOTIFICATION. 045 fans the brand_request notification out
--       to admins AND to the producer who runs that brand. 065 collapsed the
--       recipient set to admins only. 065's header says "same notification
--       columns" -- the columns were the same, the RECIPIENTS were not, and I
--       checked the wrong one.
--
-- This restores 045's body verbatim and re-applies ONLY 065's is_active guard
-- on top. Extracted programmatically again, but from 045 this time, and
-- asserted to differ from 045 by exactly the guard.
--
-- ===========================================================================
-- PART 2 -- migration 067 destroys frozen rates on host-less shifts
-- ===========================================================================
--
-- 067 added the trigger that stamps streams.host_rate_cents at booking. Two of
-- its branches test what host_id IS rather than whether it CHANGED:
--
--     IF TG_OP = 'UPDATE' AND NEW.host_id IS NULL THEN
--       NEW.host_rate_cents := NULL;        -- fires on EVERY update of an
--       RETURN NEW;                         -- already-host-less shift
--     END IF;
--
-- Migration 046 deliberately backfilled host-less completed shifts, in its own
-- words, "so a host assigned to a past shift later still pays out at the
-- historical cell rate". So:
--
--   * Editing the title or notes of a past UNASSIGNED shift wiped a rate 046
--     had computed from the old rate cards -- and 047 dropped those cards, so
--     the value is UNRECOVERABLE. A migration written to enforce CLAUDE.md
--     rule 20 was violating it.
--   * Assigning a host to such a shift re-priced it at TODAY's rate, which is
--     the exact case 046 built the backfill to prevent.
--
-- Fix: both branches now also require that host_id actually changed. Clearing
-- only happens on a real transition (had a host -> has none, or swapped to a
-- different host), never on an incidental update.
--
-- ===========================================================================
-- APPLY ORDER: after 065 and 067. Independent of 063/064/066/068.
-- No data is modified. Safe to re-run.
--
-- >>> APPLY THIS SOON. Part 2 prevents ongoing, silent, unrecoverable loss of
-- >>> frozen rates every time anyone edits a past unassigned shift.
--
-- ROLLBACK: re-apply 045's function and 067's trigger function. But note that
-- rolling back reinstates both bugs; there is no reason to.
--
-- AFTER APPLYING, check how much damage Part 2's window already did:
--
--   SELECT count(*) AS host_less_and_unfrozen
--     FROM public.streams
--    WHERE host_id IS NULL AND host_rate_cents IS NULL
--      AND end_time < (now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC';
--
--   Compare against a pre-067 backup if you have one. Any past host-less shift
--   whose rate is now NULL and was not NULL before lost its 046 value. Those
--   pay via the host's current rate if a host is ever assigned -- wrong, but
--   only reachable if someone assigns a host to an old unassigned slot.

-- ---------------------------------------------------------------------------
-- PART 1: request_brand -- 045's body + 065's guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_brand(p_brand_id uuid)
 RETURNS brand_host_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id     UUID := auth.uid();
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_request     public.brand_host_requests;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  -- Deactivated workers may not request brands (guard from migration 065,
  -- preserved). Checked BEFORE the find-or-create below: filtering that lookup
  -- with `AND is_active` instead would fall through to the auto-create branch
  -- and mint a fresh ACTIVE hosts row for someone deliberately removed.
  IF EXISTS (
    SELECT 1 FROM public.hosts h
    WHERE h.user_id = v_user_id AND NOT h.is_active
  ) THEN
    RAISE EXCEPTION 'Your account is no longer active';
  END IF;

  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_user_id LIMIT 1;

  IF v_host_id IS NULL THEN
    INSERT INTO public.hosts (name, email, phone, user_id)
    SELECT
      COALESCE(NULLIF(p.full_name, ''), p.email, 'New Host'),
      p.email,
      NULLIF(p.phone, ''),
      p.id
    FROM public.profiles p WHERE p.id = v_user_id
    RETURNING id, name INTO v_host_id, v_host_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.brand_hosts
    WHERE brand_id = p_brand_id AND host_id = v_host_id
  ) THEN
    RAISE EXCEPTION 'You are already linked to this brand';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.brand_host_requests
    WHERE host_user_id = v_user_id AND brand_id = p_brand_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending request for this brand';
  END IF;

  SELECT name INTO v_brand_name FROM public.brands WHERE id = p_brand_id;
  IF v_brand_name IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  INSERT INTO public.brand_host_requests (host_user_id, brand_id)
  VALUES (v_user_id, p_brand_id)
  RETURNING * INTO v_request;

  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, request_id)
  SELECT
    recipient_id, 'brand_request', v_host_id, COALESCE(v_host_name, 'New Host'),
    p_brand_id, v_brand_name, v_request.id
  FROM (
    SELECT id AS recipient_id FROM public.profiles WHERE role = 'admin'
    UNION
    SELECT p.user_id AS recipient_id
    FROM public.producers p
    JOIN public.brands b ON b.producer_id = p.id
    WHERE b.id = p_brand_id
      AND p.user_id IS NOT NULL
  ) AS recipients;

  RETURN v_request;
END;
$function$;

-- ---------------------------------------------------------------------------
-- PART 2: freeze_host_rate -- only clear the frozen rate when host_id CHANGES
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.freeze_host_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The host was REMOVED from a shift that had one. Drop the frozen rate so a
  -- future booking stamps fresh rather than inheriting a stale one.
  --
  -- `OLD.host_id IS NOT NULL` is the fix. Without it this fired on every update
  -- to an ALREADY host-less shift -- editing a past unassigned shift's notes
  -- wiped the rate migration 046 backfilled onto it, and 047 dropped the rate
  -- cards that produced it, so the value could not be recovered.
  IF TG_OP = 'UPDATE' AND NEW.host_id IS NULL AND OLD.host_id IS NOT NULL THEN
    NEW.host_rate_cents := NULL;
    RETURN NEW;
  END IF;

  -- The shift moved to a DIFFERENT host. Clear the previous host's frozen rate
  -- so the stamp below re-reads for the new person -- otherwise the IS NULL
  -- guard would keep Alice's rate on a shift now worked by Bob.
  --
  -- Also requires OLD.host_id IS NOT NULL: a NULL -> host transition is a
  -- first assignment, not a swap. For a PAST shift that migration 046 froze,
  -- that distinction is the difference between honouring the historical rate
  -- and silently re-pricing it at today's.
  IF TG_OP = 'UPDATE'
     AND OLD.host_id IS NOT NULL
     AND NEW.host_id IS DISTINCT FROM OLD.host_id THEN
    NEW.host_rate_cents := NULL;
  END IF;

  -- Stamp when there is a host and no frozen rate yet. The IS NULL test is what
  -- enforces rule 20: an ordinary edit leaves an existing rate alone.
  IF NEW.host_id IS NOT NULL AND NEW.host_rate_cents IS NULL THEN
    SELECT COALESCE(h.rate_cents, 0) INTO NEW.host_rate_cents
    FROM public.hosts h
    WHERE h.id = NEW.host_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger definition itself is unchanged from 067; recreated for idempotency.
DROP TRIGGER IF EXISTS trg_freeze_host_rate ON public.streams;
CREATE TRIGGER trg_freeze_host_rate
  BEFORE INSERT OR UPDATE ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_host_rate();

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) The phone copy and producer fan-out are back:
--
--       SELECT pg_get_functiondef(p.oid) LIKE '%NULLIF(p.phone%'      AS has_phone_copy,
--              pg_get_functiondef(p.oid) LIKE '%b.producer_id = p.id%' AS notifies_producer,
--              pg_get_functiondef(p.oid) LIKE '%no longer active%'     AS has_active_guard
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname='public' AND p.proname='request_brand';
--       -- all three must be true
--
-- (b) Editing a past host-less shift no longer wipes its frozen rate.
--     Pick a stream with host_id IS NULL and host_rate_cents IS NOT NULL:
--
--       BEGIN;
--         UPDATE public.streams SET notes = 'probe' WHERE id = '<that stream id>';
--         SELECT host_rate_cents FROM public.streams WHERE id = '<that stream id>';
--         -- MUST be unchanged (before this migration it became NULL)
--       ROLLBACK;
--
-- (c) A genuine host removal still clears it:
--
--       BEGIN;
--         UPDATE public.streams SET host_id = NULL WHERE id = '<a stream WITH a host>';
--         SELECT host_rate_cents FROM public.streams WHERE id = '<same>';
--         -- MUST be NULL
--       ROLLBACK;
