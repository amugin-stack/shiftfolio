-- Stop administrator reminder-delivery alert fan-out. Unlinked assignments are
-- normal and ignored. Keep real delivery diagnostics private, without notifying
-- administrators. Assigned-worker reminders and their retries remain enabled.
-- Apply after 086/087. Retain history; do not replay canceled alerts on rollback.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(847203,1);

CREATE OR REPLACE FUNCTION public._record_reminder_incident(p_key text,p_reason text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
 IF split_part(p_key,':',1)='account' THEN RETURN NULL; END IF;
 INSERT INTO public.reminder_incidents(dedup_key,reason) VALUES(p_key,p_reason)
 ON CONFLICT(dedup_key) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN
  SELECT id INTO v_id FROM public.reminder_incidents WHERE dedup_key=p_key;
 END IF;
 RETURN v_id;
END $$;

-- Queued HTTP/Edge attempts recheck this guard after pacing and before sending.
-- This also prevents any future accidental administrator outbox insertion from
-- restarting these emails. Preserve the normal worker dispatch checks.
CREATE OR REPLACE FUNCTION public._reminder_dispatch_allowed(p_notification_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.reminder_outbox o
 JOIN public.notifications n ON n.id=o.notification_id
 WHERE o.notification_id=p_notification_id
 AND o.incident_id IS NULL AND n.type='shift_reminder'
 AND o.state='queued' AND o.last_attempt_at>now()-interval '2 minutes'
 AND EXISTS(SELECT 1 FROM public.reminder_runtime cfg WHERE cfg.singleton AND cfg.enabled)
 AND public._reminder_outbox_is_current(p_notification_id))
$$;

-- Cancel only unsent administrator alerts. Keep delivered/accepted history.
UPDATE public.reminder_outbox o SET state='superseded'
FROM public.notifications n
WHERE o.notification_id=n.id AND o.incident_id IS NOT NULL
 AND o.state='queued' AND n.email_sent_at IS NULL
 AND n.email_delivered_at IS NULL;

-- Clear the same noisy alert copies from the bell, using reversible soft dismissal.
UPDATE public.notifications SET dismissed_at=now()
WHERE type='reminder_delivery_alert' AND dismissed_at IS NULL;

REVOKE ALL ON FUNCTION public._record_reminder_incident(text,text),
 public._reminder_dispatch_allowed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._reminder_dispatch_allowed(uuid) TO service_role;
COMMIT;
