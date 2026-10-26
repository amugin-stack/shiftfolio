-- 073_extra_pay_moderators.sql
--
-- INTENT (the support team, 2026-08-31): extra pay — setup, training, office hours — can
-- only be assigned to HOSTS. Moderators do the same non-livestream paid work
-- and there is nowhere to record it, so it is either unpaid or faked as a
-- livestream shift. Make the slot able to belong to a moderator instead.
--
-- ---------------------------------------------------------------------------
-- SHAPE: a second nullable column, exactly one of which is set
-- ---------------------------------------------------------------------------
--
-- extra_pay_slots.host_id becomes NULLABLE and gains a sibling moderator_id,
-- with a CHECK that exactly one is populated. This mirrors `streams`, which has
-- carried host_id + moderator_id side by side since migration 001, so every
-- reader in the codebase already understands that shape.
--
-- The rejected alternative was a generic (worker_type, worker_id) pair. It
-- reads tidier and is worse: the foreign keys disappear, so nothing at the
-- database level stops a slot pointing at a deleted or non-existent worker, and
-- ON DELETE RESTRICT is the only thing currently preventing someone from
-- deleting a host and silently erasing what they were owed (migration 057).
-- Losing referential integrity on a pay table to save a column is a bad trade.
--
-- Existing rows all have host_id set and moderator_id NULL, so the CHECK is
-- satisfied the moment it is added. No backfill, no data movement.
--
-- ---------------------------------------------------------------------------
-- THE OVERLOAD TRAP, WHICH I WALKED INTO ONCE ALREADY TODAY
-- ---------------------------------------------------------------------------
--
-- create_extra_pay_slot's argument list changes. Migration 072 exists because
-- migration 068 changed a function's arguments with CREATE OR REPLACE and
-- assumed that replaced the old one. It does not: a different argument list is
-- a DIFFERENT FUNCTION, so the old one survives, a call that matches both is
-- ambiguous, and Postgres refuses to run it. That locked every host out of the
-- app for a day.
--
-- So the old signature is DROPPED explicitly below, before the new one is
-- created, and the verify section at the bottom asserts the NUMBER of
-- overloads rather than merely that the new one exists.
--
-- update_extra_pay_slot and enforce_stream_not_overlapping_extra_pay keep
-- their exact existing signatures, so CREATE OR REPLACE genuinely replaces
-- them and no drop is needed. That asymmetry is the whole rule: drop when the
-- arguments move, replace when they don't.
--
-- ---------------------------------------------------------------------------
-- APPLY ORDER: after 057, 058, 059 and 063 (the pre-flight below refuses to
-- run otherwise). Apply BEFORE deploying the code.
--
-- Applying early is safe. PostgREST calls functions by ARGUMENT NAME, not
-- position, so the currently-deployed app calling
-- create_extra_pay_slot(p_host_id => ..., p_kind => ...) still resolves against
-- the new signature with p_moderator_id defaulting to NULL. There is no broken
-- window between applying this and deploying.
--
-- Paste the WHOLE FILE into the SQL editor and Run once — it is one implicit
-- transaction, and running it piecemeal leaves a window where the old
-- create RPC is dropped and the new one does not exist yet.
--
-- ROLLBACK: irreversible in practice once a moderator slot exists — dropping
-- moderator_id would destroy that pay record. To reverse before any moderator
-- slot is created:
--   ALTER TABLE public.extra_pay_slots DROP CONSTRAINT extra_pay_one_worker;
--   ALTER TABLE public.extra_pay_slots DROP COLUMN moderator_id;
--   ALTER TABLE public.extra_pay_slots ALTER COLUMN host_id SET NOT NULL;
--   DROP POLICY "extra_pay: moderator reads own" ON public.extra_pay_slots;
--   DROP FUNCTION public.moderator_busy_in_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID);
--   DROP FUNCTION public.create_extra_pay_slot(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, UUID, UUID, TEXT);
-- then re-run 057's create_extra_pay_slot, 059's update_extra_pay_slot and
-- 059's trigger function verbatim.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Pre-flight — refuse to run against a database that isn't where we think
-- ---------------------------------------------------------------------------
-- Migrations here are applied by hand, so the files cannot tell us what is
-- actually live. Same guard pattern as 063.

DO $$
DECLARE
  v_qual TEXT;
