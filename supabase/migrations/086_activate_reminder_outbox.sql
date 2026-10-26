-- 086: Apply only after085 committed, all legacy requests drained, compatible
-- sender/template hashes verified, and isolated concurrency/capacity tests pass.
-- Activation creates a baseline; no historical catch-up. Keeps accepted history.
-- Rollback: cron.unschedule('reminder-v2'); runtime.enabled=false via reviewed fix.
-- Do not restore old emitters: their ledger does not include new-version sends.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job WHERE active AND jobname IN('shift-reminders','shift-reminder-email-retries')) THEN
  RAISE EXCEPTION 'Apply and commit085 first'; END IF;
 IF EXISTS(SELECT 1 FROM cron.job_run_details WHERE status IN('running','starting')
  AND (command LIKE '%_emit_shift_reminders%' OR command LIKE '%_retry_shift_reminder_emails%')) THEN
  RAISE EXCEPTION 'Wait for legacy jobs to drain'; END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active'
  AND (query LIKE '%_emit_shift_reminders%' OR query LIKE '%_retry_shift_reminder_emails%')) THEN
  RAISE EXCEPTION 'Legacy emitter still active'; END IF;
 IF EXISTS(SELECT 1 FROM public.shift_reminders WHERE last_email_attempt_at>now()-interval '5 minutes') THEN
  RAISE EXCEPTION 'Wait five minutes after the last legacy dispatch for in-flight Edge calls'; END IF;
 IF EXISTS(SELECT 1 FROM net.http_request_queue WHERE url LIKE '%send-notification-email%') THEN
  RAISE EXCEPTION 'Wait for queued notification HTTP requests to drain'; END IF;
 IF EXISTS(SELECT 1 FROM public.reminder_runtime WHERE activated_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Already activated; preserve cutoff and history'; END IF;
END $$;
INSERT INTO public.reminder_sessions(anchor_id,role,ref,snapshot,recipient_id,shift_start,shift_end,real_start,first_seen_at,covered_hours)
SELECT s.anchor_id,s.role,s.ref,s.snapshot,s.recipient_id,s.shift_start,s.shift_end,s.real_start,s.first_seen_at,
 coalesce((SELECT min(CASE sr.tier WHEN '48h' THEN 48 WHEN '24h' THEN 24 ELSE 2 END)
 FROM public.shift_reminders sr WHERE sr.stream_id=s.anchor_id AND sr.recipient_role=s.role AND sr.recipient_ref=s.ref),49)
FROM public._current_reminder_sessions() s;
-- Import upcoming legacy notifications into durable history, retaining provider
-- keys and snapshots. A legacy snapshot lacks version entries, so use the current
-- baseline only when the legacy guard confirms exact assignment/session identity.
INSERT INTO public.reminder_outbox(notification_id,anchor_id,role,ref,revision,snapshot,recipient_id,real_start,tier_hours,state,attempts,last_attempt_at,next_attempt_at)
SELECT n.id,s.anchor_id,s.role,s.ref,s.revision,s.snapshot,n.recipient_id,s.real_start,
 CASE sr.tier WHEN '48h' THEN 48 WHEN '24h' THEN 24 ELSE 2 END,
 CASE WHEN n.email_delivered_at IS NOT NULL THEN 'delivered' WHEN n.email_sent_at IS NOT NULL THEN 'accepted'
 WHEN public._shift_reminder_is_current(n.id) THEN 'queued' ELSE 'superseded' END,
 sr.email_attempts,sr.last_email_attempt_at,now()
FROM public.shift_reminders sr JOIN public.notifications n ON n.id=sr.notification_id
JOIN public.reminder_sessions s ON s.anchor_id=sr.stream_id AND s.role=sr.recipient_role AND s.ref=sr.recipient_ref
ON CONFLICT DO NOTHING;
-- Imported rows need metadata for the compatible sender; copy never changes the
-- original body/time, delivery timestamps, or provider idempotency key.
UPDATE public.notifications n SET reminder_role=o.role,email_deferred=true
FROM public.reminder_outbox o WHERE o.notification_id=n.id;
UPDATE public.reminder_runtime SET activated_at=now(),last_tick_at=now(),enabled=true WHERE singleton;
SELECT cron.schedule('reminder-v2','*/3 * * * *','SELECT public._run_reminder_outbox();');
COMMIT;
