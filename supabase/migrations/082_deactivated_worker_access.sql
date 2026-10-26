-- 082: Enforce deactivated-worker access without removing own completed pay.
-- Apply after081; additive history UI depends on performance helper in087.
-- No rates or payroll records are rewritten. Keep restrictions on rollback;
-- remove the history link if its later helper is unavailable, then forward-fix.
BEGIN;
CREATE OR REPLACE FUNCTION public._is_deactivated_worker()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT auth.uid() IS NOT NULL
 AND NOT public.is_admin()
 AND NOT EXISTS(SELECT 1 FROM public.producers WHERE user_id=auth.uid())
 AND (EXISTS(SELECT 1 FROM public.hosts WHERE user_id=auth.uid())
   OR EXISTS(SELECT 1 FROM public.moderators WHERE user_id=auth.uid()))
 AND NOT EXISTS(SELECT 1 FROM public.hosts WHERE user_id=auth.uid() AND is_active)
 AND NOT EXISTS(SELECT 1 FROM public.moderators WHERE user_id=auth.uid() AND is_active);
$$;
REVOKE ALL ON FUNCTION public._is_deactivated_worker() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public._is_deactivated_worker() TO authenticated;
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

  IF public._is_deactivated_worker() THEN
    RAISE EXCEPTION 'Your account is no longer active';
  END IF;
  -- An inactive host membership cannot be used for new requests even when
  -- another active role allows this person to keep using the application.
  IF EXISTS (SELECT 1 FROM public.hosts WHERE user_id=v_user_id AND NOT is_active) THEN
    RAISE EXCEPTION 'Your host membership is no longer active';
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
CREATE OR REPLACE FUNCTION public.get_my_stream_pay(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(stream_id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  JOIN public.hosts h ON h.id = s.host_id
  WHERE h.user_id = auth.uid()
    AND (NOT public._is_deactivated_worker() OR s.end_time <= (now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
    AND (p_from IS NULL OR s.end_time >= p_from)
    AND (p_to   IS NULL OR s.end_time <  p_to)
  ORDER BY s.id;
$$;
CREATE OR REPLACE FUNCTION public.get_my_pay_context()
RETURNS TABLE(host_rate_cents INT, moderator_rate_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    (SELECT h.rate_cents FROM public.hosts h      WHERE h.user_id = auth.uid() LIMIT 1),
    (SELECT m.rate_cents FROM public.moderators m WHERE m.user_id = auth.uid() LIMIT 1)
  WHERE NOT public._is_deactivated_worker();
$$;
CREATE OR REPLACE FUNCTION public.get_my_setup_bonus_stream_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH me AS (
    SELECT id FROM public.moderators WHERE user_id = auth.uid() LIMIT 1
  ),
  ranked AS (
    SELECT s.id, s.moderator_id, s.end_time,
           ROW_NUMBER() OVER (
             PARTITION BY s.brand_id, (s.start_time AT TIME ZONE 'UTC')::date
             ORDER BY s.start_time, s.id
           ) AS rn
    FROM public.streams s
    WHERE s.moderator_id IS NOT NULL
  )
  SELECT r.id
  FROM ranked r
  JOIN me ON me.id = r.moderator_id
  WHERE r.rn = 1 AND (NOT public._is_deactivated_worker() OR r.end_time <= (now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
$$;
-- Existing clients only update is_read. Service role keeps delivery columns.
REVOKE UPDATE ON public.notifications FROM PUBLIC,anon,authenticated;
-- A table-level revoke does not remove older column-specific grants.
-- Clear those too; columns added later inherit no client UPDATE privilege.
DO $$
DECLARE v_column text;
BEGIN
  FOR v_column IN SELECT attname FROM pg_attribute
    WHERE attrelid='public.notifications'::regclass AND attnum>0 AND NOT attisdropped
  LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON public.notifications FROM PUBLIC,anon,authenticated',v_column);
  END LOOP;
END $$;
GRANT UPDATE(is_read) ON public.notifications TO authenticated;
REVOKE ALL ON FUNCTION public.get_my_setup_bonus_stream_ids() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_setup_bonus_stream_ids() TO authenticated;
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

  IF public._is_deactivated_worker() OR EXISTS (SELECT 1 FROM public.hosts WHERE user_id=v_user_id AND NOT is_active) THEN
    RAISE EXCEPTION 'Your host membership is no longer active';
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

-- Restrictive policies are ANDed with every existing permissive policy.
-- Own identity rows remain readable for the blocked screen and role resolver;
-- completed pay is available only through identity-scoped SECURITY DEFINER RPCs.
-- Every existing RLS table is covered, including legacy metadata and storage.
DO $$
DECLARE r record; v_read text;
BEGIN
  FOR r IN SELECT n.nspname AS schema_name,c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relrowsecurity
      AND (n.nspname='public' OR (n.nspname='storage' AND c.relname='objects'))
  LOOP
    v_read := 'NOT public._is_deactivated_worker()';
    IF r.schema_name='public' AND r.table_name IN ('hosts','moderators','producers') THEN
      v_read := v_read || ' OR user_id=auth.uid()';
    ELSIF r.schema_name='public' AND r.table_name='profiles' THEN
      v_read := v_read || ' OR id=auth.uid()';
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS inactive_read_boundary ON %I.%I',r.schema_name,r.table_name);
    EXECUTE format('CREATE POLICY inactive_read_boundary ON %I.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)',r.schema_name,r.table_name,v_read);
    EXECUTE format('DROP POLICY IF EXISTS inactive_insert_boundary ON %I.%I',r.schema_name,r.table_name);
    EXECUTE format('CREATE POLICY inactive_insert_boundary ON %I.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT public._is_deactivated_worker())',r.schema_name,r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS inactive_update_boundary ON %I.%I',r.schema_name,r.table_name);
    EXECUTE format('CREATE POLICY inactive_update_boundary ON %I.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT public._is_deactivated_worker()) WITH CHECK (NOT public._is_deactivated_worker())',r.schema_name,r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS inactive_delete_boundary ON %I.%I',r.schema_name,r.table_name);
    EXECUTE format('CREATE POLICY inactive_delete_boundary ON %I.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT public._is_deactivated_worker())',r.schema_name,r.table_name);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
