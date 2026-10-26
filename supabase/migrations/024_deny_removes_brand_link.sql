-- ============================================================
-- decide_brand_request: deny now also removes any matching
-- brand_hosts link, so the verdict is consistent regardless of
-- whether an admin pre-linked the host before deciding.
-- ============================================================
-- Bug fix: previously deny only flipped status='denied' and the
-- host kept access if an admin had already inserted brand_hosts
-- through HostsManager. Now deny is symmetric with approve —
-- it removes the link if present.
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

  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_request.host_user_id LIMIT 1;
  SELECT name INTO v_brand_name
  FROM public.brands WHERE id = v_request.brand_id;

  IF v_host_id IS NOT NULL THEN
    IF p_approve THEN
      INSERT INTO public.brand_hosts (brand_id, host_id)
      VALUES (v_request.brand_id, v_host_id)
      ON CONFLICT DO NOTHING;
    ELSE
      -- Symmetric with approve: deny removes any pre-existing link
      DELETE FROM public.brand_hosts
      WHERE brand_id = v_request.brand_id AND host_id = v_host_id;
    END IF;
  END IF;

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