BEGIN
  SELECT qual INTO v_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'extra_pay_slots'
     AND policyname = 'extra_pay: host reads own';

  IF v_qual IS NULL THEN
    RAISE EXCEPTION
      '073 ABORT: policy "extra_pay: host reads own" is missing. Apply 057 then 058 first.';
  END IF;

  IF v_qual NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION
      '073 ABORT: the live extra_pay host policy has no is_active guard, so 058 was not applied here. Apply 058 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'host_busy_in_range'
  ) THEN
    RAISE EXCEPTION '073 ABORT: host_busy_in_range() is missing. Apply 057 first.';
  END IF;

  RAISE NOTICE '073 pre-flight OK. Proceeding.';
END $$;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

ALTER TABLE public.extra_pay_slots
  ADD COLUMN IF NOT EXISTS moderator_id UUID
    REFERENCES public.moderators(id) ON DELETE RESTRICT;

-- ON DELETE RESTRICT, not CASCADE, for the reason migration 057 gives for
-- host_id: these rows ARE pay history, and CASCADE would let deleting a
-- moderator silently erase what they were owed with no error to warn anyone.

ALTER TABLE public.extra_pay_slots
  ALTER COLUMN host_id DROP NOT NULL;

-- Exactly one worker. Belt and braces: without this, host_id becoming nullable
-- would allow a slot belonging to NOBODY (invisible on every page, silently
-- absent from payroll) or to BOTH (paid twice, once on each side of the CSV).
ALTER TABLE public.extra_pay_slots
  DROP CONSTRAINT IF EXISTS extra_pay_one_worker;
ALTER TABLE public.extra_pay_slots
  ADD CONSTRAINT extra_pay_one_worker
  CHECK (num_nonnulls(host_id, moderator_id) = 1);

COMMENT ON COLUMN public.extra_pay_slots.moderator_id IS
  'Set when this paid block belongs to a moderator. Exactly one of host_id / moderator_id is non-null (constraint extra_pay_one_worker). Migration 073.';

-- Mirrors extra_pay_slots_host_start_idx: payroll queries a window per worker.
CREATE INDEX IF NOT EXISTS extra_pay_slots_moderator_start_idx
  ON public.extra_pay_slots (moderator_id, start_time);

-- ---------------------------------------------------------------------------
-- 2. RLS — a moderator reads their own slots
-- ---------------------------------------------------------------------------
--
-- Byte-for-byte the live "extra_pay: host reads own" policy from 063, with
-- hosts -> moderators. All three guards preserved deliberately:
--   user_id = (SELECT auth.uid())   the InitPlan wrapper from 063, so the JWT
--                                   is parsed once per statement not per row
--   user_id IS NOT NULL             an unlinked worker row must not match a
--                                   NULL uid
--   is_active                       a deactivated worker loses access (058)
--
-- Admins are already covered by "extra_pay: admin read all". Producers are
-- still excluded, as 057 intended — this is pay data.

DROP POLICY IF EXISTS "extra_pay: moderator reads own" ON public.extra_pay_slots;

CREATE POLICY "extra_pay: moderator reads own"
  ON public.extra_pay_slots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.moderators m
      WHERE m.id = extra_pay_slots.moderator_id
        AND m.user_id = (SELECT auth.uid())
        AND m.user_id IS NOT NULL
        AND m.is_active
    )
  );

-- Still NO insert/update/delete policies anywhere on this table. Every write
-- goes through the SECURITY DEFINER RPCs below, so the admin check and the
-- double-booking check cannot be bypassed by a direct PostgREST call.

-- ---------------------------------------------------------------------------
-- 3. Overlap guard for moderators
-- ---------------------------------------------------------------------------
--
-- Mirror of host_busy_in_range (057): one worker cannot be paid twice for the
-- same clock time. SECURITY DEFINER so it sees ALL rows — a SECURITY INVOKER
-- version would run under the caller's RLS and silently under-enforce.
--
-- NOT granted to `authenticated`, matching the revoke migration 059 applied to
-- host_busy_in_range: exposing it would let any signed-in user probe another
-- worker's schedule one time-range at a time. It is only ever called from
-- inside the SECURITY DEFINER RPCs below, which execute as the owner.

CREATE OR REPLACE FUNCTION public.moderator_busy_in_range(
  p_moderator_id    UUID,
  p_start           TIMESTAMPTZ,
  p_end             TIMESTAMPTZ,
  p_exclude_slot_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    -- Half-open [start, end): touching blocks are fine, overlapping are not.
    SELECT 1 FROM public.streams s
    WHERE s.moderator_id = p_moderator_id
      AND s.start_time < p_end
      AND s.end_time   > p_start
  ) OR EXISTS (
    SELECT 1 FROM public.extra_pay_slots e
    WHERE e.moderator_id = p_moderator_id
      AND e.status <> 'canceled'
      AND (p_exclude_slot_id IS NULL OR e.id <> p_exclude_slot_id)
      AND e.start_time < p_end
      AND e.end_time   > p_start
  );
