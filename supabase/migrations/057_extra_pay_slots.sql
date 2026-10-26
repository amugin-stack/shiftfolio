-- 057_extra_pay_slots.sql
--
-- INTENT (the support team, 2026-08-25): hosts sometimes do paid work that is NOT a
-- livestream — setup, training, office hours — and it pays a different rate
-- from their livestream contract rate. Today the only payable thing is a row
-- in `streams`, so this work either goes unpaid or gets faked as a fake shift.
--
-- WHY A SEPARATE TABLE, NOT ROWS IN `streams`:
-- every reader of `streams` assumes "billable live shift". Putting an office-
-- hours block in there would fabricate client revenue (brands are billed on
-- stream hours), mint bogus moderator prep/setup bonuses (src/lib/prepTime.ts
-- walks contiguous stream runs), collide with
-- streams_unique_slot UNIQUE (brand_id, start_time), and pollute GMV. So these
-- live in their own table and are folded into payroll explicitly.
--
-- WHY rate_cents IS STORED, NOT DERIVED (Alex, 2026-08-25):
-- the rate is FROZEN onto each slot at creation. Raising the training rate
-- from $20 to $25 must NOT silently re-price sessions already worked — last
-- month's payroll has to keep matching what was actually paid. This is the
-- same principle as streams.host_rate_cents (migration 046), applied at insert
-- time instead of retroactively. A per-kind default lives in the app as a UI
-- prefill only; changing it can never move a stored row.
--
-- NAMING CAUTION: kind='setup' here is a HOST slot type (the support team's word). It is
-- unrelated to the MODERATOR "setup bonus" (src/lib/setupBonus.ts, migration
-- 048) — the pre-cutoff first-of-(brand,day) +30min rule. Different people,
-- different mechanism, no shared code path.
--
-- host_id is ON DELETE RESTRICT, deliberately NOT CASCADE: these rows ARE pay
-- history. CASCADE would let deleting a host silently erase what they were
-- owed, with no FK error to warn anyone. Matches streams.host_id (mig 001) and
-- the reasoning in migration 054.
--
-- APPLY ORDER: independent — depends only on hosts/brands/profiles and
-- is_admin() (mig 001). Safe to apply before or after 055/056. Must be applied
-- BEFORE the code that calls these RPCs is deployed.
--
-- ROLLBACK: DROP TABLE public.extra_pay_slots CASCADE; plus the three RPCs and
-- the trigger + function at the bottom. Destroys pay history — export first.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.extra_pay_slots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     UUID NOT NULL REFERENCES public.hosts(id)    ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('setup', 'training', 'office_hours')),
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  -- Frozen at creation. Never recomputed from a live default.
  rate_cents  INT NOT NULL CHECK (rate_cents >= 0),
  -- Optional attribution. NULL = company overhead, not billable to a brand.
  brand_id    UUID REFERENCES public.brands(id) ON DELETE SET NULL,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled', 'completed', 'canceled')),
  created_by  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT extra_pay_valid_time_range CHECK (end_time > start_time)
);

COMMENT ON COLUMN public.extra_pay_slots.rate_cents IS
  'Hourly rate in cents, FROZEN at creation. Changing a per-kind default must never re-price a slot already created — see migration header.';

-- Payroll queries the window per host; the calendar overlay queries by time.
CREATE INDEX IF NOT EXISTS extra_pay_slots_host_start_idx
  ON public.extra_pay_slots (host_id, start_time);
CREATE INDEX IF NOT EXISTS extra_pay_slots_start_idx
  ON public.extra_pay_slots (start_time);

-- ---------------------------------------------------------------------------
-- RLS — enabled with policies in the same migration (CLAUDE.md rule 16)
-- ---------------------------------------------------------------------------

ALTER TABLE public.extra_pay_slots ENABLE ROW LEVEL SECURITY;

-- Admins read everything.
DROP POLICY IF EXISTS "extra_pay: admin read all" ON public.extra_pay_slots;
CREATE POLICY "extra_pay: admin read all"
  ON public.extra_pay_slots FOR SELECT
  USING (public.is_admin());

-- A host reads ONLY their own slots — same isolation as streams post-052.
-- Producers and moderators are intentionally excluded: this is pay data.
DROP POLICY IF EXISTS "extra_pay: host reads own" ON public.extra_pay_slots;
CREATE POLICY "extra_pay: host reads own"
  ON public.extra_pay_slots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.hosts h
      WHERE h.id = extra_pay_slots.host_id
        AND h.user_id = auth.uid()
        AND h.user_id IS NOT NULL
    )
  );

-- NO insert/update/delete policies on purpose: every write goes through the
-- SECURITY DEFINER RPCs below, so the admin check and the overlap check can
-- never be bypassed by a direct PostgREST call.

