-- 077_swap_reminder_cron.sql
--
-- ⚠️  APPLY ONLY AFTER 076 IS APPLIED, THE EDGE FUNCTION IS DEPLOYED, AND THE
--     DRY-RUN OUTPUT HAS BEEN READ AND LOOKS RIGHT.
--
--     Until this file is applied, nothing about reminders has changed: 076
--     only creates a table and a function that nothing calls. This file is the
--     moment behaviour changes for real contractors.
--
-- INTENT
--   Retire the per-block 2-hour job from migration 038 and replace it with a
--   single per-arrival job covering all three tiers (48h, 24h, 2h).
--
--   Both jobs must never run at once — that would double-send every 2-hour
--   reminder. They are swapped inside one DO block so there is no window in
--   which both are scheduled.
--
-- WHY */10 AND NOT */5
--   The old job ticked every 5 minutes against a 10-minute band. The new one
--   ticks every 10 minutes against a 15-minute band per tier, so the band is
--   still wider than the tick (nothing falls between ticks) at a third of the
--   query volume. Worst case a reminder lands ~7 minutes off its nominal lead
--   time, which is immaterial at 2 hours and invisible at 24 or 48.
--
-- KILL SWITCH
--   Stops every reminder instantly and changes nothing else:
--     SELECT cron.unschedule('shift-reminders');
--
-- ROLLBACK — restores the old behaviour exactly:
--   SELECT cron.unschedule('shift-reminders');
--   SELECT cron.schedule(
--     'shift-reminders-2h',
--     '*/5 * * * *',
--     $job$
--       SELECT public._emit_shift_reminder_notifications(s.id)
--       FROM public.streams s
--       WHERE s.reminder_sent_at IS NULL
--         AND s.host_id IS NOT NULL
--         AND s.start_time BETWEEN
--               (((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
--                 + interval '115 minutes')
--           AND (((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
--                 + interval '125 minutes');
--     $job$
--   );
--   (The old emitter, _emit_shift_reminder_notifications, is deliberately left
--   in place by this migration so that rollback is a single statement. Dropping
--   it is a later, separate migration once the new job has run for a while.)

----------------------------------------------------------------------
-- 0. Close the hole in the OLD emitter before standing it down.
--
--    Checked against the live DB on 2026-09-09:
--      proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
--    So migration 059's REVOKE never took effect on this function. PUBLIC and
--    anon are clear, but `authenticated` still holds EXECUTE — and PostgREST
--    exposes it at /rest/v1/rpc/ (the leading underscore hides nothing). Any
--    logged-in user, including a deactivated host who still has a valid token,
--    can loop it: each call inserts up to 3 notifications rows and the trigger
--    from 039 turns each into a REAL email on our Resend account, then sets
--    streams.reminder_sent_at so the genuine reminder for that shift never
--    fires.
--
--    Retiring the job (step 3 below) removes the "silence a reminder forever"
--    half of that, because the new system reads public.shift_reminders and
--    never looks at reminder_sent_at. The unbounded-email half survives until
--    this REVOKE runs, so it runs here rather than in a follow-up.
--
--    service_role and postgres keep EXECUTE: service_role bypasses grants
--    anyway, and postgres is what the rollback job in the header runs as.
----------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._emit_shift_reminder_notifications(uuid)
  FROM PUBLIC, anon, authenticated;

-- Post-revoke check — `authenticated` must be gone from this list:
--   SELECT proname, proacl FROM pg_proc
--    WHERE proname = '_emit_shift_reminder_notifications';

DO $swap$
BEGIN
  -- 1. Stand down the old per-block job.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shift-reminders-2h') THEN
    PERFORM cron.unschedule('shift-reminders-2h');
  END IF;

  -- 2. Idempotent re-apply: clear our own job if a previous run created it.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shift-reminders') THEN
    PERFORM cron.unschedule('shift-reminders');
  END IF;

  -- 3. One job, all three tiers, soonest first so the time-critical 2-hour
  --    reminder is never queued behind the others.
  PERFORM cron.schedule(
    'shift-reminders',
    '*/10 * * * *',
    $job$
      SELECT 1
        FROM unnest(ARRAY['2h', '24h', '48h']) AS t(tier),
             LATERAL public._emit_shift_reminders(t.tier) AS r;
    $job$
  );
END
$swap$;

-- Post-apply check — expect exactly one row, jobname 'shift-reminders', active:
--   SELECT jobid, jobname, schedule, active FROM cron.job;
-- Then watch one cycle:
--   SELECT status, return_message, start_time FROM cron.job_run_details
--    ORDER BY start_time DESC LIMIT 10;
