-- 041_stream_trigger_v2.sql
-- Iteration on 040: removes the over-eager "self-booking" guard, adds DELETE
-- handling for shift_cancelled emails, and recreates the trigger to fire on
-- DELETE as well.
--
-- Changes from 040:
-- 1. INSERT path: removed `host_uid IS DISTINCT FROM v_actor` guard. Admin
--    bookings where the admin is also a host were being skipped — the host
--    should always be notified when newly assigned to a shift, regardless
--    of who triggered the booking.
-- 2. DELETE path (new): emits `shift_cancelled` notifications to all
--    assigned host/moderator/producer when a stream is deleted. Covers the
--    admin force-cancel case. The existing migration 033 trigger still
--    handles cancellation_request_approved separately.
--
-- v3 deferred: UPDATE time-only edits → shift_edited emails. (Currently the
-- update branch only fires on role reassignment.)

CREATE OR REPLACE FUNCTION public._emit_stream_change_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_brand_name text;
  v_host_name  text;
  v_host_uid   uuid;
  v_mod_uid    uuid;
  v_prod_uid   uuid;
  v_row        RECORD;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  SELECT b.name INTO v_brand_name FROM public.brands b WHERE b.id = v_row.brand_id;
  SELECT h.name, h.user_id INTO v_host_name, v_host_uid FROM public.hosts h WHERE h.id = v_row.host_id;
  SELECT m.user_id INTO v_mod_uid FROM public.moderators m WHERE m.id = v_row.moderator_id;
  SELECT p.user_id INTO v_prod_uid FROM public.producers p WHERE p.id = v_row.producer_id;

  IF TG_OP = 'INSERT' THEN
    IF v_host_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_host_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;
    IF v_mod_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_mod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;
    IF v_prod_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_prod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.host_id IS DISTINCT FROM OLD.host_id AND v_host_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_host_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;
    IF NEW.moderator_id IS DISTINCT FROM OLD.moderator_id AND v_mod_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_mod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;
    IF NEW.producer_id IS DISTINCT FROM OLD.producer_id AND v_prod_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_prod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    IF v_host_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_host_uid, 'shift_cancelled', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), OLD.brand_id, OLD.start_time, OLD.end_time, OLD.host_id);
    END IF;
    IF v_mod_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_mod_uid, 'shift_cancelled', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), OLD.brand_id, OLD.start_time, OLD.end_time, OLD.host_id);
    END IF;
    IF v_prod_uid IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES (v_prod_uid, 'shift_cancelled', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, 'Studio'), OLD.brand_id, OLD.start_time, OLD.end_time, OLD.host_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$func$;

DROP TRIGGER IF EXISTS streams_emit_change_notifications ON public.streams;
CREATE TRIGGER streams_emit_change_notifications
  AFTER INSERT OR UPDATE OR DELETE ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public._emit_stream_change_notifications();
