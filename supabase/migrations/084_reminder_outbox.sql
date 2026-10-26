-- 084: Add revision-aware reminder outbox. Requires 083 delivery-status columns.
-- Preparation only: legacy jobs keep running until 085. Deploy compatible sender
-- before 086 activation. No existing reminder/history rows are rewritten.
-- Rollback: pause reminder-v2 job; retain tables/keys. Never replay legacy jobs.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.notifications
 ADD COLUMN dismissed_at timestamptz,
 ADD COLUMN email_deferred boolean NOT NULL DEFAULT false,
 ADD COLUMN reminder_role text CHECK(reminder_role IN ('host','moderator'));
-- Dismissal hides a notification without deleting delivery/audit history.
GRANT UPDATE(dismissed_at) ON public.notifications TO authenticated;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK(type IN (
 'shift_booked','shift_edited','shift_cancelled','shift_reminder',
 'brand_request','brand_request_approved','brand_request_denied',
 'cancellation_request','cancellation_request_approved','cancellation_request_denied',
 'reminder_delivery_alert'));
-- Existing direct notification inserts still dispatch immediately. Outbox rows
-- are dispatched ONLY by the bounded worker, after the transaction commits.
DROP TRIGGER IF EXISTS notifications_send_email_trigger ON public.notifications;
CREATE TRIGGER notifications_send_email_trigger AFTER INSERT ON public.notifications
 FOR EACH ROW WHEN (NOT NEW.email_deferred) EXECUTE FUNCTION public._fire_send_notification_email();
CREATE SEQUENCE public.reminder_transition_seq;
CREATE TABLE public.reminder_stream_versions (
 stream_id uuid PRIMARY KEY, version bigint NOT NULL DEFAULT nextval('public.reminder_transition_seq'),
 first_seen_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.reminder_stream_versions(stream_id) SELECT id FROM public.streams;
CREATE TABLE public.reminder_runtime (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), activated_at timestamptz,
 last_tick_at timestamptz, next_provider_slot_at timestamptz, enabled boolean NOT NULL DEFAULT false
);
INSERT INTO public.reminder_runtime(singleton) VALUES(true);
CREATE TABLE public.reminder_sessions (
 anchor_id uuid NOT NULL, role text NOT NULL CHECK(role IN('host','moderator')), ref uuid NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('public.reminder_transition_seq'), snapshot jsonb NOT NULL,
 recipient_id uuid, shift_start timestamptz NOT NULL, shift_end timestamptz NOT NULL,
 real_start timestamptz NOT NULL, first_seen_at timestamptz NOT NULL, covered_hours integer NOT NULL DEFAULT 49, correction_pending boolean NOT NULL DEFAULT false,
 PRIMARY KEY(anchor_id,role,ref)
);
CREATE TABLE public.reminder_incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedup_key text NOT NULL UNIQUE,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 admin_email_failure boolean NOT NULL DEFAULT false
);
CREATE TABLE public.reminder_outbox (
 notification_id uuid PRIMARY KEY REFERENCES public.notifications(id),
 anchor_id uuid, role text CHECK(role IN('host','moderator')), ref uuid, revision bigint,
 snapshot jsonb, provider_payload jsonb, recipient_id uuid NOT NULL, real_start timestamptz,
 tier_hours integer, incident_id uuid REFERENCES public.reminder_incidents(id),
 delay_reported boolean NOT NULL DEFAULT false, provider_delay_reported boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','accepted','delivered','failed','superseded','started')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(anchor_id,role,ref,revision,tier_hours)
);
CREATE INDEX reminder_outbox_pending_idx ON public.reminder_outbox(next_attempt_at,attempts,created_at)
 WHERE state='queued';
CREATE INDEX reminder_outbox_unresolved_idx ON public.reminder_outbox(state) WHERE state IN('queued','accepted');
CREATE INDEX reminder_outbox_session_idx ON public.reminder_outbox(anchor_id,role,ref);
CREATE INDEX reminder_outbox_snapshot_idx ON public.reminder_outbox USING gin(snapshot jsonb_path_ops);
ALTER TABLE public.reminder_stream_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_stream_versions,public.reminder_runtime,public.reminder_sessions,
 public.reminder_incidents,public.reminder_outbox FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.reminder_transition_seq FROM PUBLIC,anon,authenticated;
