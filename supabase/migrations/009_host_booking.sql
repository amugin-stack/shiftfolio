-- ============================================================
-- Host self-booking RPCs
-- ============================================================
-- Streams stay admin-only writable via direct SQL (RLS unchanged).
-- Hosts go through SECURITY DEFINER functions that:
--   * resolve the caller's linked host record
--   * verify the slot exists, isn't blocked, isn't already taken
--   * set / clear host_id atomically
-- ============================================================

-- BOOK
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
  v_host_id  UUID;
  v_brand    public.brands;
  v_existing public.streams;
  v_minutes  INT;
  v_block_index INT;
  v_dow      INT;
  v_blocked  BOOLEAN;
  v_result   public.streams;
BEGIN
  -- 1. Caller must be linked to a host record
  SELECT id INTO v_host_id
  FROM public.hosts
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You do not have a host profile linked to your account';
  END IF;

  -- 2. Brand must exist; pull its shift config
  SELECT * INTO v_brand FROM public.brands WHERE id = p_brand_id;
  IF v_brand.id IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  -- 3. Compute weekday + block index for the slot
  v_minutes := EXTRACT(HOUR FROM p_start_time AT TIME ZONE 'UTC')::int * 60
             + EXTRACT(MINUTE FROM p_start_time AT TIME ZONE 'UTC')::int;
  v_block_index := (v_minutes - v_brand.day_start_minutes) / v_brand.block_size_minutes;
  v_dow := EXTRACT(DOW FROM p_start_time AT TIME ZONE 'UTC')::int;

  -- 4. Reject blocked shifts
  SELECT is_blocked INTO v_blocked
  FROM public.brand_shift_rates
  WHERE brand_id = p_brand_id AND day_of_week = v_dow AND block_index = v_block_index;

  IF v_blocked IS TRUE THEN
    RAISE EXCEPTION 'This shift is blocked';
  END IF;

  -- 5. Look for an existing stream at this exact slot
  SELECT * INTO v_existing
  FROM public.streams
  WHERE brand_id = p_brand_id AND start_time = p_start_time;

  IF v_existing.id IS NOT NULL THEN
    -- Slot exists already
    IF v_existing.host_id IS NOT NULL AND v_existing.host_id <> v_host_id THEN
      RAISE EXCEPTION 'This shift already has a host';
    END IF;
    UPDATE public.streams
       SET host_id = v_host_id
     WHERE id = v_existing.id
     RETURNING * INTO v_result;
  ELSE
    -- New stream
    INSERT INTO public.streams (brand_id, host_id, start_time, end_time, created_by)
    VALUES (p_brand_id, v_host_id, p_start_time, p_end_time, auth.uid())
    RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_shift(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- UNBOOK
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
  v_host_id UUID;
  v_stream  public.streams;
  v_result  public.streams;
BEGIN
  SELECT id INTO v_host_id
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

  IF v_stream.host_id <> v_host_id THEN
    RAISE EXCEPTION 'You are not the host of this shift';
  END IF;

  IF v_stream.producer_id IS NULL THEN
    -- No producer either, the slot becomes empty: delete the stream
    DELETE FROM public.streams WHERE id = v_stream.id;
    v_result := v_stream;
    v_result.host_id := NULL;
  ELSE
    UPDATE public.streams SET host_id = NULL WHERE id = v_stream.id
    RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unbook_shift(UUID, TIMESTAMPTZ) TO authenticated;
