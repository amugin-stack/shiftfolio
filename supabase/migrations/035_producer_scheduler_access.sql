-- ============================================================
-- Producers gain near-admin scheduling power
-- ============================================================
-- Producers can now create / edit / delete streams, manage hosts /
-- brands / producers / moderators rosters, and act on host requests
-- (brand_request, cancellation_request) alongside admins.
--
-- Producers CANNOT touch:
--   * brand_shift_rates / brand_shift_overrides — rate management
--   * brands.client_rate_cents — read still admin-only by code path
--   * moderators.rate_cents — code path hides it from producer UI
--   * profiles.role — handled by the /admin/users page (admin-only at
--     the page guard layer; the existing profiles policies are fine).
--   * brand-logos storage bucket (writes stay admin-only).
--
-- Notifications: brand_request and cancellation_request fan out to
-- producers in addition to admins so the bell queue is shared.
-- ============================================================

-- 1. is_scheduler() helper ------------------------------------
-- True for admins AND any user linked to a producers row.
CREATE OR REPLACE FUNCTION public.is_scheduler()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.producers WHERE user_id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_scheduler() TO authenticated;

-- 2. streams: writes by schedulers ----------------------------
-- Drop every prior incarnation of the admin-only write policies. Some
-- may not exist depending on which past migrations actually ran on a
-- given environment, hence the IF EXISTS soup.

DROP POLICY IF EXISTS "streams_insert_admin"          ON public.streams;
DROP POLICY IF EXISTS "streams_update_admin"          ON public.streams;
DROP POLICY IF EXISTS "streams_delete_admin"          ON public.streams;
DROP POLICY IF EXISTS "streams: admin delete"         ON public.streams;
DROP POLICY IF EXISTS "streams: admin delete future only" ON public.streams;

CREATE POLICY "streams: scheduler insert"
  ON public.streams FOR INSERT
  WITH CHECK (public.is_scheduler());

CREATE POLICY "streams: scheduler update"
  ON public.streams FOR UPDATE
  USING (public.is_scheduler());

CREATE POLICY "streams: scheduler delete"
  ON public.streams FOR DELETE
  USING (public.is_scheduler());

-- 3. hosts / brands / producers / moderators rosters ----------
-- Open insert/update/delete to schedulers. Read policies were already
-- "authenticated read" so no change there.

-- hosts ------------------------------------------------------
DROP POLICY IF EXISTS "hosts_insert_admin" ON public.hosts;
DROP POLICY IF EXISTS "hosts_update_admin" ON public.hosts;
DROP POLICY IF EXISTS "hosts_delete_admin" ON public.hosts;

CREATE POLICY "hosts: scheduler insert"
  ON public.hosts FOR INSERT WITH CHECK (public.is_scheduler());
CREATE POLICY "hosts: scheduler update"
  ON public.hosts FOR UPDATE USING (public.is_scheduler());
CREATE POLICY "hosts: scheduler delete"
  ON public.hosts FOR DELETE USING (public.is_scheduler());

-- brands -----------------------------------------------------
DROP POLICY IF EXISTS "brands_insert_admin" ON public.brands;
DROP POLICY IF EXISTS "brands_update_admin" ON public.brands;
DROP POLICY IF EXISTS "brands_delete_admin" ON public.brands;

CREATE POLICY "brands: scheduler insert"
  ON public.brands FOR INSERT WITH CHECK (public.is_scheduler());
CREATE POLICY "brands: scheduler update"
  ON public.brands FOR UPDATE USING (public.is_scheduler());
CREATE POLICY "brands: scheduler delete"
  ON public.brands FOR DELETE USING (public.is_scheduler());

-- producers --------------------------------------------------
DROP POLICY IF EXISTS "producers: admin insert" ON public.producers;
DROP POLICY IF EXISTS "producers: admin update" ON public.producers;
DROP POLICY IF EXISTS "producers: admin delete" ON public.producers;

CREATE POLICY "producers: scheduler insert"
  ON public.producers FOR INSERT WITH CHECK (public.is_scheduler());
CREATE POLICY "producers: scheduler update"
  ON public.producers FOR UPDATE USING (public.is_scheduler());
CREATE POLICY "producers: scheduler delete"
  ON public.producers FOR DELETE USING (public.is_scheduler());

-- moderators -------------------------------------------------
DROP POLICY IF EXISTS "moderators: admin insert" ON public.moderators;
DROP POLICY IF EXISTS "moderators: admin update" ON public.moderators;
DROP POLICY IF EXISTS "moderators: admin delete" ON public.moderators;

CREATE POLICY "moderators: scheduler insert"
  ON public.moderators FOR INSERT WITH CHECK (public.is_scheduler());
CREATE POLICY "moderators: scheduler update"
  ON public.moderators FOR UPDATE USING (public.is_scheduler());
