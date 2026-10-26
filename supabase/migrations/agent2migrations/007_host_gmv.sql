-- ============================================================
-- Host GMV: per-session gross merchandise value
-- ============================================================
-- Hosts report the GMV they generated per SESSION (a run of touching shifts in
-- one brand). GMV is stored once, on the session's anchor (earliest) stream, as
-- integer cents. Admins aggregate it on the Host Performance dashboard.
--
-- Hosts get NO broad UPDATE on streams. The only write path is the
-- set_session_gmv RPC below, which is column-scoped and enforces ownership +
-- "session has ended". Reads use existing RLS (host sees own rows; admin all).
--
-- PT-naive scheme: stored timestamps' UTC fields ARE the PT wall-clock, so the
-- "has ended" comparison converts both sides to PT wall-clock:
--   (end_time AT TIME ZONE 'UTC')  -> the stored PT wall-clock numerals
--   (now()    AT TIME ZONE 'America/Los_Angeles') -> current PT wall-clock
-- ============================================================

ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS gmv_cents integer;

ALTER TABLE public.streams
  DROP CONSTRAINT IF EXISTS streams_gmv_cents_chk;

ALTER TABLE public.streams
  ADD CONSTRAINT streams_gmv_cents_chk
  CHECK (gmv_cents IS NULL OR gmv_cents >= 0);

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
  v_host_id uuid;
  v_end     timestamptz;
BEGIN
  SELECT s.host_id, s.end_time
    INTO v_host_id, v_end
  FROM public.streams s
  WHERE s.id = p_stream_id;

  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'Session not found or has no host' USING ERRCODE = '22023';
  END IF;

  -- Caller must be the host of this stream.
  IF NOT EXISTS (
    SELECT 1 FROM public.hosts h
    WHERE h.id = v_host_id AND h.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized for this session' USING ERRCODE = '42501';
  END IF;

  -- Session must have ended (PT wall-clock comparison; see header).
  IF (v_end AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'America/Los_Angeles') THEN
    RAISE EXCEPTION 'Session has not ended yet' USING ERRCODE = '22023';
  END IF;

  IF p_gmv_cents IS NOT NULL AND p_gmv_cents < 0 THEN
    RAISE EXCEPTION 'GMV must be non-negative' USING ERRCODE = '22023';
  END IF;

  UPDATE public.streams
     SET gmv_cents = p_gmv_cents
   WHERE id = p_stream_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_session_gmv(uuid, integer) TO authenticated;
