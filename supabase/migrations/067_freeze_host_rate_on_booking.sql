-- 067_freeze_host_rate_on_booking.sql
--
-- INTENT: actually freeze a shift's host pay rate when the shift is booked, so
-- that giving somebody a raise stops silently re-pricing work they already did
-- and were already paid for.
--
-- ---------------------------------------------------------------------------
-- THE BUG
-- ---------------------------------------------------------------------------
--
-- `streams.host_rate_cents` exists to be the frozen, per-shift record of what a
-- host was paid. Pay resolves through src/lib/payout.ts:
--
--     resolveHostShiftRateCents(streamHostRateCents, hostRateCents)
--       => streamHostRateCents ?? hostRateCents ?? 0
--
-- i.e. "use the frozen rate; fall back to the host's CURRENT flat rate".
--
-- The freeze is stated policy in two places already:
--   * CLAUDE.md rule 20 -- "Frozen fields are write-once history:
--     streams.host_rate_cents ... never overwrite non-null frozen values."
--   * Migration 057's header, on extra-pay slots -- "Raising the training rate
--     from $20 to $25 must NOT silently re-price sessions already worked --
--     last month's payroll has to keep matching what was actually paid. This is
--     the same principle as streams.host_rate_cents (migration 046), applied at
--     insert."
--
-- Except it was never applied at insert. NOTHING writes the column. Grep the
-- application for `host_rate_cents`: every hit is a read, a TypeScript type, or
-- a test fixture. Migration 046 backfilled it ONCE, guarded by
-- `AND s.host_rate_cents IS NULL`, and only for shifts already completed at
-- that time. Every shift booked since has host_rate_cents = NULL forever, and
-- therefore resolves to the live `hosts.rate_cents`.
--
-- Worked example. Alice works 100 hours in July at $30/hr. The July payroll CSV
-- reads $3,000.00 and she is paid it. On 1 August an admin raises her to
-- $35/hr. Re-export the SAME July range and it now reads $3,500.00. Two exports
-- of one closed period differ by $500, with no audit trail and nothing marking
-- either as wrong. Extra-pay slots got the freeze; livestream shifts -- much the
-- larger money -- did not.
--
-- So this is not a new policy decision. It is making the code do what the
-- documented policy already says.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER RATHER THAN APPLICATION CODE
-- ---------------------------------------------------------------------------
--
-- Streams are inserted from several paths (the booking modal, range booking,
-- copy-week) and could be inserted directly through the API. A BEFORE trigger
-- catches all of them and cannot be forgotten by the next code path added. It
-- also keeps the stamp atomic with the insert, so there is no window in which a
-- row exists with a NULL rate.
--
-- ---------------------------------------------------------------------------
-- THE THREE CASES, AND THE ONE JUDGEMENT CALL
-- ---------------------------------------------------------------------------
--
-- 1. INSERT with a host  -> stamp the host's current rate. This is the fix.
--
-- 2. UPDATE that does NOT change host_id -> never touch an existing non-NULL
--    value. That is rule 20, and it is what makes the field history rather than
--    a cache. Editing a shift's time or notes must not re-price it.
--
-- 3. UPDATE that CHANGES host_id -> re-stamp from the NEW host's current rate.
--
--    >>> This is a judgement call, flagged rather than buried. <<<
--    Reassigning a shift to a different person means a different person is
--    being paid. Keeping the previous host's frozen rate would pay Bob at
--    Alice's rate, which is plainly wrong, so "never overwrite" cannot apply
--    across a change of host -- rule 20 is about not corrupting history for the
--    SAME assignment. The cost is that reassigning an already-worked shift
--    re-prices it at the new host's rate TODAY, which may differ from what that
--    host was on at the time. There is no stored history to do better, and
--    reassigning a past shift is rare and deliberate.
--
--    Unassigning (host_id -> NULL) clears the rate, so a later re-booking
--    stamps fresh instead of resurrecting a stale number.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES **NOT** DO: no backfill
-- ---------------------------------------------------------------------------
--
-- Existing rows with host_rate_cents = NULL are left exactly as they are, and
-- keep resolving to the host's current rate — i.e. the old behaviour persists
-- for every shift booked between migration 046 and today.
--
-- That is deliberate. Backfilling them would have to write TODAY'S rate onto
-- historical shifts, which does not recover the rate that was actually in force
-- then — it fabricates history and makes a wrong number look authoritative.
-- Leaving NULL keeps the honest signal "this shift's rate was never frozen".
--
-- So this migration STOPS THE BLEEDING; it does not heal the past. Concretely:
-- after this, a raise no longer re-prices anything booked from now on, but a
-- raise CAN still move the totals for shifts booked before it. If you want the
-- legacy tail frozen too, that needs a decision about what rate to use and a
-- before/after tie-out — a separate, deliberate migration.
--
-- APPLY ORDER: after 046 (creates the column). Independent of 063-066.
-- Modifies no existing rows. Safe to re-run.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_freeze_host_rate ON public.streams;
--   DROP FUNCTION IF EXISTS public.freeze_host_rate();
-- Rows already stamped keep their frozen rate, which is correct — they record
-- what was actually paid.

