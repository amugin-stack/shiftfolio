-- ============================================================
-- Restore symmetric deny-deletes-link in decide_brand_request
-- ============================================================
-- Migration 024 made the decide_brand_request RPC symmetric:
-- approving a request inserts a brand_hosts link, denying removes
-- any pre-existing one. When agent2migrations/002 rewrote the
-- function to narrow authorization to is_brand_scheduler() and
-- update the notification fan-out, the `ELSE DELETE ...` clause
-- on the deny path was dropped inadvertently.
--
-- This restores the symmetric behavior so an admin denying a
-- pending request also unlinks the host. All other 002 behavior
-- (per-brand authz, narrowed producer fan-out, request-history
-- notifications) is preserved.
--
-- Note: there's no streams-orphan check at the RPC level here —
-- the deny path is rare and the UI safeguard for direct unlinks
-- in HostsManager covers the common case. If a deny-path safeguard
-- is needed later, add an EXISTS check against streams + future
-- end_time before the DELETE.
-- ============================================================

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

  -- Symmetric link management: approve inserts the link, deny removes
  -- any pre-existing one (matches mig 024 behavior).
  IF v_host_id IS NOT NULL THEN
    IF p_approve THEN
      INSERT INTO public.brand_hosts (brand_id, host_id)
      VALUES (v_request.brand_id, v_host_id)
      ON CONFLICT DO NOTHING;
    ELSE
      DELETE FROM public.brand_hosts
      WHERE brand_id = v_request.brand_id AND host_id = v_host_id;
    END IF;
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