$$;

REVOKE ALL ON FUNCTION public.moderator_busy_in_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
-- Deliberately no GRANT to authenticated. See the note above.

-- ---------------------------------------------------------------------------
-- 4. create_extra_pay_slot — NEW ARGUMENT LIST, so the old one is DROPPED
-- ---------------------------------------------------------------------------
--
-- Read the header note about migration 072 before touching this. Dropping the
-- old signature is not tidiness; leaving it makes every call ambiguous and
-- takes the feature down.
--
-- p_host_id and p_moderator_id both default to NULL and move after the
-- required arguments, because Postgres requires defaulted parameters last.
-- Callers name their arguments, so the reordering is invisible to them.

DROP FUNCTION IF EXISTS public.create_extra_pay_slot(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.create_extra_pay_slot(
  p_kind         TEXT,
  p_start        TIMESTAMPTZ,
  p_end          TIMESTAMPTZ,
  p_rate_cents   INT,
  p_host_id      UUID DEFAULT NULL,
  p_moderator_id UUID DEFAULT NULL,
  p_brand_id     UUID DEFAULT NULL,
  p_notes        TEXT DEFAULT NULL
)
RETURNS public.extra_pay_slots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.extra_pay_slots;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can create paid slots' USING ERRCODE = '42501';
  END IF;

  -- Checked here as well as by the table CHECK so the caller gets a sentence
  -- instead of a constraint-violation code. Rule 17: the worker id is trusted
  -- as a target, but WHO MAY WRITE is derived from auth.uid() via is_admin()
  -- above, never from anything the client sent.
  IF num_nonnulls(p_host_id, p_moderator_id) <> 1 THEN
    RAISE EXCEPTION 'Pick exactly one worker: a host or a moderator, not both and not neither'
      USING ERRCODE = '22023';
  END IF;

  IF p_end <= p_start THEN
    RAISE EXCEPTION 'End must be after start' USING ERRCODE = '22007';
  END IF;
  IF p_rate_cents IS NULL OR p_rate_cents < 0 THEN
    RAISE EXCEPTION 'Rate must be zero or more' USING ERRCODE = '22003';
  END IF;

  IF p_host_id IS NOT NULL THEN
    IF public.host_busy_in_range(p_host_id, p_start, p_end, NULL) THEN
      RAISE EXCEPTION 'That host is already booked during this time' USING ERRCODE = '23P01';
    END IF;
  ELSE
    IF public.moderator_busy_in_range(p_moderator_id, p_start, p_end, NULL) THEN
      RAISE EXCEPTION 'That moderator is already booked during this time' USING ERRCODE = '23P01';
    END IF;
  END IF;

  INSERT INTO public.extra_pay_slots
    (host_id, moderator_id, kind, start_time, end_time, rate_cents, brand_id, notes, created_by)
  VALUES
    (p_host_id, p_moderator_id, p_kind, p_start, p_end, p_rate_cents, p_brand_id, p_notes, auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_extra_pay_slot(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_extra_pay_slot(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, UUID, UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. update_extra_pay_slot — SAME signature, so this genuinely replaces
-- ---------------------------------------------------------------------------
--
-- Identical to the live version from migration 059 apart from the overlap
-- branch: it called host_busy_in_range(v_row.host_id, ...) unconditionally,
-- which for a moderator slot would pass NULL and quietly return false —
-- meaning NO overlap check at all on exactly the rows this migration adds.
-- Everything else, including 059's un-cancel re-check, is preserved verbatim.

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
  v_busy   BOOLEAN;
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
  -- bookings were allowed to take while it sat cancelled. (Migration 059.)
  IF v_status <> 'canceled'
     AND (
       (v_start, v_end) IS DISTINCT FROM (v_row.start_time, v_row.end_time)
       OR v_row.status = 'canceled'
     ) THEN
    IF v_row.host_id IS NOT NULL THEN
      v_busy := public.host_busy_in_range(v_row.host_id, v_start, v_end, p_id);
      IF v_busy THEN
        RAISE EXCEPTION 'That host is already booked during this time' USING ERRCODE = '23P01';
      END IF;
    ELSE
      v_busy := public.moderator_busy_in_range(v_row.moderator_id, v_start, v_end, p_id);
      IF v_busy THEN
        RAISE EXCEPTION 'That moderator is already booked during this time' USING ERRCODE = '23P01';
      END IF;
    END IF;
  END IF;

  -- The worker cannot be reassigned here on purpose: moving a slot from one
  -- person to another is not an edit, it is a different payment. Cancel and
  -- recreate, which leaves both facts in the record.
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
-- 6. The symmetric stream guard — SAME signature, genuinely replaced
-- ---------------------------------------------------------------------------
--
-- Migration 057 blocked booking a livestream over a host's paid slot, so the
-- protection could not be evaded by doing it in the other order. That guard
-- only ever looked at NEW.host_id. Without the moderator branch below, this
-- migration would ship a one-way door: you could not put training over a
-- moderator's shift, but you COULD put a shift over their training, and they
-- would be paid twice for the same hour with nothing objecting.
--
-- Identical to 059's version apart from the added moderator branch, including
-- 059's past-shift escape hatch and its PT-naive now (rule 5 — raw NOW() here
-- would compare a real instant against PT-wall-clock columns).

CREATE OR REPLACE FUNCTION public.enforce_stream_not_overlapping_extra_pay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Past shifts are history; editing them must not be blocked. (Migration 059.)
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

  IF NEW.moderator_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.extra_pay_slots e
    WHERE e.moderator_id = NEW.moderator_id
      AND e.status <> 'canceled'
      AND e.start_time < NEW.end_time
      AND e.end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'That moderator already has paid setup/training/office hours during this time'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

-- The trigger must also FIRE on moderator_id changes. 057 created it with
-- UPDATE OF host_id, start_time, end_time, so reassigning a stream to a
-- different moderator would not re-run the check and could drop that moderator
-- straight on top of their own training block.
DROP TRIGGER IF EXISTS trg_stream_not_overlapping_extra_pay ON public.streams;
CREATE TRIGGER trg_stream_not_overlapping_extra_pay
  BEFORE INSERT OR UPDATE OF host_id, moderator_id, start_time, end_time ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_stream_not_overlapping_extra_pay();

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) EXACTLY ONE create_extra_pay_slot. This is the migration-072 check —
--     assert the COUNT, not merely that the new one exists:
--
--       SELECT pg_get_function_identity_arguments(p.oid) AS args
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname = 'public' AND p.proname = 'create_extra_pay_slot';
--
--     Expect ONE row, starting "p_kind text, p_start timestamp with time
--     zone". Two rows means the drop did not take and creating any slot will
--     fail with "could not choose the best candidate function".
--
-- (b) No slot can belong to nobody or to both:
--
--       SELECT conname FROM pg_constraint
--        WHERE conrelid = 'public.extra_pay_slots'::regclass
--          AND conname = 'extra_pay_one_worker';
--       -- expect 1 row
--
-- (c) Existing rows survived untouched — every one is still a host slot:
--
--       SELECT count(*) FILTER (WHERE host_id IS NOT NULL)      AS host_slots,
--              count(*) FILTER (WHERE moderator_id IS NOT NULL) AS mod_slots,
--              count(*)                                          AS total
--         FROM public.extra_pay_slots;
--       -- mod_slots must be 0, and host_slots must equal total and must equal
--       -- the count you saw before applying.
--
-- (d) A moderator sees their own slots and nobody else's. Run as a REAL
--     moderator user_id; expect only their own rows, and 0 rows for a
--     deactivated one:
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A REAL MODERATOR user_id>","role":"authenticated"}';
--         SELECT count(*) FROM public.extra_pay_slots;
--       ROLLBACK;
--
-- (e) The moderator overlap guard is NOT reachable from a client (it would
--     otherwise let anyone probe a worker's schedule):
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SELECT public.moderator_busy_in_range(
--           '00000000-0000-0000-0000-000000000000', NOW(), NOW(), NULL);
--       ROLLBACK;
--       -- expect: permission denied for function moderator_busy_in_range
--
-- (f) The trigger fires on moderator_id:
--
--       SELECT array_to_string(array_agg(a.attname ORDER BY a.attname), ', ')
--         FROM pg_trigger t
--         JOIN unnest(t.tgattr) AS col(attnum) ON TRUE
--         JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = col.attnum
--        WHERE t.tgname = 'trg_stream_not_overlapping_extra_pay';
--       -- expect: end_time, host_id, moderator_id, start_time
