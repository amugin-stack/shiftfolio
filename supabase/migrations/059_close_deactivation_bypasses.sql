-- 059_close_deactivation_bypasses.sql
--
-- Fixes seven issues found by two independent adversarial audits of the day's
-- work, before any of them caused harm. Some are bypasses of protections
-- shipped the same day (057/058); others are pre-existing holes those audits
-- surfaced while checking them.
--
-- No data is modified anywhere in this file — only grants, function bodies and
-- one trigger definition. Every statement is idempotent and safe to re-run.
--
-- APPLY ORDER: after 057 and 058.
--
-- ⚠ RUN THIS FIRST and read the NOTICE output. is_admin() gates the ENTIRE
-- access model, so after applying, immediately re-run the 058 verification
-- (impersonate one active and one deactivated host) before trusting anything.
--
-- ROLLBACK: migration 001 holds the original is_admin(); agent2migrations/005
-- holds the original enforce_no_double_booking(); 057 holds the original
-- update_extra_pay_slot() and trigger. Re-GRANT anything revoked here only
-- after fixing the underlying hole described inline.

-- ---------------------------------------------------------------------------
-- 1. HIGH — a deactivated host could still WRITE via book_shift, and thereby
--    win back READ access that 058 revoked.
-- ---------------------------------------------------------------------------
--
-- book_shift/unbook_shift (migration 019) are SECURITY DEFINER, granted to
-- `authenticated`, and resolve the caller with
--   SELECT id FROM hosts WHERE user_id = auth.uid()
-- with NO is_active test. Deactivation only flips the flag and never clears
-- brand_hosts, so the eligibility check still passes.
--
-- 058 revokes SELECT, not the session. A removed contractor holding a live
-- token could POST to /rest/v1/rpc/book_shift and:
--   (a) put themselves on a real, paid shift  -> payroll impact
--   (b) receive the full stream row in the RPC's return value -> RLS bypassed
--   (c) create a row with created_by = auth.uid(), which 058's
--       `OR created_by = auth.uid()` branch then makes PERMANENTLY readable.
--
-- 058's own header claimed this was impossible ("a deactivated worker never
-- created streams"). book_shift falsified that. Corrected below.
--
-- Both functions are ORPHANED — nothing in src/ calls them (hosts stopped
-- self-booking when migration 051 made scheduling admin-only). So revoking is
-- strictly a removal of dead attack surface, not a behaviour change.
-- To restore: GRANT EXECUTE ... TO authenticated, but add `AND is_active` to
-- the host lookup first or the hole comes back with it.
--
-- GUARDED, and that guard is load-bearing: migration 047 DROPPED both
-- functions, but migrations here are applied BY HAND, so whether they exist in
-- this database is a fact about what was actually run — not something the
-- files can tell us. A bare REVOKE on a missing function raises
-- `ERROR: function ... does not exist` and ABORTS THE WHOLE TRANSACTION,
-- which would silently prevent every other fix in this file from applying.
-- This way 059 is correct whether or not 047 was ever applied.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'book_shift'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.book_shift(uuid, timestamptz, timestamptz) FROM authenticated, anon, PUBLIC';
    RAISE NOTICE '059: revoked book_shift (it existed — migration 047 had not removed it here)';
  ELSE
    RAISE NOTICE '059: book_shift absent (already dropped by 047) — nothing to revoke';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'unbook_shift'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.unbook_shift(uuid, timestamptz) FROM authenticated, anon, PUBLIC';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1b. HIGH — is_admin() is the ONE SECURITY DEFINER function without a fixed