-- ---------------------------------------------------------------------------
-- Overlap helper — one host cannot be paid twice for the same clock time
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so the check sees ALL rows. A SECURITY INVOKER version
-- would run under the caller's RLS and silently under-enforce for anyone who
-- can't read every stream (the existing enforce_no_double_booking trigger has
-- exactly that latent flaw).
CREATE OR REPLACE FUNCTION public.host_busy_in_range(
  p_host_id     UUID,
  p_start       TIMESTAMPTZ,
  p_end         TIMESTAMPTZ,
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
    WHERE s.host_id = p_host_id
      AND s.start_time < p_end
      AND s.end_time   > p_start
  ) OR EXISTS (
    SELECT 1 FROM public.extra_pay_slots e
    WHERE e.host_id = p_host_id
      AND e.status <> 'canceled'
      AND (p_exclude_slot_id IS NULL OR e.id <> p_exclude_slot_id)
      AND e.start_time < p_end
      AND e.end_time   > p_start
  );
$$;

REVOKE ALL ON FUNCTION public.host_busy_in_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.host_busy_in_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Write RPCs — admin only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_extra_pay_slot(
  p_host_id    UUID,
  p_kind       TEXT,
  p_start      TIMESTAMPTZ,
  p_end        TIMESTAMPTZ,
  p_rate_cents INT,
  p_brand_id   UUID DEFAULT NULL,
  p_notes      TEXT DEFAULT NULL
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
  IF p_end <= p_start THEN
    RAISE EXCEPTION 'End must be after start' USING ERRCODE = '22007';
  END IF;
  IF p_rate_cents IS NULL OR p_rate_cents < 0 THEN
    RAISE EXCEPTION 'Rate must be zero or more' USING ERRCODE = '22003';
  END IF;
  IF public.host_busy_in_range(p_host_id, p_start, p_end, NULL) THEN
    RAISE EXCEPTION 'That host is already booked during this time' USING ERRCODE = '23P01';
  END IF;

  INSERT INTO public.extra_pay_slots
    (host_id, kind, start_time, end_time, rate_cents, brand_id, notes, created_by)
  VALUES
    (p_host_id, p_kind, p_start, p_end, p_rate_cents, p_brand_id, p_notes, auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

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
  v_row   public.extra_pay_slots;
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can edit paid slots' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.extra_pay_slots WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paid slot not found' USING ERRCODE = 'P0002';
  END IF;

  v_start := COALESCE(p_start, v_row.start_time);
  v_end   := COALESCE(p_end,   v_row.end_time);
  IF v_end <= v_start THEN
    RAISE EXCEPTION 'End must be after start' USING ERRCODE = '22007';
  END IF;

  -- Only re-check overlap when the times actually move; exclude self.
  IF (v_start, v_end) IS DISTINCT FROM (v_row.start_time, v_row.end_time)
     AND COALESCE(p_status, v_row.status) <> 'canceled'
     AND public.host_busy_in_range(v_row.host_id, v_start, v_end, p_id) THEN
    RAISE EXCEPTION 'That host is already booked during this time' USING ERRCODE = '23P01';
  END IF;

  UPDATE public.extra_pay_slots
     SET start_time = v_start,
         end_time   = v_end,
         -- Editing the rate on a SPECIFIC slot is allowed (fixing a typo);
         -- what must never happen is a global default silently re-pricing
         -- history. That is prevented by storing the rate, not deriving it.
         rate_cents = COALESCE(p_rate_cents, v_row.rate_cents),
         brand_id   = COALESCE(p_brand_id,   v_row.brand_id),
         notes      = COALESCE(p_notes,      v_row.notes),
         status     = COALESCE(p_status,     v_row.status),
         updated_at = NOW()
   WHERE id = p_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_extra_pay_slot(p_id UUID)
RETURNS public.extra_pay_slots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.extra_pay_slots;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can cancel paid slots' USING ERRCODE = '42501';
  END IF;

  -- Soft-cancel rather than DELETE: a worked-and-then-cancelled slot is still
  -- part of the record. Payroll skips status='canceled'.
  UPDATE public.extra_pay_slots
     SET status = 'canceled', updated_at = NOW()
   WHERE id = p_id
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paid slot not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_extra_pay_slot(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_extra_pay_slot(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_extra_pay_slot(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_extra_pay_slot(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_extra_pay_slot(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_extra_pay_slot(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Symmetric guard: a livestream must not be booked over a paid slot either
-- ---------------------------------------------------------------------------

-- Without this the protection is one-way: you couldn't put training over a
-- shift, but you COULD put a shift over training, and the host would be paid
-- twice for the same hour. SECURITY DEFINER so it sees every row regardless of
-- the writer's RLS.
CREATE OR REPLACE FUNCTION public.enforce_stream_not_overlapping_extra_pay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS trg_stream_not_overlapping_extra_pay ON public.streams;
CREATE TRIGGER trg_stream_not_overlapping_extra_pay
  BEFORE INSERT OR UPDATE OF host_id, start_time, end_time ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_stream_not_overlapping_extra_pay();
