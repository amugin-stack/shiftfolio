-- ============================================================
-- Carry profiles.phone into auto-created host rows
-- ============================================================
-- When a user self-serve requests brand access, request_brand()
-- find-or-creates their hosts row from public.profiles. Now that
-- migration 044 populates profiles.phone at signup and hosts has a
-- phone column (migration 043, surfaced in the admin Hosts table),
-- copy phone into the new host row too — otherwise a host who DID
-- enter a phone at signup shows "—" in the admin Phone column.
-- NULLIF(p.phone,'') maps the trigger's '' default back to NULL so
-- blank phones stay "—" rather than empty strings.
--
-- This is a faithful CREATE OR REPLACE of the live request_brand
-- definition (last set in agent2migrations/002_producer_brand_assignment);
-- the ONLY change is adding phone to the host-creation INSERT.
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_brand(p_brand_id uuid)
 RETURNS brand_host_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    INSERT INTO public.hosts (name, email, phone, user_id)
    SELECT
      COALESCE(NULLIF(p.full_name, ''), p.email, 'New Host'),
      p.email,
      NULLIF(p.phone, ''),
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
$function$;
