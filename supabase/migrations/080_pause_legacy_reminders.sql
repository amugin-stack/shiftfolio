-- 080: Pause the old job AFTER 079 tests and deployed templates are verified.
-- Commit this separately so future old cron runs stop, then verify no running
-- old job/execution remains before 081. No staff data is modified or email sent.
-- If 081 cannot proceed, leave reminders paused and investigate; do not run two jobs.
BEGIN;
DO $$ BEGIN
  IF to_regprocedure('public._retry_shift_reminder_emails()') IS NULL THEN
    RAISE EXCEPTION 'Apply 079 before pausing reminders';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='shift-reminders-2h') THEN
    PERFORM cron.unschedule('shift-reminders-2h');
  END IF;
END $$;
COMMIT;
