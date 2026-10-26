-- 038_shift_reminder_cron.sql
-- Per-shift 2-hour-before email reminders.
--
-- Approach: pg_cron job runs every 5 minutes and inserts shift_reminder
-- notification rows for streams whose start_time falls in the
-- [now+115min, now+125min] window. The existing database webhook on
-- INSERT INTO notifications fires send-notification-email, which delivers
-- the email. `streams.reminder_sent_at` is the dedup guard so cron
-- overlaps can't double-fire.
--
-- Timezone note: streams.start_time is stored as PT-wall-clock encoded
-- as naive UTC (the app's APP_TIMEZONE='UTC' scheme). To match the
-- window correctly we re-interpret "real now" in the same convention
-- via `(now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC'`.

----------------------------------------------------------------------
-- 1. Enable pg_cron (Supabase ships it; this is idempotent).
----------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

----------------------------------------------------------------------
-- 2. Dedup guard column on streams.
----------------------------------------------------------------------
ALTER TABLE public.streams ADD COLUMN reminder_sent_at timestamptz;

COMMENT ON COLUMN public.streams.reminder_sent_at IS
  'Set by the shift-reminders-2h cron job once the 2h-before reminder notifications have been emitted. NULL = not yet sent.';

----------------------------------------------------------------------
-- 3. Widen notifications.type CHECK constraint for the new types.
----------------------------------------------------------------------
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'shift_booked'::text,
    'shift_edited'::text,
    'shift_cancelled'::text,
    'shift_reminder'::text,
    'brand_request'::text,
    'brand_request_approved'::text,
    'brand_request_denied'::text,
    'cancellation_request'::text,
    'cancellation_request_approved'::text,
    'cancellation_request_denied'::text
  ]));

----------------------------------------------------------------------
-- 4. Helper: emit one shift_reminder row per assigned role on a stream.
--
-- SECURITY DEFINER so the cron job can write notifications even though
-- it's not the user who'd normally be the author. search_path is locked
-- per the app convention. Idempotent via the WHERE reminder_sent_at IS
-- NULL guard in the cron query — the function itself does no further
-- locking, since cron's exclusive lock on the job prevents overlap.
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._emit_shift_reminder_notifications(p_stream_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stream      public.streams%ROWTYPE;
  v_host_uid    uuid;
  v_mod_uid     uuid;
  v_prod_uid    uuid;
  v_host_name   text;
  v_brand_name  text;
BEGIN
  SELECT * INTO v_stream FROM public.streams WHERE id = p_stream_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Resolve recipient user_ids and the display names denormalized onto the notification row.
  SELECT h.user_id, h.name INTO v_host_uid, v_host_name
    FROM public.hosts h WHERE h.id = v_stream.host_id;
  SELECT m.user_id INTO v_mod_uid
    FROM public.moderators m WHERE m.id = v_stream.moderator_id;
  SELECT p.user_id INTO v_prod_uid
    FROM public.producers p WHERE p.id = v_stream.producer_id;
  SELECT b.name INTO v_brand_name
    FROM public.brands b WHERE b.id = v_stream.brand_id;

  -- One notification per assigned recipient (host/moderator/producer)
  -- whose user_id is non-null (i.e. they have a Supabase auth user).
  IF v_host_uid IS NOT NULL THEN
    INSERT INTO public.notifications
      (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
    VALUES
      (v_host_uid, 'shift_reminder', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, '?'),
       v_stream.brand_id, v_stream.start_time, v_stream.end_time, v_stream.host_id);
  END IF;

  IF v_mod_uid IS NOT NULL THEN
    INSERT INTO public.notifications
      (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
    VALUES
      (v_mod_uid, 'shift_reminder', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, '?'),
       v_stream.brand_id, v_stream.start_time, v_stream.end_time, v_stream.host_id);
  END IF;

  IF v_prod_uid IS NOT NULL THEN
    INSERT INTO public.notifications
      (recipient_id, type, host_name, brand_name, brand_id, shift_start, shift_end, actor_host_id)
    VALUES
      (v_prod_uid, 'shift_reminder', COALESCE(v_host_name, 'TBD'), COALESCE(v_brand_name, '?'),
       v_stream.brand_id, v_stream.start_time, v_stream.end_time, v_stream.host_id);
  END IF;

  -- Mark sent so the next cron tick skips this stream.
  UPDATE public.streams SET reminder_sent_at = now() WHERE id = p_stream_id;
END;
$$;

COMMENT ON FUNCTION public._emit_shift_reminder_notifications(uuid) IS
  'Inserts shift_reminder notification rows for each assigned role on a stream. Called by the shift-reminders-2h pg_cron job. Idempotent via the streams.reminder_sent_at guard.';

----------------------------------------------------------------------
-- 5. Schedule the cron job. Runs every 5 minutes; finds streams whose
--    PT-wall-clock start time is 115-125 minutes from "now in PT".
----------------------------------------------------------------------
SELECT cron.schedule(
  'shift-reminders-2h',
  '*/5 * * * *',
  $$
    SELECT public._emit_shift_reminder_notifications(s.id)
    FROM public.streams s
    WHERE s.reminder_sent_at IS NULL
      AND s.host_id IS NOT NULL  -- skip unbooked / placeholder slots
      AND s.start_time BETWEEN
            (((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
              + interval '115 minutes')
        AND (((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
              + interval '125 minutes');
  $$
);