CREATE OR REPLACE FUNCTION public.freeze_host_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Case 3a: the host was removed. Drop the frozen rate so a future booking
  -- stamps fresh rather than inheriting a stale one.
  IF TG_OP = 'UPDATE' AND NEW.host_id IS NULL THEN
    NEW.host_rate_cents := NULL;
    RETURN NEW;
  END IF;

  -- Case 3b: the shift moved to a DIFFERENT host. Clear the previous host's
  -- frozen rate so the stamp below re-reads for the new person. Without this,
  -- the IS NULL guard would keep Alice's rate on a shift now worked by Bob.
  IF TG_OP = 'UPDATE' AND NEW.host_id IS DISTINCT FROM OLD.host_id THEN
    NEW.host_rate_cents := NULL;
  END IF;

  -- Cases 1 and 3: stamp when there is a host and no frozen rate yet.
  --
  -- The `IS NULL` test is what enforces rule 20: an ordinary edit (changing a
  -- shift's time, notes, moderator, ...) leaves host_rate_cents alone, because
  -- it is already set and host_id did not change. Only a first booking, or a
  -- change of host, can write here.
  --
  -- COALESCE guards the case where the hosts row somehow has no rate: the
  -- column is NOT NULL with a default, so this should be unreachable, but
  -- stamping NULL would silently reintroduce the current-rate fallback.
  IF NEW.host_id IS NOT NULL AND NEW.host_rate_cents IS NULL THEN
    SELECT COALESCE(h.rate_cents, 0) INTO NEW.host_rate_cents
    FROM public.hosts h
    WHERE h.id = NEW.host_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_freeze_host_rate ON public.streams;
CREATE TRIGGER trg_freeze_host_rate
  BEFORE INSERT OR UPDATE ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_host_rate();

COMMENT ON FUNCTION public.freeze_host_rate() IS
  'Stamps streams.host_rate_cents from hosts.rate_cents at booking, and re-stamps only when host_id changes. Migration 067. Without this the column stayed NULL forever and pay fell back to the host''s CURRENT rate, so a raise silently re-priced closed pay periods.';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING (all read-only or rolled back)
-- ---------------------------------------------------------------------------
--
-- (a) The trigger is live:
--
--       SELECT tgname, tgenabled FROM pg_trigger
--        WHERE tgrelid = 'public.streams'::regclass AND NOT tgisinternal;
--
-- (b) A NEW booking gets stamped. Rolled back, so nothing is really created.
--     Substitute a real brand id, a real host id, and a free slot.
--
--       BEGIN;
--         INSERT INTO public.streams (brand_id, host_id, start_time, end_time)
--         VALUES ('<brand uuid>', '<host uuid>',
--                 '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
--         SELECT s.host_rate_cents AS stamped, h.rate_cents AS host_rate
--           FROM public.streams s JOIN public.hosts h ON h.id = s.host_id
--          WHERE s.start_time = '2030-01-01T10:00:00Z';
--         -- stamped MUST equal host_rate
--       ROLLBACK;
--
-- (c) An ordinary edit does NOT re-price (this is rule 20, and the check that
--     matters most). Pick any stream that already has a non-NULL rate:
--
--       BEGIN;
--         UPDATE public.streams SET notes = 'tie-out probe'
--          WHERE id = '<stream uuid with host_rate_cents NOT NULL>';
--         SELECT host_rate_cents FROM public.streams WHERE id = '<same uuid>';
--         -- MUST be unchanged
--       ROLLBACK;
--
-- (d) How much of the table is still on the legacy un-frozen path. This number
--     only ever goes down from here, as old shifts age out of your reporting
--     windows:
--
--       SELECT count(*) FILTER (WHERE host_rate_cents IS NULL AND host_id IS NOT NULL)
--                AS unfrozen_legacy_shifts,
--              count(*) FILTER (WHERE host_rate_cents IS NOT NULL)
--                AS frozen_shifts
--         FROM public.streams;
--
-- (e) PAYROLL TIE-OUT. Export a CLOSED month before and after applying. The
--     totals must be IDENTICAL — this migration stamps only new writes and
--     backfills nothing, so no historical figure may move. If one does, stop.
