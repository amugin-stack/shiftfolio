-- ============================================================
-- Brand Request System
-- ============================================================
-- Hosts request brands during onboarding (or from settings later);
-- admins accept or deny inline from the notification bell. Acting on
-- a request inserts the actual brand_hosts link and notifies the host.
--
-- Two SECURITY DEFINER RPCs are the only writers. The hosts row is
-- auto-created on the first request_brand call so fresh signups don't
-- need an admin to bootstrap them.
-- ============================================================

-- 1. brand_host_requests --------------------------------------

CREATE TABLE IF NOT EXISTS public.brand_host_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  brand_id      UUID NOT NULL REFERENCES public.brands(id)   ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied')) DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ
);

-- One pending request per (user, brand). Denied/approved rows don't block re-requesting.
CREATE UNIQUE INDEX IF NOT EXISTS brand_host_requests_pending_unique
  ON public.brand_host_requests (host_user_id, brand_id)
  WHERE status = 'pending';

ALTER TABLE public.brand_host_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brand_host_requests: own or admin select" ON public.brand_host_requests;
CREATE POLICY "brand_host_requests: own or admin select"
  ON public.brand_host_requests FOR SELECT
  USING (host_user_id = auth.uid() OR public.is_admin());

-- Writes go exclusively through SECURITY DEFINER RPCs — no INSERT/UPDATE/DELETE policies.

-- 2. notifications schema relaxations -------------------------

-- Brand requests don't have a time slot
ALTER TABLE public.notifications
  ALTER COLUMN shift_start DROP NOT NULL,
  ALTER COLUMN shift_end   DROP NOT NULL;

-- Add request_id so deciding a request can mass-delete the matching admin rows
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES public.brand_host_requests(id) ON DELETE CASCADE;

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
    'brand_request_denied'
  ));

-- 3. RPC: request_brand ---------------------------------------

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

  -- Find or auto-create a hosts row for this user
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

  -- Already linked? Reject
  IF EXISTS (
    SELECT 1 FROM public.brand_hosts
    WHERE brand_id = p_brand_id AND host_id = v_host_id
  ) THEN
    RAISE EXCEPTION 'You are already linked to this brand';
  END IF;

  -- Already pending? Reject (uniqueness index also enforces this race-safely)
  IF EXISTS (
    SELECT 1 FROM public.brand_host_requests
    WHERE host_user_id = v_user_id AND brand_id = p_brand_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending request for this brand';
  END IF;

  -- Snapshot brand name
  SELECT name INTO v_brand_name FROM public.brands WHERE id = p_brand_id;
  IF v_brand_name IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  INSERT INTO public.brand_host_requests (host_user_id, brand_id)
  VALUES (v_user_id, p_brand_id)
  RETURNING * INTO v_request;

  -- Fan out a brand_request notification to every admin
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, request_id)
  SELECT
    p.id, 'brand_request', v_host_id, COALESCE(v_host_name, 'New Host'),
    p_brand_id, v_brand_name, v_request.id
  FROM public.profiles p
  WHERE p.role = 'admin';

  RETURN v_request;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_brand(UUID) TO authenticated;

-- 4. RPC: decide_brand_request --------------------------------

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
  v_admin_id    UUID := auth.uid();
  v_request     public.brand_host_requests;
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_new_status  TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can decide brand requests';
  END IF;

  -- Lock the request row so two admins clicking concurrently don't both win
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
      decided_by = v_admin_id,
      decided_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  -- Resolve names for the result notification
  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_request.host_user_id LIMIT 1;
  SELECT name INTO v_brand_name
  FROM public.brands WHERE id = v_request.brand_id;

  -- If approved, materialise the brand_hosts link
  IF p_approve AND v_host_id IS NOT NULL THEN
    INSERT INTO public.brand_hosts (brand_id, host_id)
    VALUES (v_request.brand_id, v_host_id)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Pull the brand_request notification from every admin's inbox.
  -- Realtime DELETE events propagate to all admin clients.
  DELETE FROM public.notifications
  WHERE request_id = p_request_id
    AND type = 'brand_request';

  -- Notify the requesting host of the result
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
