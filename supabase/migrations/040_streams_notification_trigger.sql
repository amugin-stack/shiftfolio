-- 040_streams_notification_trigger.sql
-- Emit `shift_booked` notifications when a stream is created or a role on it
-- changes. Until this migration, only host self-bookings (via book_shift RPC)
-- wrote any notification row at all, and those notifications went to admins
-- as oversight — never to the host/moderator/producer being assigned. The
-- email feature requires "let the affected party know they were booked",
-- which is what this trigger provides.
--
-- Out of scope (deferred to v2):
--   - DELETE handling (admin force-cancel)            → shift_cancelled emails
--   - UPDATE handling for time-only changes            → shift_edited emails
--   - UPDATE handling for de-assigned roles            → shift_cancelled emails
--   - The 033_resolve_cancellation_on_stream_delete trigger already covers
--     the "host's cancellation request was approved" delete path.

CREATE OR REPLACE FUNCTION public._emit_stream_change_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_brand_name  text;
  v_host_name   text;
  v_host_uid    uuid;
  v_mod_uid     uuid;
  v_prod_uid    uuid;
  v_actor       uuid := auth.uid();
BEGIN
  -- Resolve names + per-role user_ids for the NEW row state.
  SELECT b.name INTO v_brand_name
    FROM public.brands b WHERE b.id = NEW.brand_id;
  SELECT h.name, h.user_id INTO v_host_name, v_host_uid
    FROM public.hosts h WHERE h.id = NEW.host_id;
  SELECT m.user_id INTO v_mod_uid
    FROM public.moderators m WHERE m.id = NEW.moderator_id;
  SELECT p.user_id INTO v_prod_uid
    FROM public.producers p WHERE p.id = NEW.producer_id;

  IF TG_OP = 'INSERT' THEN
    -- Host: notify unless they self-booked (auth.uid() == their user_id).
    -- A host self-booking via the calendar UI doesn't need a "you were
    -- booked" email to themselves; admin/scheduler bookings always trigger.
    IF v_host_uid IS NOT NULL AND v_host_uid IS DISTINCT FROM v_actor THEN
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES
        (v_host_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'),
         COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

    -- Moderator: notify whenever assigned.
    IF v_mod_uid IS NOT NULL THEN
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES
        (v_mod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'),
         COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

    -- Producer: notify whenever assigned.
    IF v_prod_uid IS NOT NULL THEN
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES
        (v_prod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'),
         COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- v1: only handle role *reassignment* (a new person is now on the shift).
    -- A new host who wasn't on the shift before gets `shift_booked`. Same for
    -- moderator and producer. Old assignees are NOT yet notified that they
    -- were removed; that's the deferred v2 cancel-flow work.
    IF NEW.host_id IS DISTINCT FROM OLD.host_id
       AND v_host_uid IS NOT NULL
       AND v_host_uid IS DISTINCT FROM v_actor
    THEN
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES
        (v_host_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'),
         COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

    IF NEW.moderator_id IS DISTINCT FROM OLD.moderator_id
       AND v_mod_uid IS NOT NULL
    THEN
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES
        (v_mod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'),
         COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;

    IF NEW.producer_id IS DISTINCT FROM OLD.producer_id
       AND v_prod_uid IS NOT NULL
    THEN
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
      VALUES
        (v_prod_uid, 'shift_booked', COALESCE(v_host_name, 'TBD'),
         COALESCE(v_brand_name, 'Studio'), NEW.brand_id, NEW.start_time, NEW.end_time, NEW.host_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public._emit_stream_change_notifications() IS
  'AFTER INSERT/UPDATE trigger on streams: emits shift_booked notifications to the assigned host/moderator/producer when they''re newly assigned. Skips host self-bookings to avoid notifying the actor of their own action.';

DROP TRIGGER IF EXISTS streams_emit_change_notifications ON public.streams;
CREATE TRIGGER streams_emit_change_notifications
  AFTER INSERT OR UPDATE ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public._emit_stream_change_notifications();
