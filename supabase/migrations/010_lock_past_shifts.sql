-- ============================================================
-- Lock past shifts at the RPC layer
-- ============================================================
-- Hosts go through book_shift / unbook_shift. Admins write streams
-- directly (RLS) and are intentionally NOT subject to these checks
-- so they can record retroactive corrections.
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
  v_brand       public.brands;
  v_existing    public.streams;
  v_minutes     INT;
  v_block_index INT;
  v_dow         INT;
  v_blocked     BOOLEAN;
  v_result      public.streams;
BEGIN
  -- Reject past slots up front
  IF p_end_time <= NOW() THEN
    RAISE EXCEPTION 'Cannot book a shift that has already ended';
  END IF;

  SELECT id INTO v_host_id
  FROM public.hosts
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You do not have a host profile linked to your account';
  END IF;

  SELECT * INTO v_brand FROM public.brands WHERE id = p_brand_id;
  IF v_brand.id IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  v_minutes := EXTRACT(HOUR FROM p_start_time AT TIME ZONE 'UTC')::int * 60
             + EXTRACT(MINUTE FROM p_start_time AT TIME ZONE 'UTC')::int;
  v_block_index := (v_minutes - v_brand.day_start_minutes) / v_brand.block_size_minutes;
  v_dow := EXTRACT(DOW FROM p_start_time AT TIME ZONE 'UTC')::int;

  SELECT is_blocked INTO v_blocked
  FROM public.brand_shift_rates
  WHERE brand_id = p_brand_id AND day_of_week = v_dow AND block_index = v_block_index;

  IF v_blocked IS TRUE THEN
    RAISE EXCEPTION 'This shift is blocked';
  END IF;

  SELECT * INTO v_existing
  FROM public.streams
  WHERE brand_id = p_brand_id AND start_time = p_start_time;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.host_id IS NOT NULL AND v_existing.host_id <> v_host_id THEN
      RAISE EXCEPTION 'This shift already has a host';
    END IF;
    UPDATE public.streams
       SET host_id = v_host_id
     WHERE id = v_existing.id
     RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.streams (brand_id, host_id, start_time, end_time, created_by)
    VALUES (p_brand_id, v_host_id, p_start_time, p_end_time, auth.uid())
    RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_shift(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;


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

  -- Reject past shifts (after we've fetched end_time)
  IF v_stream.end_time <= NOW() THEN
    RAISE EXCEPTION 'Cannot cancel a shift that has already ended';
  END IF;

  IF v_stream.host_id <> v_host_id THEN
    RAISE EXCEPTION 'You are not the host of this shift';
  END IF;

  IF v_stream.producer_id IS NULL THEN
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
