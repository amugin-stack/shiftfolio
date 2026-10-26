-- ============================================================
-- Fix: resolve pending cancellation requests when admin deletes a stream
-- ============================================================
-- Migration 031 lets admins delete past streams. If a stream has a
-- pending shift_cancellation_request, the ON DELETE CASCADE silently
-- removes the request row. Admins reviewing the inbox may have it open
-- and never realise it's been auto-handled, and the host never gets a
-- result notification.
--
-- Fix: BEFORE DELETE trigger on streams. If a pending request exists,
--   1. Mark the request as approved (admin deleting = effectively granting).
--   2. Delete every admin's outstanding cancellation_request notification
--      so it disappears from their bell live via realtime.
--   3. Insert a cancellation_request_approved notification for the host.
-- After the trigger runs, the CASCADE drops the request row, but the
-- host's result notification survives because it snapshots host_name +
-- brand_name and notifications.request_id is no longer a hard FK
-- (the FK was dropped in migration 025).
-- ============================================================

CREATE OR REPLACE FUNCTION public.streams_resolve_pending_cancellation_on_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request    public.shift_cancellation_requests;
  v_host_name  TEXT;
  v_brand_name TEXT;
  v_admin_id   UUID := auth.uid();
BEGIN
  -- Find the pending request for this stream, if any.
  SELECT * INTO v_request
  FROM public.shift_cancellation_requests
  WHERE stream_id = OLD.id
    AND status = 'pending'
  LIMIT 1;

  IF v_request.id IS NULL THEN
    RETURN OLD;
  END IF;

  -- Look up snapshot fields the host's result notification will use.
  SELECT name INTO v_host_name
  FROM public.hosts
  WHERE user_id = v_request.host_user_id
  LIMIT 1;

  SELECT name INTO v_brand_name
  FROM public.brands
  WHERE id = OLD.brand_id;

  -- Mark the request as approved (treat admin delete as granting the cancel).
  UPDATE public.shift_cancellation_requests
     SET status     = 'approved',
         decided_by = v_admin_id,
         decided_at = NOW()
   WHERE id = v_request.id;

  -- Clear cancellation_request notifications from every admin's bell.
  DELETE FROM public.notifications
   WHERE request_id = v_request.id
     AND type = 'cancellation_request';

  -- Send the host their result notification.
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name,
     shift_start, shift_end, request_id)
  VALUES (
    v_request.host_user_id,
    'cancellation_request_approved',
    NULL,
    COALESCE(v_host_name, 'You'),
    OLD.brand_id,
    COALESCE(v_brand_name, 'Brand'),
    OLD.start_time,
    OLD.end_time,
    v_request.id
  );

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS streams_resolve_cancellation_on_delete ON public.streams;
CREATE TRIGGER streams_resolve_cancellation_on_delete
  BEFORE DELETE ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.streams_resolve_pending_cancellation_on_delete();
