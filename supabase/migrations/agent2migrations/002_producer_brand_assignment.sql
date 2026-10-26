-- ============================================================
-- Producers are now assigned to specific brands
-- ============================================================
-- Per-producer brand scoping. A brand has at most one producer
-- (brands.producer_id), and a producer can run multiple brands.
-- Producers gain full scheduling power on their assigned brands
-- (streams, rate cards, host links, brand metadata excluding
-- client_rate_cents) and lose access to brands they're not assigned
-- to. Admins keep god-mode unchanged.
--
-- The previous migration 035 made every producer a global scheduler.
-- This migration narrows that to per-brand scope. Existing producers
-- end up with zero assignments until an admin assigns them via the
-- /admin/brands UI.
-- ============================================================

-- 1. The assignment column ------------------------------------
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS producer_id UUID
    REFERENCES public.producers(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_brands_producer_id
  ON public.brands(producer_id);

-- 2. Per-brand scheduler helper -------------------------------
-- True for admins (always) OR the producer currently assigned to the
-- given brand. Mirrors is_scheduler() but scoped to a single brand.
CREATE OR REPLACE FUNCTION public.is_brand_scheduler(p_brand_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.brands b
      JOIN public.producers p ON p.id = b.producer_id
      WHERE b.id = p_brand_id
        AND p.user_id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_brand_scheduler(UUID) TO authenticated;

-- 3. streams: writes narrowed to per-brand --------------------
DROP POLICY IF EXISTS "streams: scheduler insert" ON public.streams;
DROP POLICY IF EXISTS "streams: scheduler update" ON public.streams;
DROP POLICY IF EXISTS "streams: scheduler delete" ON public.streams;

CREATE POLICY "streams: brand scheduler insert"
  ON public.streams FOR INSERT
  WITH CHECK (public.is_brand_scheduler(brand_id));

CREATE POLICY "streams: brand scheduler update"
  ON public.streams FOR UPDATE
  USING (public.is_brand_scheduler(brand_id));

CREATE POLICY "streams: brand scheduler delete"
  ON public.streams FOR DELETE
  USING (public.is_brand_scheduler(brand_id));

-- 4. streams: SELECT narrowed for producers -------------------
-- Previous policy gave any producer broad read on every stream. Now
-- producers see only streams on brands they're assigned to. Hosts,
-- moderators-on-stream, and brand-link logic are unchanged.
DROP POLICY IF EXISTS "streams: read own or admin" ON public.streams;

CREATE POLICY "streams: read own or admin"
  ON public.streams FOR SELECT
  USING (
    public.is_admin()
    OR auth.uid() IN (
      SELECT user_id FROM public.hosts      WHERE id = streams.host_id      AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.brands     WHERE id = streams.brand_id     AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.producers  WHERE id = streams.producer_id  AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.moderators WHERE id = streams.moderator_id AND user_id IS NOT NULL
    )
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.brand_hosts bh
      JOIN public.hosts h ON h.id = bh.host_id
      WHERE bh.brand_id = streams.brand_id
        AND h.user_id = auth.uid()
    )
    -- Producers see streams only on brands they're assigned to.
    OR EXISTS (
      SELECT 1
      FROM public.producers p
      JOIN public.brands b ON b.producer_id = p.id
      WHERE p.user_id = auth.uid()
        AND b.id = streams.brand_id
    )
  );

-- 5. brand_shift_rates: producer of the brand can manage ------
-- Hosts pay rates: admin or the brand's assigned producer.
DROP POLICY IF EXISTS "shift_rates: admin insert" ON public.brand_shift_rates;
DROP POLICY IF EXISTS "shift_rates: admin update" ON public.brand_shift_rates;
DROP POLICY IF EXISTS "shift_rates: admin delete" ON public.brand_shift_rates;

CREATE POLICY "shift_rates: brand scheduler insert"
  ON public.brand_shift_rates FOR INSERT
  WITH CHECK (public.is_brand_scheduler(brand_id));

CREATE POLICY "shift_rates: brand scheduler update"
  ON public.brand_shift_rates FOR UPDATE
  USING (public.is_brand_scheduler(brand_id));

CREATE POLICY "shift_rates: brand scheduler delete"
  ON public.brand_shift_rates FOR DELETE
  USING (public.is_brand_scheduler(brand_id));

-- 6. brand_shift_overrides: same scoping ----------------------
DROP POLICY IF EXISTS "shift_overrides: admin insert" ON public.brand_shift_overrides;
DROP POLICY IF EXISTS "shift_overrides: admin update" ON public.brand_shift_overrides;
DROP POLICY IF EXISTS "shift_overrides: admin delete" ON public.brand_shift_overrides;

CREATE POLICY "shift_overrides: brand scheduler insert"
  ON public.brand_shift_overrides FOR INSERT
  WITH CHECK (public.is_brand_scheduler(brand_id));

CREATE POLICY "shift_overrides: brand scheduler update"
  ON public.brand_shift_overrides FOR UPDATE
  USING (public.is_brand_scheduler(brand_id));

CREATE POLICY "shift_overrides: brand scheduler delete"
  ON public.brand_shift_overrides FOR DELETE
  USING (public.is_brand_scheduler(brand_id));

-- 7. brand_hosts: narrow to brand scheduler -------------------
DROP POLICY IF EXISTS "brand_hosts: scheduler insert" ON public.brand_hosts;
DROP POLICY IF EXISTS "brand_hosts: scheduler delete" ON public.brand_hosts;

CREATE POLICY "brand_hosts: brand scheduler insert"
  ON public.brand_hosts FOR INSERT
  WITH CHECK (public.is_brand_scheduler(brand_id));

CREATE POLICY "brand_hosts: brand scheduler delete"
  ON public.brand_hosts FOR DELETE
  USING (public.is_brand_scheduler(brand_id));

-- 8. brands: producer can update their own brand --------------
-- Insert/delete remain admin-only (creating brands and removing them
-- is higher-trust). Producers can update metadata on their assigned
-- brand. Pricing-write trigger from 036 still blocks non-admin
-- client_rate_cents changes regardless of this policy.
DROP POLICY IF EXISTS "brands: scheduler insert" ON public.brands;
DROP POLICY IF EXISTS "brands: scheduler update" ON public.brands;
DROP POLICY IF EXISTS "brands: scheduler delete" ON public.brands;

CREATE POLICY "brands: admin insert"
  ON public.brands FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "brands: brand scheduler update"
  ON public.brands FOR UPDATE
  USING (public.is_brand_scheduler(id));

CREATE POLICY "brands: admin delete"
  ON public.brands FOR DELETE
  USING (public.is_admin());

-- 9. Narrow notification fan-out + decision authorization -----
-- Existing RPCs in migrations 023/024/025/035 fan out brand_request
-- and cancellation_request to every admin AND every producer. Narrow
-- producers to "the producer assigned to this brand" only. Also
-- update the decision RPCs so only the brand's producer (or any
-- admin) can approve/deny that brand's requests.

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

  -- Fan out: admins + the brand's assigned producer (if any).
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, request_id)
  SELECT
    recipient_id, 'brand_request', v_host_id, COALESCE(v_host_name, 'New Host'),
    p_brand_id, v_brand_name, v_request.id
  FROM (
    SELECT id AS recipient_id FROM public.profiles WHERE role = 'admin'
    UNION
    SELECT p.user_id AS recipient_id
    FROM public.producers p
    JOIN public.brands b ON b.producer_id = p.id
    WHERE b.id = p_brand_id
      AND p.user_id IS NOT NULL
  ) AS recipients;

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_brand(UUID) TO authenticated;

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
  SELECT * INTO v_request
  FROM public.brand_host_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF NOT public.is_brand_scheduler(v_request.brand_id) THEN
    RAISE EXCEPTION 'Only admins and the brand''s producer can decide this request';
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

  -- Pull the brand_request notification from every prior recipient
  -- (admins + the previously-fanned-out producer).
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

  -- Fan out: admins + the brand's assigned producer (if any).
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
    SELECT p.user_id AS recipient_id
    FROM public.producers p
    JOIN public.brands b ON b.producer_id = p.id
    WHERE b.id = v_stream.brand_id
      AND p.user_id IS NOT NULL
  ) AS recipients;

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_shift_cancellation(UUID, TEXT) TO authenticated;

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
  SELECT * INTO v_request
  FROM public.shift_cancellation_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  SELECT * INTO v_stream FROM public.streams WHERE id = v_request.stream_id;

  -- Authorization scoped to the stream's brand. If the stream is
  -- gone (rare race), fall back to admin-only.
  IF v_stream.id IS NULL THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Only admins can decide an orphaned cancellation request';
    END IF;
  ELSE
    IF NOT public.is_brand_scheduler(v_stream.brand_id) THEN
      RAISE EXCEPTION 'Only admins and the brand''s producer can decide this request';
    END IF;
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been decided';
  END IF;

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