-- A version advances on each meaningful edit, even edit -> revert before cron.
-- Deleted stream versions are kept; no foreign key may erase reminder history.
CREATE FUNCTION public._track_reminder_stream_version() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF TG_OP='INSERT' OR ROW(NEW.brand_id,NEW.host_id,NEW.moderator_id,NEW.start_time,NEW.end_time)
  IS DISTINCT FROM ROW(OLD.brand_id,OLD.host_id,OLD.moderator_id,OLD.start_time,OLD.end_time) THEN
  INSERT INTO public.reminder_stream_versions(stream_id) VALUES(NEW.id)
  ON CONFLICT(stream_id) DO UPDATE SET version=nextval('public.reminder_transition_seq');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reminder_stream_version AFTER INSERT OR UPDATE ON public.streams
 FOR EACH ROW EXECUTE FUNCTION public._track_reminder_stream_version();
-- Stored timestamps remain Pacific wall-clock encoded as UTC. Only reminder
-- deadlines are converted to actual instants. PostgreSQL chooses standard time
-- for ambiguous/nonexistent wall clocks; schedule storage itself is unchanged.
CREATE FUNCTION public._reminder_real_time(p_time timestamptz) RETURNS timestamptz
 LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 SELECT (p_time AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles'
$$;
-- Include started boundary blocks, and all future touching blocks so a session
-- is never truncated by a fixed lookahead. Indexed end_time excludes old history.
CREATE FUNCTION public._current_reminder_sessions() RETURNS TABLE(
 anchor_id uuid,role text,ref uuid,recipient_id uuid,brand_id uuid,brand_name text,
 shift_start timestamptz,shift_end timestamptz,real_start timestamptz,snapshot jsonb,first_seen_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 WITH blocks AS (
 SELECT s.id,s.brand_id,s.start_time,s.end_time,'host'::text role,s.host_id ref,h.user_id recipient_id,
 v.version,v.first_seen_at FROM public.streams s JOIN public.hosts h ON h.id=s.host_id AND h.is_active
 JOIN public.reminder_stream_versions v ON v.stream_id=s.id
 WHERE s.end_time>=((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')-interval '1 day'
 UNION ALL
 SELECT s.id,s.brand_id,s.start_time,s.end_time,'moderator',s.moderator_id,m.user_id,v.version,v.first_seen_at
 FROM public.streams s JOIN public.moderators m ON m.id=s.moderator_id AND m.is_active
 JOIN public.reminder_stream_versions v ON v.stream_id=s.id
 WHERE s.end_time>=((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')-interval '1 day'
 ), marked AS (
 SELECT b.*,CASE WHEN lag(end_time) OVER(PARTITION BY role,ref,brand_id ORDER BY start_time,id)
 IS DISTINCT FROM start_time THEN 1 ELSE 0 END boundary FROM blocks b
 ), grouped AS (
 SELECT m.*,sum(boundary) OVER(PARTITION BY role,ref,brand_id ORDER BY start_time,id) grp FROM marked m
 )
 SELECT (array_agg(g.id ORDER BY g.start_time,g.id))[1],g.role,g.ref,g.recipient_id,g.brand_id,b.name,
 min(g.start_time),max(g.end_time),public._reminder_real_time(min(g.start_time)),
 jsonb_build_object('brand_id',g.brand_id,'recipient_id',g.recipient_id,'blocks',
 jsonb_agg(jsonb_build_array(g.id,extract(epoch FROM g.start_time),extract(epoch FROM g.end_time),g.version)
 ORDER BY g.start_time,g.id)),min(g.first_seen_at)
 FROM grouped g JOIN public.brands b ON b.id=g.brand_id
 GROUP BY g.role,g.ref,g.recipient_id,g.brand_id,b.name,g.grp
 HAVING public._reminder_real_time(min(g.start_time))>now()
$$;
-- New private delivery guard; legacy guard remains intact until cutover.
CREATE FUNCTION public._reminder_outbox_snapshot_matches(p_notification_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.reminder_outbox o JOIN public.notifications n ON n.id=o.notification_id
 WHERE o.notification_id=p_notification_id
 AND o.recipient_id=n.recipient_id AND o.role=n.reminder_role
 AND ((o.role='host' AND EXISTS(SELECT 1 FROM public.hosts h WHERE h.id=o.ref AND h.is_active AND h.user_id=o.recipient_id))
 OR (o.role='moderator' AND EXISTS(SELECT 1 FROM public.moderators m WHERE m.id=o.ref AND m.is_active AND m.user_id=o.recipient_id)))
 AND o.snapshot=jsonb_build_object('brand_id',n.brand_id,'recipient_id',n.recipient_id,'blocks',(
 SELECT jsonb_agg(jsonb_build_array(s.id,extract(epoch FROM s.start_time),extract(epoch FROM s.end_time),v.version)
 ORDER BY s.start_time,s.id) FROM public.streams s JOIN public.reminder_stream_versions v ON v.stream_id=s.id
 WHERE s.brand_id=n.brand_id AND ((o.role='host' AND s.host_id=o.ref) OR(o.role='moderator' AND s.moderator_id=o.ref))
 AND s.start_time<=n.shift_end AND s.end_time>=n.shift_start))
 AND public._reminder_real_time(n.shift_start)=o.real_start)

$$;
CREATE FUNCTION public._reminder_outbox_is_current(p_notification_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.reminder_outbox o WHERE o.notification_id=p_notification_id
 AND o.state='queued' AND o.real_start>now() AND public._reminder_outbox_snapshot_matches(p_notification_id))
$$;
-- Only a worker-issued attempt may use the new deferred transport. A webhook
-- INSERT alone cannot bypass the send budget; retries reuse the same key.
CREATE FUNCTION public._reminder_dispatch_allowed(p_notification_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.reminder_outbox o WHERE o.notification_id=p_notification_id
 AND o.state='queued' AND o.last_attempt_at>now()-interval '2 minutes'
 AND EXISTS(SELECT 1 FROM public.reminder_runtime cfg WHERE cfg.singleton AND cfg.enabled)
 AND (o.incident_id IS NOT NULL OR public._reminder_outbox_is_current(p_notification_id)))
$$;
-- Pace new reminder transport at one request/second rather than releasing a
-- fifty-request HTTP burst at the provider. Slots are private and transactional.
CREATE FUNCTION public._claim_reminder_send_slot(p_notification_id uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE slot timestamptz;
BEGIN
 IF NOT public._reminder_dispatch_allowed(p_notification_id) THEN RETURN NULL; END IF;
 SELECT greatest(coalesce(next_provider_slot_at,now()),now()) INTO slot
 FROM public.reminder_runtime WHERE singleton FOR UPDATE;
 IF slot>now()+interval '55 seconds' THEN RETURN NULL; END IF;
 UPDATE public.reminder_runtime SET next_provider_slot_at=slot+interval '1 second' WHERE singleton;
 RETURN greatest(0,ceil(extract(epoch FROM slot-now())*1000)::integer);
END $$;
-- Freeze exactly the provider request before the first network attempt. A lost
-- response is ambiguous: retries must keep both key AND payload unchanged.
CREATE FUNCTION public._prepare_reminder_email(p_notification_id uuid,p_payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE saved jsonb;
BEGIN
 SELECT provider_payload INTO saved FROM public.reminder_outbox WHERE notification_id=p_notification_id FOR UPDATE;
 IF NOT FOUND OR NOT public._reminder_dispatch_allowed(p_notification_id) THEN RETURN NULL; END IF;
 IF saved IS NULL THEN
  UPDATE public.reminder_outbox SET provider_payload=p_payload WHERE notification_id=p_notification_id;
  saved:=p_payload;
 END IF;
 RETURN saved;
END $$;
CREATE FUNCTION public._record_reminder_incident(p_key text,p_reason text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; a record; v_n uuid;
BEGIN
 INSERT INTO public.reminder_incidents(dedup_key,reason) VALUES(p_key,p_reason)
 ON CONFLICT(dedup_key) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN SELECT id INTO v_id FROM public.reminder_incidents WHERE dedup_key=p_key; RETURN v_id; END IF;
 FOR a IN SELECT id FROM public.profiles WHERE role='admin' LOOP
  INSERT INTO public.notifications(recipient_id,type,host_name,brand_name,body,is_read,email_deferred)
  VALUES(a.id,'reminder_delivery_alert','Studio','Studio',p_reason||' Incident: '||v_id,false,true) RETURNING id INTO v_n;
  INSERT INTO public.reminder_outbox(notification_id,recipient_id,incident_id)
  VALUES(v_n,a.id,v_id);
 END LOOP;
 RETURN v_id;
END $$;
CREATE FUNCTION public._queue_reminder_v2(p_s public.reminder_sessions,p_brand_id uuid,p_brand_name text,p_hours integer,p_body text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_n uuid;
BEGIN
 INSERT INTO public.notifications(recipient_id,type,host_name,brand_id,brand_name,shift_start,shift_end,body,
 is_read,email_deferred,reminder_role)
 VALUES(p_s.recipient_id,'shift_reminder',coalesce(CASE WHEN p_s.role='host'
  THEN (SELECT name FROM public.hosts WHERE id=p_s.ref)
  ELSE (SELECT name FROM public.moderators WHERE id=p_s.ref) END,'Assigned worker'),
 p_brand_id,p_brand_name,p_s.shift_start,p_s.shift_end,p_body,
 p_hours<>2,true,p_s.role) RETURNING id INTO v_n;
 INSERT INTO public.reminder_outbox(notification_id,anchor_id,role,ref,revision,snapshot,recipient_id,real_start,tier_hours)
 VALUES(v_n,p_s.anchor_id,p_s.role,p_s.ref,p_s.revision,p_s.snapshot,p_s.recipient_id,p_s.real_start,p_hours);
 RETURN v_n;
END $$;
-- One advisory transaction lock serializes enqueue/claims across overlapping cron
-- invocations. It never holds a transaction open across network delivery.
CREATE FUNCTION public._run_reminder_outbox() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg public.reminder_runtime; r record; st public.reminder_sessions; o record;
 v_hours integer; v_n uuid; v_count integer:=0; v_queued integer:=0; v_secret text;
 v_previous boolean; v_late boolean;
BEGIN
 IF NOT pg_try_advisory_xact_lock(847203,1) THEN RETURN 0; END IF;
 SELECT * INTO cfg FROM public.reminder_runtime WHERE singleton FOR UPDATE;
 IF NOT cfg.enabled OR cfg.activated_at IS NULL THEN RETURN 0; END IF;
 IF cfg.last_tick_at<now()-interval '10 minutes' THEN
  PERFORM public._record_reminder_incident('outage:'||extract(epoch FROM cfg.last_tick_at)::text,
   'The reminder scheduler recovered after a delay. Upcoming reminders are being retried with current shift details.');
 END IF;
 UPDATE public.reminder_runtime SET last_tick_at=now() WHERE singleton;
 -- Update transitions before making any current-version enqueue decision.
 FOR r IN SELECT * FROM public._current_reminder_sessions() LOOP
  SELECT * INTO st FROM public.reminder_sessions WHERE anchor_id=r.anchor_id AND role=r.role AND ref=r.ref;
  IF NOT FOUND OR st.snapshot IS DISTINCT FROM r.snapshot THEN
   SELECT EXISTS(SELECT 1 FROM public.reminder_outbox prior
    WHERE prior.role=r.role AND prior.incident_id IS NULL
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(prior.snapshot->'blocks') a,
      jsonb_array_elements(r.snapshot->'blocks') b WHERE a->>0=b->>0)) INTO v_previous;
   INSERT INTO public.reminder_sessions(anchor_id,role,ref,snapshot,recipient_id,shift_start,shift_end,real_start,first_seen_at,correction_pending)
   VALUES(r.anchor_id,r.role,r.ref,r.snapshot,r.recipient_id,r.shift_start,r.shift_end,r.real_start,r.first_seen_at,v_previous)
   ON CONFLICT(anchor_id,role,ref) DO UPDATE SET revision=nextval('public.reminder_transition_seq'),
    snapshot=excluded.snapshot,recipient_id=excluded.recipient_id,shift_start=excluded.shift_start,
    shift_end=excluded.shift_end,real_start=excluded.real_start,covered_hours=49,
    correction_pending=excluded.correction_pending;
  END IF;
 END LOOP;
 -- A provider event can arrive before Edge persists its message id. Reconcile
 -- durable callbacks on the next tick rather than losing delivery evidence.
 UPDATE public.notifications n SET email_delivered_at=e.created_at
 FROM (SELECT message_id,min(created_at) created_at FROM public.email_events
 WHERE event_type='delivered' GROUP BY message_id) e
 WHERE n.email_message_id=e.message_id AND n.email_delivered_at IS NULL
 AND EXISTS(SELECT 1 FROM public.reminder_outbox q WHERE q.notification_id=n.id AND q.state IN('queued','accepted'));
 UPDATE public.notifications n SET email_delivery_failed_at=e.created_at
 FROM (SELECT message_id,min(created_at) created_at FROM public.email_events
 WHERE event_type IN('bounced','complained','failed') GROUP BY message_id) e
 WHERE n.email_message_id=e.message_id AND n.email_delivery_failed_at IS NULL
 AND EXISTS(SELECT 1 FROM public.reminder_outbox q WHERE q.notification_id=n.id AND q.state IN('queued','accepted'));
 -- Drain states from durable notification outcomes. Never infer delivered from
 -- provider acceptance. An alert's own failure updates its incident, no recursion.
 FOR o IN SELECT q.*,n.brand_name,n.shift_start,n.email_sent_at,n.email_delivered_at,n.email_delivery_failed_at,n.email_skipped_reason
  FROM public.reminder_outbox q JOIN public.notifications n ON n.id=q.notification_id
  WHERE q.state IN('queued','accepted') OR (q.state='delivered' AND n.email_delivery_failed_at IS NOT NULL)
 LOOP
  IF o.state='queued' AND o.incident_id IS NULL AND o.email_sent_at IS NULL
   AND o.email_delivered_at IS NULL AND NOT public._reminder_outbox_snapshot_matches(o.notification_id) THEN
   UPDATE public.reminder_outbox SET state='superseded' WHERE notification_id=o.notification_id;
   UPDATE public.notifications SET email_skipped_reason='stale_reminder' WHERE id=o.notification_id AND email_sent_at IS NULL;
  ELSIF o.email_delivery_failed_at IS NOT NULL OR (o.email_skipped_reason IS NOT NULL AND o.email_skipped_reason<>'stale_reminder') THEN
   UPDATE public.reminder_outbox SET state='failed' WHERE notification_id=o.notification_id;
   IF o.incident_id IS NOT NULL THEN
    UPDATE public.reminder_incidents SET admin_email_failure=true WHERE id=o.incident_id;
   ELSE
    PERFORM public._record_reminder_incident('delivery:'||o.notification_id,
     format('A %s reminder for %s on %s PT could not be delivered. Please check the assigned worker’s contact details.',o.role,o.brand_name,to_char(o.shift_start AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')));
   END IF;
  ELSIF o.email_delivered_at IS NOT NULL THEN
   UPDATE public.reminder_outbox SET state='delivered' WHERE notification_id=o.notification_id;
  ELSIF o.email_sent_at IS NOT NULL AND o.state<>'accepted' THEN
   UPDATE public.reminder_outbox SET state='accepted' WHERE notification_id=o.notification_id;
  ELSIF o.email_skipped_reason='stale_reminder' THEN
   UPDATE public.reminder_outbox SET state='superseded' WHERE notification_id=o.notification_id;
  ELSIF o.state='queued' AND o.real_start<=now() THEN
   UPDATE public.reminder_outbox SET state='started' WHERE notification_id=o.notification_id;
   PERFORM public._record_reminder_incident('delivery:'||o.notification_id,
    format('The %s shift for %s on %s PT started before its reminder could be delivered.',o.role,o.brand_name,to_char(o.shift_start AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')));
  ELSIF o.state='queued' AND o.attempts>=10 AND o.next_attempt_at<=now() THEN
   UPDATE public.reminder_outbox SET state='failed' WHERE notification_id=o.notification_id;
   IF o.incident_id IS NOT NULL THEN
    UPDATE public.reminder_incidents SET admin_email_failure=true WHERE id=o.incident_id;
   ELSE
    PERFORM public._record_reminder_incident('delivery:'||o.notification_id,
     format('The %s reminder for %s on %s PT exhausted its delivery attempts. Please contact the assigned worker.',o.role,o.brand_name,to_char(o.shift_start AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')));
   END IF;
  END IF;
 END LOOP;
 -- Delivery delay also occurs while cron stays healthy (provider/lookup outage).
 -- Notify admins once per obligation. Before any provider attempt, upgrade copy;
 -- after an ambiguous attempt preserve its frozen exact-time payload/key.
 FOR o IN SELECT q.*,n.email_sent_at FROM public.reminder_outbox q
 JOIN public.notifications n ON n.id=q.notification_id
 WHERE q.incident_id IS NULL AND NOT q.delay_reported AND q.state IN('queued','accepted','delivered')
 AND coalesce(n.email_sent_at,now()) > CASE WHEN q.tier_hours>0
   THEN q.real_start-make_interval(hours=>q.tier_hours) ELSE q.created_at END + interval '7 minutes 30 seconds'
 AND (q.state<>'queued' OR (q.real_start>now() AND public._reminder_outbox_snapshot_matches(q.notification_id)))
 LOOP
  PERFORM public._record_reminder_incident('transport-late-batch:'||floor(extract(epoch FROM o.created_at)/3600)::text,
   'A shift reminder was delayed during delivery. Its email shows the scheduled date and time; please review the worker’s shift if needed.');
  UPDATE public.reminder_outbox SET delay_reported=true WHERE notification_id=o.notification_id;
  IF o.state='queued' AND o.provider_payload IS NULL THEN
   UPDATE public.notifications SET body='late' WHERE id=o.notification_id AND body<>'corrected';
  END IF;
 END LOOP;
 -- Provider delivery_delayed events are a distinct incident, even after request
 -- acceptance; these events do not mean the message was delivered.
 FOR o IN SELECT DISTINCT q.notification_id FROM public.reminder_outbox q
 JOIN public.notifications n ON n.id=q.notification_id JOIN public.email_events e ON e.message_id=n.email_message_id
 WHERE q.incident_id IS NULL AND NOT q.provider_delay_reported AND e.event_type='delivery_delayed'
 LOOP
  PERFORM public._record_reminder_incident('provider-delay:'||o.notification_id,
   'The email provider reported a delayed shift reminder. Acceptance does not confirm inbox delivery.');
  UPDATE public.reminder_outbox SET provider_delay_reported=true WHERE notification_id=o.notification_id;
 END LOOP;
 -- Enqueue at most fifty obligations. A nearer due tier covers older missed
 -- tiers. New bookings do not inherit pre-booking obligations. Corrections may
 -- be outside 48h; only previously reminded work can request one.
 FOR r IN SELECT s.*,c.brand_id,c.brand_name FROM public.reminder_sessions s
  JOIN public._current_reminder_sessions() c ON c.anchor_id=s.anchor_id AND c.role=s.role AND c.ref=s.ref
  WHERE s.snapshot=c.snapshot AND (s.correction_pending OR s.real_start<=now()+interval '48 hours')
  ORDER BY s.correction_pending DESC,s.real_start,s.anchor_id,s.role,s.ref
 LOOP
  EXIT WHEN v_queued>=50;
  IF r.recipient_id IS NULL THEN
   PERFORM public._record_reminder_incident('account:'||r.anchor_id||':'||r.role||':'||r.ref,
    format('The %s shift for %s on %s PT has no linked worker account, so its reminder cannot be delivered.',r.role,r.brand_name,to_char(r.shift_start AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')));
   CONTINUE;
  END IF;
  SELECT min(h) INTO v_hours FROM unnest(ARRAY[48,24,2]) h
   WHERE h<r.covered_hours AND r.real_start-make_interval(hours=>h)<=now()
   AND r.real_start-make_interval(hours=>h)>=greatest(cfg.activated_at,r.first_seen_at);
  IF r.correction_pending THEN
   SELECT * INTO st FROM public.reminder_sessions WHERE anchor_id=r.anchor_id AND role=r.role AND ref=r.ref;
   v_n:=public._queue_reminder_v2(st,r.brand_id,r.brand_name,0,'corrected');
   UPDATE public.reminder_sessions SET correction_pending=false,covered_hours=coalesce(v_hours,49)
    WHERE anchor_id=r.anchor_id AND role=r.role AND ref=r.ref;
   v_queued:=v_queued+1;
  ELSIF v_hours IS NOT NULL THEN
   v_late:=now()-(r.real_start-make_interval(hours=>v_hours))>interval '7 minutes 30 seconds';
   SELECT * INTO st FROM public.reminder_sessions WHERE anchor_id=r.anchor_id AND role=r.role AND ref=r.ref;
   v_n:=public._queue_reminder_v2(st,r.brand_id,r.brand_name,v_hours,CASE WHEN v_late THEN 'late' ELSE v_hours||'h' END);
   -- If an earlier tier was queued before an outage, the nearer current tier
   -- replaces it. Never deliver both recovery emails for the same arrival.
   UPDATE public.reminder_outbox SET state='superseded'
    WHERE anchor_id=r.anchor_id AND role=r.role AND ref=r.ref AND revision=r.revision
    AND state='queued' AND notification_id<>v_n AND tier_hours>v_hours;
   UPDATE public.reminder_sessions SET covered_hours=v_hours WHERE anchor_id=r.anchor_id AND role=r.role AND ref=r.ref;
   IF v_late THEN PERFORM public._record_reminder_incident('late-batch:'||floor(extract(epoch FROM now())/3600)::text,
    'A shift reminder was delayed. It is being sent with the current shift time.'); END IF;
   v_queued:=v_queued+1;
  END IF;
 END LOOP;
 SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='email_webhook_secret';
 IF v_secret IS NULL OR v_secret='' THEN
  PERFORM public._record_reminder_incident('configuration:email-secret','Reminder email delivery is not configured. In-app alerts remain available.');
  RETURN 0;
 END IF;
 -- First attempts precede retries, preventing a burst of failures from starving
 -- untouched work. Three-minute cron; backoff 3,6,12,24, then capped at30min.
 FOR o IN SELECT q.* FROM public.reminder_outbox q
  WHERE q.state='queued' AND q.next_attempt_at<=now() AND q.attempts<10
  ORDER BY q.attempts,q.next_attempt_at,q.created_at,q.notification_id LIMIT 50 FOR UPDATE SKIP LOCKED
 LOOP
  IF o.incident_id IS NULL AND NOT public._reminder_outbox_is_current(o.notification_id) THEN
   UPDATE public.reminder_outbox SET state='superseded' WHERE notification_id=o.notification_id;
   UPDATE public.notifications SET email_skipped_reason='stale_reminder'
    WHERE id=o.notification_id AND email_sent_at IS NULL;
   CONTINUE;
  END IF;
  UPDATE public.reminder_outbox SET attempts=attempts+1,last_attempt_at=now(),
   next_attempt_at=now()+make_interval(mins=>least(30,(3*power(2,least(attempts,4)))::integer))
   WHERE notification_id=o.notification_id;
  PERFORM net.http_post(url:='https://demo-project.supabase.invalid/functions/v1/send-notification-email',
   body:=jsonb_build_object('type','INSERT','table','notifications','schema','public','record',jsonb_build_object('id',o.notification_id)),
   headers:=jsonb_build_object('Content-Type','application/json','X-Webhook-Secret',v_secret),timeout_milliseconds:=130000);
  v_count:=v_count+1;
 END LOOP;
 RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public._track_reminder_stream_version(),public._reminder_real_time(timestamptz),
 public._current_reminder_sessions(),public._reminder_outbox_snapshot_matches(uuid),public._reminder_outbox_is_current(uuid),public._reminder_dispatch_allowed(uuid),
 public._prepare_reminder_email(uuid,jsonb),public._claim_reminder_send_slot(uuid),public._record_reminder_incident(text,text),public._queue_reminder_v2(public.reminder_sessions,uuid,text,integer,text),
 public._run_reminder_outbox() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._reminder_outbox_is_current(uuid),public._reminder_dispatch_allowed(uuid),public._claim_reminder_send_slot(uuid),public._prepare_reminder_email(uuid,jsonb) TO service_role;
COMMIT;
