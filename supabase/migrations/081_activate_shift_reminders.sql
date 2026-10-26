-- 081: Activate only AFTER 079, 080, deployed tier-aware email code, dry-run
-- review, and a read-only check that old cron/function executions have drained.
-- Refresh the legacy seed NOW: 076 may have been installed days before cutover.
-- Rollback: unschedule both new jobs. Never restore legacy directly (its flags
-- do not include newly emitted reminders). Keep ledger and notification history.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='shift-reminders-2h' AND active) THEN
    RAISE EXCEPTION 'Apply and commit 080 first';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job_run_details WHERE status IN ('running','starting')
    AND command LIKE '%_emit_shift_reminder_notifications%') THEN
    RAISE EXCEPTION 'Wait for the legacy reminder run to finish';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active'
    AND query LIKE '%_emit_shift_reminder_notifications%') THEN
    RAISE EXCEPTION 'Legacy emitter still active';
  END IF;
  IF to_regprocedure('public._retry_shift_reminder_emails()') IS NULL THEN
    RAISE EXCEPTION 'Apply 079 first';
  END IF;
END $$;
INSERT INTO public.shift_reminders (stream_id, recipient_role, recipient_ref, tier, sent_at)
SELECT s.id, 'host', s.host_id, '2h', s.reminder_sent_at
  FROM public.streams s
 WHERE s.reminder_sent_at IS NOT NULL
   AND s.host_id IS NOT NULL
   AND s.start_time > ((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
ON CONFLICT DO NOTHING;

INSERT INTO public.shift_reminders (stream_id, recipient_role, recipient_ref, tier, sent_at)
SELECT s.id, 'moderator', s.moderator_id, '2h', s.reminder_sent_at
  FROM public.streams s
 WHERE s.reminder_sent_at IS NOT NULL
   AND s.moderator_id IS NOT NULL
   AND s.start_time > ((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
ON CONFLICT DO NOTHING;


DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='shift-reminders') THEN
    PERFORM cron.unschedule('shift-reminders');
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='shift-reminder-email-retries') THEN
    PERFORM cron.unschedule('shift-reminder-email-retries');
  END IF;
  PERFORM cron.schedule('shift-reminders','*/10 * * * *',
    $job$SELECT 1 FROM unnest(ARRAY['2h','24h','48h']) AS t(tier), LATERAL public._emit_shift_reminders(t.tier) AS r;$job$);
  PERFORM cron.schedule('shift-reminder-email-retries','*/3 * * * *',
    $job$SELECT public._retry_shift_reminder_emails();$job$);
END $$;
COMMIT;
