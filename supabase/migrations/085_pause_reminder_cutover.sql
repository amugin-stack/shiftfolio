-- 085: Apply and COMMIT after 084 and compatible Edge deployment, before086.
-- Pause both legacy cron jobs. Wait for running jobs and pg_net requests to drain.
-- Rollback: keep paused until an audited forward fix; never replay sent reminders.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='shift-reminders') THEN PERFORM cron.unschedule('shift-reminders'); END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='shift-reminder-email-retries') THEN PERFORM cron.unschedule('shift-reminder-email-retries'); END IF;
END $$;
COMMIT;