--     search_path, and every authorization decision in the app flows through it
-- ---------------------------------------------------------------------------
--
-- Defined in migration 001 as SECURITY DEFINER with an UNQUALIFIED
-- `FROM profiles` and no `SET search_path`. Every RLS policy, all five
-- pricing/rate write triggers (034/036/042/046), prevent_self_role_escalation
-- (053) and is_scheduler/is_brand_scheduler (051) resolve through this single
-- call, executing as its owner. If anything ever resolves a relation named
-- `profiles` ahead of public on the session search_path, is_admin() returns
-- true and the ENTIRE access model opens at once.
--
-- It is also executable by PUBLIC (no REVOKE in 001), so `anon` can call it.
-- Every other SECURITY DEFINER function in the schema already sets
-- search_path; this was the sole hold-out, and it violates the repo's own
-- Tier-2 rule 17. Body is otherwise byte-identical to 001.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ---------------------------------------------------------------------------
-- 1c. HIGH — an unauthenticated caller could spam real contractor emails AND
--     permanently silence shift reminders
-- ---------------------------------------------------------------------------
--
-- `_emit_shift_reminder_notifications(uuid)` (migration 038) is SECURITY
-- DEFINER, does ZERO authorization checks, and has no GRANT/REVOKE — so it
-- inherits PostgreSQL's default of EXECUTE TO PUBLIC, which in Supabase
-- includes `anon`. PostgREST exposes it at /rest/v1/rpc/... (the leading
-- underscore hides nothing).
--
-- Anyone with a stream UUID could loop it. Each call inserts up to 3
-- notifications rows, and the AFTER INSERT trigger from 039 sends a REAL
-- Resend email per row to the host, moderator and producer. Worse, it then
-- sets streams.reminder_sent_at = now(), so the legitimate 2-hour cron
-- reminder skips that shift FOREVER. Unbounded email cost on your Resend
-- account, flooded contractor inboxes, and every real reminder silently killed.
--
-- The pg_cron job runs as `postgres` and is unaffected by this revoke.
REVOKE ALL ON FUNCTION public._emit_shift_reminder_notifications(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. MEDIUM — host_busy_in_range let ANY authenticated user enumerate ANY
--    host's schedule. (Introduced by 057 — my bug.)
-- ---------------------------------------------------------------------------
--
-- It takes an arbitrary p_host_id, runs SECURITY DEFINER (sees every row), has
-- no is_admin() check, and was granted to `authenticated`. Meanwhile
-- hosts_select_authenticated (mig 001) hands every logged-in user the full
-- list of host ids. So any host — or a deactivated one, still `authenticated` —
-- could binary-search time ranges and reconstruct a colleague's exact shift
-- times. That is precisely the isolation 052 created and 058 tightened, and
-- exactly the cross-host visibility the support team asked to prevent.
--
-- Nothing in src/ calls it. It is only ever invoked SERVER-SIDE from inside
-- create_extra_pay_slot / update_extra_pay_slot, which are themselves
-- SECURITY DEFINER — those keep working after this revoke, because a
-- SECURITY DEFINER function executes as its owner, not as the caller.
REVOKE EXECUTE ON FUNCTION public.host_busy_in_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. MEDIUM — un-cancelling a slot skipped the overlap check, allowing a host
--    to be paid twice for the same clock hour. (Introduced by 057 — my bug.)
-- ---------------------------------------------------------------------------
--
-- The old guard re-checked overlap ONLY when the times moved. Both overlap
-- guards ignore status='canceled' rows, so a cancelled window is free real
-- estate for a stream. Sequence:
--   cancel a slot -> a shift is legitimately booked over that window ->
--   un-cancel the slot with unchanged times -> the "times changed" condition
--   is false, so the check never runs.
-- Result: a stream and a paid slot covering the same hour, both billed.
--
-- Fix: also re-check whenever the effective status transitions OUT of
-- 'canceled'. Everything else is byte-identical to 057's version.
CREATE OR REPLACE FUNCTION public.update_extra_pay_slot(
  p_id         UUID,
  p_start      TIMESTAMPTZ DEFAULT NULL,
  p_end        TIMESTAMPTZ DEFAULT NULL,
  p_rate_cents INT         DEFAULT NULL,
  p_brand_id   UUID        DEFAULT NULL,
  p_notes      TEXT        DEFAULT NULL,
  p_status     TEXT        DEFAULT NULL
)
RETURNS public.extra_pay_slots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    public.extra_pay_slots;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  v_status TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can edit paid slots' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.extra_pay_slots WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paid slot not found' USING ERRCODE = 'P0002';
  END IF;

  v_start  := COALESCE(p_start,  v_row.start_time);
  v_end    := COALESCE(p_end,    v_row.end_time);
  v_status := COALESCE(p_status, v_row.status);

  IF v_end <= v_start THEN
    RAISE EXCEPTION 'End must be after start' USING ERRCODE = '22007';
  END IF;

  -- Re-check overlap when the times move OR when this row is being brought
  -- back from 'canceled' — an un-cancel re-occupies a window that other
  -- bookings were allowed to take while it sat cancelled.
  IF v_status <> 'canceled'
     AND (
       (v_start, v_end) IS DISTINCT FROM (v_row.start_time, v_row.end_time)
       OR v_row.status = 'canceled'
     )
     AND public.host_busy_in_range(v_row.host_id, v_start, v_end, p_id) THEN
    RAISE EXCEPTION 'That host is already booked during this time' USING ERRCODE = '23P01';
  END IF;

  UPDATE public.extra_pay_slots
     SET start_time = v_start,
         end_time   = v_end,
         rate_cents = COALESCE(p_rate_cents, v_row.rate_cents),
         brand_id   = COALESCE(p_brand_id,   v_row.brand_id),
         notes      = COALESCE(p_notes,      v_row.notes),
         status     = v_status,
         updated_at = NOW()
   WHERE id = p_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_extra_pay_slot(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_extra_pay_slot(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. LOW — the 057 trigger could block legitimate edits to PAST shifts.
--    (Introduced by 057 — my bug.)
-- ---------------------------------------------------------------------------
--
-- It fires on UPDATE OF host_id, start_time, end_time — i.e. whenever those
-- columns appear in the SET list, changed or not, and StreamEventModal always
-- includes them. So once an overlapping pair exists (only possible via issue 3
-- above), any later admin edit to that stream — even a long-finished one —
-- fails with a raw Postgres error surfaced straight to the UI.
--
-- Every other stream guard (016/018) is future-only. Match that: the point is
-- to stop double-BOOKING, and a shift that has already happened cannot be
-- prevented. Uses the PT-naive now (CLAUDE.md rule 5), not raw NOW().
CREATE OR REPLACE FUNCTION public.enforce_stream_not_overlapping_extra_pay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Past shifts are history; editing them must not be blocked.
  IF NEW.end_time <= (NOW() AT TIME ZONE 'America/Los_Angeles' AT TIME ZONE 'UTC') THEN
    RETURN NEW;
  END IF;

  IF NEW.host_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.extra_pay_slots e
    WHERE e.host_id = NEW.host_id
      AND e.status <> 'canceled'
      AND e.start_time < NEW.end_time
      AND e.end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'That host already has paid setup/training/office hours during this time'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Correction to migration 058's documentation (no code change)
-- ---------------------------------------------------------------------------
--
-- 058's "NOT AFFECTED" list reads as though deactivation is a complete
-- revocation. It is not. A deactivated worker holding a live session can still
-- read the `hosts` and `brands` tables, because hosts_select_authenticated
-- (mig 001) is USING (auth.role() = 'authenticated') with no column limits —
-- exposing every host's name, email, phone and rate_cents, plus brands'
-- client_rate_cents. That is the pre-existing pay/pricing leak tracked
-- separately (feat/lock-pay-columns, migration 055), NOT something 058
-- introduced — but 058 should not be read as having closed it.
COMMENT ON POLICY "streams: read own or admin" ON public.streams IS
  'Deactivated hosts/moderators lose stream reads (mig 058/059). NOTE: this does NOT revoke reads on hosts/brands — that leak is tracked in migration 055 (feat/lock-pay-columns).';

-- ---------------------------------------------------------------------------
-- 6. MEDIUM — the double-booking guard runs under the WRITER's RLS, so it can
--    silently fail to detect a conflict (a false negative — the dangerous way)
-- ---------------------------------------------------------------------------
--
-- enforce_no_double_booking (agent2migrations/005) has no SECURITY clause, so
-- Postgres defaults it to INVOKER. Its EXISTS(...) over public.streams
-- therefore runs under the writer's row-level permissions: any conflicting
-- shift the writer cannot SEE produces no conflict, and the booking is allowed.
--
-- Not exploitable today purely by accident — 051 reduced is_brand_scheduler()
-- to admin-only, and admins can see every row. It goes live the moment
-- producers regain scheduling or any host self-booking path returns, at which
-- point the same person is booked twice in one hour and payroll pays both.
-- 057's own header already flagged this flaw; this fixes it.
--
-- Body is byte-identical to agent2migrations/005 apart from the security
-- clause and search_path — same checks, same ERRCODE, same messages.
CREATE OR REPLACE FUNCTION public.enforce_no_double_booking()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.host_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.streams s
    WHERE s.id <> NEW.id
      AND s.host_id = NEW.host_id
      AND s.start_time < NEW.end_time
      AND s.end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'Host is already booked for an overlapping time slot'
      USING ERRCODE = '23P01';
  END IF;

  IF NEW.moderator_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.streams s
    WHERE s.id <> NEW.id
      AND s.moderator_id = NEW.moderator_id
      AND s.start_time < NEW.end_time
      AND s.end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'Moderator is already booked for an overlapping time slot'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
-- 1) is_admin is pinned and no longer callable by anon:
--      SELECT proname, prosecdef, proconfig FROM pg_proc
--       WHERE proname = 'is_admin';           -- expect proconfig {search_path=public}
-- 2) the reminder RPC is no longer world-executable:
--      SELECT proname, proacl::text FROM pg_proc
--       WHERE proname = '_emit_shift_reminder_notifications';
--    Expect NO '=X/' entry (that entry is the PUBLIC grant).
-- 3) admins can still do everything, and an active host still sees their own
--    shifts — is_admin() gates the whole app, so re-run the 058 checks:
--      the impersonation counts for one active and one deactivated host.
