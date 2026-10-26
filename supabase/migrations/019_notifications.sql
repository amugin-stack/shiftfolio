-- ============================================================
-- Per-admin notification inbox.
-- Each admin gets their own row when a non-admin host books or
-- cancels a shift. Names are snapshot at insert time so the row
-- reads correctly even after host/brand renames or deletions.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('shift_booked','shift_cancelled')),
  actor_host_id  UUID REFERENCES public.hosts(id) ON DELETE SET NULL,
  host_name      TEXT NOT NULL,
  brand_id       UUID REFERENCES public.brands(id) ON DELETE SET NULL,
  brand_name     TEXT NOT NULL,
  shift_start    TIMESTAMPTZ NOT NULL,
  shift_end      TIMESTAMPTZ NOT NULL,
  is_read        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON public.notifications (recipient_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Each user only ever sees, mutates, or deletes their own rows.
-- No INSERT policy: only the SECURITY DEFINER RPCs below write.
DROP POLICY IF EXISTS "notifications: own select" ON public.notifications;
CREATE POLICY "notifications: own select"
  ON public.notifications FOR SELECT
  USING (recipient_id = auth.uid());

DROP POLICY IF EXISTS "notifications: own update" ON public.notifications;
CREATE POLICY "notifications: own update"
  ON public.notifications FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

DROP POLICY IF EXISTS "notifications: own delete" ON public.notifications;
CREATE POLICY "notifications: own delete"
  ON public.notifications FOR DELETE
  USING (recipient_id = auth.uid());

-- Add to the realtime publication so clients see INSERT/DELETE/UPDATE live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ============================================================
-- book_shift: same body as 018 + admin fan-out at the end.
-- ============================================================
CREATE OR REPLACE FUNCTION public.book_shift(
  p_brand_id   UUID,
  p_start_time TIMESTAMPTZ,
  p_end_time   TIMESTAMPTZ
)
RETURNS public.streams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand       public.brands;
  v_existing    public.streams;
  v_existing_id UUID;
  v_minutes     INT;
  v_block_index INT;
  v_dow         INT;
  v_blocked     BOOLEAN;
  v_eligible    BOOLEAN;
  v_block_size  INTERVAL;
  v_other_count INT;
  v_adjacent    INT;
  v_pt_now      TIMESTAMPTZ := ((NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
  v_result      public.streams;
  v_actor_admin BOOLEAN;
BEGIN
  IF p_end_time <= v_pt_now THEN
    RAISE EXCEPTION 'Cannot book a shift that has already ended';
  END IF;

  SELECT id, name INTO v_host_id, v_host_name FROM public.hosts WHERE user_id = auth.uid() LIMIT 1;
  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You do not have a host profile linked to your account';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.brand_hosts WHERE brand_id = p_brand_id AND host_id = v_host_id
  ) INTO v_eligible;
  IF NOT v_eligible THEN
    RAISE EXCEPTION 'You are not assigned to this brand';
  END IF;

  SELECT * INTO v_brand FROM public.brands WHERE id = p_brand_id;
  IF v_brand.id IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  v_minutes := EXTRACT(HOUR   FROM p_start_time AT TIME ZONE 'UTC')::int * 60
             + EXTRACT(MINUTE FROM p_start_time AT TIME ZONE 'UTC')::int;
  v_block_index := (v_minutes - v_brand.day_start_minutes) / v_brand.block_size_minutes;
  v_dow := EXTRACT(DOW FROM p_start_time AT TIME ZONE 'UTC')::int;

  SELECT is_blocked INTO v_blocked
  FROM public.brand_shift_rates
  WHERE brand_id = p_brand_id AND day_of_week = v_dow AND block_index = v_block_index;

  IF v_blocked IS TRUE THEN
    RAISE EXCEPTION 'This shift is blocked';
  END IF;

  SELECT * INTO v_existing FROM public.streams
  WHERE brand_id = p_brand_id AND start_time = p_start_time;
  v_existing_id := v_existing.id;

  v_block_size := (v_brand.block_size_minutes || ' minutes')::interval;

  SELECT COUNT(*) INTO v_other_count
  FROM public.streams s
  WHERE s.brand_id = p_brand_id
    AND (s.start_time AT TIME ZONE 'UTC')::date = (p_start_time AT TIME ZONE 'UTC')::date
    AND (v_existing_id IS NULL OR s.id <> v_existing_id);

  IF v_other_count > 0 THEN
    SELECT COUNT(*) INTO v_adjacent
    FROM public.streams s
    WHERE s.brand_id = p_brand_id
      AND (s.start_time = p_start_time + v_block_size
        OR s.start_time = p_start_time - v_block_size)
      AND (v_existing_id IS NULL OR s.id <> v_existing_id);

    IF v_adjacent = 0 THEN
      RAISE EXCEPTION 'You can only book a shift adjacent to an existing booking on this day';
    END IF;
  END IF;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.host_id IS NOT NULL AND v_existing.host_id <> v_host_id THEN
      RAISE EXCEPTION 'This shift already has a host';
    END IF;
    UPDATE public.streams SET host_id = v_host_id WHERE id = v_existing.id RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.streams (brand_id, host_id, start_time, end_time, created_by)
    VALUES (p_brand_id, v_host_id, p_start_time, p_end_time, auth.uid())
    RETURNING * INTO v_result;
  END IF;

  -- Fan out to admins, but only when the actor is not themselves an admin
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    INTO v_actor_admin;

  IF NOT v_actor_admin THEN
    INSERT INTO public.notifications
      (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, shift_start, shift_end)
    SELECT
      p.id,
      'shift_booked',
      v_host_id,
      v_host_name,
      p_brand_id,
      v_brand.name,
      p_start_time,
      p_end_time
    FROM public.profiles p
    WHERE p.role = 'admin';
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_shift(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ============================================================
-- unbook_shift: same body as 018 + admin fan-out at the end.
-- ============================================================
CREATE OR REPLACE FUNCTION public.unbook_shift(
  p_brand_id   UUID,
  p_start_time TIMESTAMPTZ
)
RETURNS public.streams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_stream      public.streams;
  v_pt_now      TIMESTAMPTZ := ((NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
  v_result      public.streams;
  v_actor_admin BOOLEAN;
BEGIN
  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You do not have a host profile linked to your account';
  END IF;

  SELECT * INTO v_stream
  FROM public.streams
  WHERE brand_id = p_brand_id AND start_time = p_start_time;

  IF v_stream.id IS NULL THEN
    RAISE EXCEPTION 'No shift exists at this slot';
  END IF;

  IF v_stream.end_time <= v_pt_now THEN
    RAISE EXCEPTION 'Cannot cancel a shift that has already ended';
  END IF;

  IF v_stream.host_id <> v_host_id THEN
    RAISE EXCEPTION 'You are not the host of this shift';
  END IF;

  SELECT name INTO v_brand_name FROM public.brands WHERE id = p_brand_id;

  IF v_stream.producer_id IS NULL THEN
    DELETE FROM public.streams WHERE id = v_stream.id;
    v_result := v_stream;
    v_result.host_id := NULL;
  ELSE
    UPDATE public.streams SET host_id = NULL WHERE id = v_stream.id
    RETURNING * INTO v_result;
  END IF;

  -- Fan out to admins, but only when the actor is not themselves an admin
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    INTO v_actor_admin;

  IF NOT v_actor_admin THEN
    INSERT INTO public.notifications
      (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, shift_start, shift_end)
    SELECT
      p.id,
      'shift_cancelled',
      v_host_id,
      v_host_name,
      p_brand_id,
      COALESCE(v_brand_name, 'Brand'),
      v_stream.start_time,
      v_stream.end_time
    FROM public.profiles p
    WHERE p.role = 'admin';
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unbook_shift(UUID, TIMESTAMPTZ) TO authenticated;
