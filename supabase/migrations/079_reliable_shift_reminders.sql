-- 079: Reliable reminder enqueue and bounded transport retries. 078 is reserved
-- for the separate staff-unavailability release; it is NOT a prerequisite.
-- Requires 076 and the existing notification email trigger/Edge function.
-- This preparation migration schedules nothing and sends no emails.
-- Rollback: stop shift-reminders and shift-reminder-email-retries jobs; keep
-- ledger/history. Do not restore the old cron without refreshing its dedup state.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.shift_reminders
  ADD COLUMN IF NOT EXISTS notification_id uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS email_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid,
  ADD COLUMN IF NOT EXISTS session_snapshot jsonb;
CREATE INDEX IF NOT EXISTS shift_reminders_pending_retry_idx
  ON public.shift_reminders(sent_at, last_email_attempt_at)
  WHERE notification_id IS NOT NULL AND email_attempts < 5;
CREATE INDEX IF NOT EXISTS shift_reminders_notification_idx
  ON public.shift_reminders(notification_id) WHERE notification_id IS NOT NULL;
REVOKE ALL ON public.shift_reminders FROM PUBLIC, anon, authenticated;
-- Existing live 077 revoke had not been applied. Close the old RPC now.
REVOKE ALL ON FUNCTION public._emit_shift_reminder_notifications(uuid) FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public._emit_shift_reminders(
  p_tier    text,
  p_dry_run boolean DEFAULT false
)
RETURNS TABLE (
  action           text,
  tier             text,
  recipient_role   text,
  recipient_ref    uuid,
  recipient_name   text,
  brand_name       text,
  session_start    timestamptz,
  session_end      timestamptz,
  block_count      bigint,
  anchor_stream_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now   timestamptz;
  v_lead  interval;
  v_lo    timestamptz;
  v_hi    timestamptz;
  v_read  boolean;
  r       record;
  v_claim uuid;
  v_notification uuid;
BEGIN
  v_lead := CASE p_tier
              WHEN '48h' THEN interval '48 hours'
              WHEN '24h' THEN interval '24 hours'
              WHEN '2h'  THEN interval '2 hours'
            END;
  IF v_lead IS NULL THEN
    RAISE EXCEPTION 'unknown reminder tier: %', p_tier;
  END IF;

  -- "Now", re-encoded into the PT-naive convention the stream columns use.
  v_now := ((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC');

  -- A BAND, not a cutoff. This is what stops a shift booked 30 hours out from
  -- ever receiving a "48 hours from now" email: by the time cron runs it is
  -- simply not in the 48h band, and it never will be. The band is wider than
  -- the cron tick (15 min vs 10 min) so nothing can fall between ticks; the
  -- resulting overlap is absorbed by the dedup ledger.
  v_lo := v_now + v_lead - interval '7 minutes 30 seconds';
  v_hi := v_now + v_lead + interval '7 minutes 30 seconds';

  -- The 48h and 24h tiers are email-only: they land pre-read so they do not
  -- stack three unread badges per shift in the notification bell. The 2h tier
  -- keeps the behaviour people are already used to.
  v_read := (p_tier <> '2h');

  FOR r IN
    WITH role_blocks AS (
      -- One row per (block, assigned person). A block with both a host and a
      -- moderator yields two rows, which is what makes the islands below
      -- per-person rather than per-stream.
      --
      -- The lower bound deliberately reaches BACK past "now" so contiguity is
      -- visible: without it, a block sitting mid-arrival would look like the
      -- start of one. Sessions that have already begun are filtered out later.
      SELECT s.id, s.brand_id, s.start_time, s.end_time,
             'host'::text AS role, s.host_id AS ref
        FROM public.streams s
        JOIN public.hosts h ON h.id = s.host_id
       WHERE s.host_id IS NOT NULL
         AND h.is_active
         AND s.start_time BETWEEN v_now - interval '1 day' AND v_now + interval '4 days'
      UNION ALL
      SELECT s.id, s.brand_id, s.start_time, s.end_time,
             'moderator'::text, s.moderator_id
        FROM public.streams s
        JOIN public.moderators m ON m.id = s.moderator_id
       WHERE s.moderator_id IS NOT NULL
         AND m.is_active
         AND s.start_time BETWEEN v_now - interval '1 day' AND v_now + interval '4 days'
    ),
    marked AS (
      -- Gaps-and-islands. An arrival breaks where a block does not begin
      -- exactly when the previous one ended. Mirrors buildSessionsByHost in
      -- src/lib/gmv.ts, which likewise partitions by PERSON before grouping —
      -- partitioning by brand alone would merge two people's back-to-back
      -- blocks into one arrival. Rule 19: these two are mirrors; changing the
      -- session rule means changing both.
      SELECT b.*,
             CASE
               WHEN lag(b.end_time) OVER w IS DISTINCT FROM b.start_time THEN 1
               ELSE 0
             END AS is_session_start
        FROM role_blocks b
      WINDOW w AS (PARTITION BY b.role, b.ref, b.brand_id ORDER BY b.start_time)
    ),
    grouped AS (
      SELECT m.*,
             sum(m.is_session_start) OVER (
               PARTITION BY m.role, m.ref, m.brand_id
               ORDER BY m.start_time
               ROWS UNBOUNDED PRECEDING
             ) AS session_no
        FROM marked m
    ),
    sessions AS (
      SELECT g.role,
             g.ref,
             g.brand_id,
             min(g.start_time)                            AS session_start,
             max(g.end_time)                              AS session_end,
             count(*)                                     AS block_count,
             (array_agg(g.id ORDER BY g.start_time, g.id))[1] AS anchor_id,
             jsonb_build_object(
               'brand_id', g.brand_id,
               'start', extract(epoch FROM min(g.start_time)),
               'end', extract(epoch FROM max(g.end_time)),
               'blocks', jsonb_agg(jsonb_build_array(g.id,
                 extract(epoch FROM g.start_time), extract(epoch FROM g.end_time))
                 ORDER BY g.start_time, g.id)
             ) AS snapshot
        FROM grouped g
       GROUP BY g.role, g.ref, g.brand_id, g.session_no
    )
    SELECT se.role,
           se.ref,
           se.brand_id,
           se.session_start,
           se.session_end,
           se.block_count,
           se.anchor_id,
           se.snapshot,
           br.name                                        AS brand_name,
           COALESCE(anchor_host.name, 'TBD')              AS host_name,
           anchor.host_id                                 AS anchor_host_id,
           CASE se.role WHEN 'host' THEN h.name ELSE md.name END      AS recipient_name,
           CASE se.role WHEN 'host' THEN h.user_id ELSE md.user_id END AS recipient_uid
      FROM sessions se
      JOIN public.streams anchor      ON anchor.id = se.anchor_id
      LEFT JOIN public.brands br      ON br.id = se.brand_id
      LEFT JOIN public.hosts anchor_host ON anchor_host.id = anchor.host_id
      LEFT JOIN public.hosts h        ON se.role = 'host'      AND h.id  = se.ref
      LEFT JOIN public.moderators md  ON se.role = 'moderator' AND md.id = se.ref
     WHERE se.session_start BETWEEN v_lo AND v_hi
       AND se.session_start > v_now          -- never remind about work already under way
       AND NOT EXISTS (
             SELECT 1 FROM public.shift_reminders sr
              WHERE sr.stream_id      = se.anchor_id
                AND sr.recipient_role = se.role
                AND sr.recipient_ref  = se.ref
                AND sr.tier           = p_tier
           )
  LOOP
    IF r.recipient_uid IS NULL THEN
      -- No linked account, so there is nowhere to deliver: notifications.
      -- recipient_id is NOT NULL REFERENCES profiles(id). Reported rather
      -- than silently dropped, because this is invisible in production today
      -- and is the whole reason a second PR exists.
      action := 'skipped_no_account';
    ELSIF p_dry_run THEN
      action := 'would_emit';
    ELSE
      -- Claim BEFORE creating the notification. A concurrent loser must not
      -- enqueue a second email; any later error rolls back both writes.
      INSERT INTO public.shift_reminders
        (stream_id, recipient_role, recipient_ref, tier, email_attempts, last_email_attempt_at,
         recipient_user_id, session_snapshot)
      VALUES (r.anchor_id, r.role, r.ref, p_tier, 1, now(), r.recipient_uid, r.snapshot)
      ON CONFLICT DO NOTHING RETURNING id INTO v_claim;
      IF v_claim IS NULL THEN CONTINUE; END IF;
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id,
         shift_start, shift_end, actor_host_id, body, is_read)
      VALUES
        (r.recipient_uid, 'shift_reminder', r.host_name, COALESCE(r.brand_name, '?'),
         r.brand_id, r.session_start, r.session_end, r.anchor_host_id, p_tier, v_read)
      RETURNING id INTO v_notification;

      UPDATE public.shift_reminders SET notification_id = v_notification WHERE id = v_claim;

      action := 'emitted';
    END IF;

    tier             := p_tier;
    recipient_role   := r.role;
    recipient_ref    := r.ref;
    recipient_name   := r.recipient_name;
    brand_name       := r.brand_name;
    session_start    := r.session_start;
    session_end      := r.session_end;
    block_count      := r.block_count;
    anchor_stream_id := r.anchor_id;
    RETURN NEXT;
  END LOOP;
END;
$$;


-- Check the whole original arrival, not only its anchor. Epoch values make
-- snapshots independent of the SQL session timezone. Only the original time
-- window plus touching neighbours is queried: changed/deleted/reassigned blocks
-- or a newly joined adjacent block invalidate the snapshot. Legacy rows without
-- snapshots deliberately fail closed. This is also callable by the trusted Edge
-- sender immediately before delivery; never by browser clients.
CREATE OR REPLACE FUNCTION public._shift_reminder_is_current(p_notification_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shift_reminders sr
    JOIN public.notifications n ON n.id=sr.notification_id
    WHERE n.id=p_notification_id AND sr.session_snapshot IS NOT NULL
      AND n.type='shift_reminder' AND n.body=sr.tier
      AND n.recipient_id=sr.recipient_user_id
      AND n.brand_id::text=sr.session_snapshot->>'brand_id'
      AND extract(epoch FROM n.shift_start)=(sr.session_snapshot->>'start')::numeric
      AND extract(epoch FROM n.shift_end)=(sr.session_snapshot->>'end')::numeric
      AND n.shift_start > ((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
      AND (
        (sr.recipient_role='host' AND EXISTS(SELECT 1 FROM public.hosts h
          WHERE h.id=sr.recipient_ref AND h.is_active AND h.user_id=sr.recipient_user_id))
        OR (sr.recipient_role='moderator' AND EXISTS(SELECT 1 FROM public.moderators m
          WHERE m.id=sr.recipient_ref AND m.is_active AND m.user_id=sr.recipient_user_id))
      )
      AND sr.session_snapshot->'blocks' = (
        SELECT jsonb_agg(jsonb_build_array(s.id,
          extract(epoch FROM s.start_time), extract(epoch FROM s.end_time))
          ORDER BY s.start_time,s.id)
        FROM public.streams s
        WHERE s.brand_id=n.brand_id
          AND ((sr.recipient_role='host' AND s.host_id=sr.recipient_ref)
            OR (sr.recipient_role='moderator' AND s.moderator_id=sr.recipient_ref))
          AND s.start_time<=n.shift_end AND s.end_time>=n.shift_start
      )
  );
$$;
REVOKE ALL ON FUNCTION public._shift_reminder_is_current(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._shift_reminder_is_current(uuid) TO service_role;

-- Retries ONLY newly queued tier-aware reminders, using the SAME notification
-- ID (and therefore the existing Resend idempotency key). No old backlog is sent.
-- At most 50 per tick, five total attempts, three minutes apart, within 30 minutes.
-- A non-2xx pg_net response is not retried automatically by pg_net itself.
CREATE OR REPLACE FUNCTION public._retry_shift_reminder_emails() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_secret text; v_count integer := 0;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='email_webhook_secret';
  IF v_secret IS NULL OR v_secret='' THEN RAISE EXCEPTION 'Email webhook secret is not configured'; END IF;
  FOR r IN
    SELECT sr.id AS reminder_id,n.id AS notification_id
    FROM public.shift_reminders sr JOIN public.notifications n ON n.id=sr.notification_id
    WHERE sr.email_attempts < 5 AND sr.sent_at > now()-interval '30 minutes'
      AND sr.last_email_attempt_at <= now()-interval '3 minutes'
      AND n.email_sent_at IS NULL AND n.email_skipped_reason IS NULL
      AND n.type='shift_reminder' AND n.body IN ('48h','24h','2h')
      AND n.shift_start > ((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC')
    ORDER BY sr.email_attempts,sr.last_email_attempt_at,sr.sent_at,sr.id LIMIT 50 FOR UPDATE OF sr SKIP LOCKED
  LOOP
    IF NOT public._shift_reminder_is_current(r.notification_id) THEN
      UPDATE public.notifications SET email_skipped_reason='stale_reminder'
        WHERE id=r.notification_id AND email_sent_at IS NULL AND email_skipped_reason IS NULL;
      CONTINUE;
    END IF;
    PERFORM net.http_post(
      url := 'https://demo-project.supabase.invalid/functions/v1/send-notification-email',
      body := jsonb_build_object('type','INSERT','table','notifications','schema','public','record',jsonb_build_object('id',r.notification_id)),
      headers := jsonb_build_object('Content-Type','application/json','X-Webhook-Secret',v_secret),
      timeout_milliseconds := 5000);
    UPDATE public.shift_reminders SET email_attempts=email_attempts+1,last_email_attempt_at=now() WHERE id=r.reminder_id;
    v_count := v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public._emit_shift_reminders(text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public._retry_shift_reminder_emails() FROM PUBLIC,anon,authenticated;
COMMIT;