CREATE POLICY "moderators: scheduler delete"
  ON public.moderators FOR DELETE USING (public.is_scheduler());

-- brand_hosts ------------------------------------------------
-- decide_brand_request runs SECURITY DEFINER and bypasses RLS, but
-- producers may also need to link hosts directly from the admin UI.
DROP POLICY IF EXISTS "brand_hosts: admin insert" ON public.brand_hosts;
DROP POLICY IF EXISTS "brand_hosts: admin delete" ON public.brand_hosts;

CREATE POLICY "brand_hosts: scheduler insert"
  ON public.brand_hosts FOR INSERT WITH CHECK (public.is_scheduler());
CREATE POLICY "brand_hosts: scheduler delete"
  ON public.brand_hosts FOR DELETE USING (public.is_scheduler());

-- ============================================================
-- 4. Request-decision RPCs: allow schedulers, fan out to both
-- ============================================================

-- request_brand: fan brand_request notification out to admins + producers
CREATE OR REPLACE FUNCTION public.request_brand(p_brand_id UUID)
RETURNS public.brand_host_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_user_id LIMIT 1;

  IF v_host_id IS NULL THEN
    INSERT INTO public.hosts (name, email, user_id)
    SELECT
      COALESCE(NULLIF(p.full_name, ''), p.email, 'New Host'),
      p.email,
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

  -- Fan out to every admin AND every producer-linked profile.
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, request_id)
  SELECT
    recipient_id, 'brand_request', v_host_id, COALESCE(v_host_name, 'New Host'),
    p_brand_id, v_brand_name, v_request.id
  FROM (
    SELECT id AS recipient_id FROM public.profiles WHERE role = 'admin'
    UNION
    SELECT user_id AS recipient_id FROM public.producers WHERE user_id IS NOT NULL
  ) AS recipients;

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_brand(UUID) TO authenticated;

-- decide_brand_request: schedulers can decide
CREATE OR REPLACE FUNCTION public.decide_brand_request(
  p_request_id UUID,
  p_approve    BOOLEAN
)
RETURNS public.brand_host_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    UUID := auth.uid();
  v_request     public.brand_host_requests;
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_new_status  TEXT;
BEGIN
  IF NOT public.is_scheduler() THEN
    RAISE EXCEPTION 'Only admins and producers can decide brand requests';
  END IF;

  SELECT * INTO v_request
  FROM public.brand_host_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been decided';
  END IF;

  v_new_status := CASE WHEN p_approve THEN 'approved' ELSE 'denied' END;

  UPDATE public.brand_host_requests
  SET status     = v_new_status,
      decided_by = v_actor_id,
      decided_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_request.host_user_id LIMIT 1;
  SELECT name INTO v_brand_name
  FROM public.brands WHERE id = v_request.brand_id;

  IF p_approve AND v_host_id IS NOT NULL THEN
    INSERT INTO public.brand_hosts (brand_id, host_id)
    VALUES (v_request.brand_id, v_host_id)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Pull the brand_request notification from every admin AND producer inbox.
  DELETE FROM public.notifications
  WHERE request_id = p_request_id
    AND type = 'brand_request';

  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, request_id)
  VALUES (
    v_request.host_user_id,
    CASE WHEN p_approve THEN 'brand_request_approved' ELSE 'brand_request_denied' END,
    v_host_id,
    COALESCE(v_host_name, 'You'),
    v_request.brand_id,
    COALESCE(v_brand_name, 'Brand'),
    v_request.id
  );

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_brand_request(UUID, BOOLEAN) TO authenticated;

-- request_shift_cancellation: also fan out to producers
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

  -- Fan out to every admin AND every producer-linked profile.
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name,
     shift_start, shift_end, request_id, body)
  SELECT
    recipient_id, 'cancellation_request', v_host_id, COALESCE(v_host_name, 'Host'),
    v_stream.brand_id, COALESCE(v_brand_name, 'Brand'),
    v_stream.start_time, v_stream.end_time, v_request.id, v_clean_reason
  FROM (
    SELECT id AS recipient_id FROM public.profiles WHERE role = 'admin'
    UNION
    SELECT user_id AS recipient_id FROM public.producers WHERE user_id IS NOT NULL
  ) AS recipients;

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_shift_cancellation(UUID, TEXT) TO authenticated;

-- decide_cancellation_request: schedulers can decide
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
  v_actor_id    UUID := auth.uid();
  v_request     public.shift_cancellation_requests;
  v_stream      public.streams;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_new_status  TEXT;
BEGIN
  IF NOT public.is_scheduler() THEN
    RAISE EXCEPTION 'Only admins and producers can decide cancellation requests';
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
      decided_by = v_actor_id,
      decided_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

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

  DELETE FROM public.notifications
  WHERE request_id = p_request_id
    AND type = 'cancellation_request';

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

-- unbook_shift: schedulers can call too
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
  IF NOT public.is_scheduler() THEN
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
