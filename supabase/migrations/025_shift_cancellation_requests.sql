-- ============================================================
-- Shift cancellation request system
-- ============================================================
-- Hosts can no longer call unbook_shift directly. They submit a
-- cancellation request for a single shift; admins approve or deny
-- via the same notification bell pattern as brand requests.
-- Approval mirrors the prior unbook_shift semantics: delete the
-- stream if no producer is attached, otherwise unhost.
-- ============================================================

-- 1. shift_cancellation_requests ------------------------------

CREATE TABLE IF NOT EXISTS public.shift_cancellation_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id     UUID NOT NULL REFERENCES public.streams(id) ON DELETE CASCADE,
  host_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied')) DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS shift_cancellation_requests_pending_unique
  ON public.shift_cancellation_requests (stream_id)
  WHERE status = 'pending';

ALTER TABLE public.shift_cancellation_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_cancellation_requests: own or admin select" ON public.shift_cancellation_requests;
CREATE POLICY "shift_cancellation_requests: own or admin select"
  ON public.shift_cancellation_requests FOR SELECT
  USING (host_user_id = auth.uid() OR public.is_admin());

-- Writes go through SECURITY DEFINER RPCs only.

-- 2. notifications schema additions ---------------------------

-- Notes/reason field for richer rows (cancellation_request uses it).
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS body TEXT;

-- Drop the brand_host_requests FK so request_id can also reference
-- shift_cancellation_requests rows. The `type` column disambiguates.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_request_id_fkey;

-- Extend the type CHECK
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'shift_booked',
    'shift_cancelled',
    'brand_request',
    'brand_request_approved',
    'brand_request_denied',
    'cancellation_request',
    'cancellation_request_approved',
    'cancellation_request_denied'
  ));

-- 3. RPC: request_shift_cancellation --------------------------

CREATE OR REPLACE FUNCTION public.request_shift_cancellation(
  p_stream_id UUID,
  p_reason    TEXT DEFAULT NULL
)
RETURNS public.shift_cancellation_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_stream      public.streams;
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_pt_now      TIMESTAMPTZ := ((NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
  v_request     public.shift_cancellation_requests;
  v_clean_reason TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO v_stream FROM public.streams WHERE id = p_stream_id;
  IF v_stream.id IS NULL THEN
    RAISE EXCEPTION 'Shift not found';
  END IF;

  IF v_stream.end_time <= v_pt_now THEN
    RAISE EXCEPTION 'Cannot request cancellation for a shift that has already ended';
  END IF;

  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_user_id LIMIT 1;

  IF v_host_id IS NULL OR v_stream.host_id IS DISTINCT FROM v_host_id THEN
    RAISE EXCEPTION 'You are not the host of this shift';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.shift_cancellation_requests
    WHERE stream_id = p_stream_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A cancellation request is already pending for this shift';
  END IF;

  SELECT name INTO v_brand_name FROM public.brands WHERE id = v_stream.brand_id;

  v_clean_reason := NULLIF(BTRIM(COALESCE(p_reason, '')), '');

  INSERT INTO public.shift_cancellation_requests (stream_id, host_user_id, reason)
  VALUES (p_stream_id, v_user_id, v_clean_reason)
  RETURNING * INTO v_request;

  -- Fan out to all admins
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name,
     shift_start, shift_end, request_id, body)
  SELECT
    p.id, 'cancellation_request', v_host_id, COALESCE(v_host_name, 'Host'),
    v_stream.brand_id, COALESCE(v_brand_name, 'Brand'),
    v_stream.start_time, v_stream.end_time, v_request.id, v_clean_reason
  FROM public.profiles p
  WHERE p.role = 'admin';

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_shift_cancellation(UUID, TEXT) TO authenticated;

-- 4. RPC: decide_cancellation_request -------------------------

CREATE OR REPLACE FUNCTION public.decide_cancellation_request(
  p_request_id UUID,
  p_approve    BOOLEAN
)
RETURNS public.shift_cancellation_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id    UUID := auth.uid();
  v_request     public.shift_cancellation_requests;
  v_stream      public.streams;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_new_status  TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can decide cancellation requests';
  END IF;

  SELECT * INTO v_request
  FROM public.shift_cancellation_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been decided';
  END IF;

  SELECT * INTO v_stream FROM public.streams WHERE id = v_request.stream_id;

  v_new_status := CASE WHEN p_approve THEN 'approved' ELSE 'denied' END;

  UPDATE public.shift_cancellation_requests
  SET status     = v_new_status,
      decided_by = v_admin_id,
      decided_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  -- Snapshot host + brand names before any deletion. Stream may have already
  -- been removed by an earlier admin path; fall back to whatever we can find.
  SELECT name INTO v_host_name FROM public.hosts WHERE user_id = v_request.host_user_id LIMIT 1;

  IF v_stream.id IS NOT NULL THEN
    SELECT name INTO v_brand_name FROM public.brands WHERE id = v_stream.brand_id;

    IF p_approve THEN
      IF v_stream.producer_id IS NULL THEN
        DELETE FROM public.streams WHERE id = v_stream.id;
      ELSE
        UPDATE public.streams SET host_id = NULL WHERE id = v_stream.id;
      END IF;
    END IF;
  END IF;

  -- Pull the cancellation_request notifications from every admin's inbox
  DELETE FROM public.notifications
  WHERE request_id = p_request_id
    AND type = 'cancellation_request';

  -- Result notification for the requesting host
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name,
     shift_start, shift_end, request_id)
  VALUES (
    v_request.host_user_id,
    CASE WHEN p_approve THEN 'cancellation_request_approved' ELSE 'cancellation_request_denied' END,
    NULL,
    COALESCE(v_host_name, 'You'),
    v_stream.brand_id,
    COALESCE(v_brand_name, 'Brand'),
    v_stream.start_time,
    v_stream.end_time,
    v_request.id
  );

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_cancellation_request(UUID, BOOLEAN) TO authenticated;

-- 5. unbook_shift becomes admin-only --------------------------
-- Hosts go through request_shift_cancellation. Admins keep direct
-- unbook for backstage corrections.

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
  v_stream  public.streams;
  v_pt_now  TIMESTAMPTZ := ((NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
  v_result  public.streams;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hosts must request cancellation from an admin';
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
