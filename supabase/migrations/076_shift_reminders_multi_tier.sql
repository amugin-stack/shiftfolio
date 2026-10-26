-- 076_shift_reminders_multi_tier.sql
--
-- INTENT
--   Shift reminders at 48 hours and 24 hours before a shift, alongside the
--   existing 2-hour one (the support team, 2026-09-08), AND a fix to how the existing
--   reminder counts a "shift".
--
--   Today's job (038) matches ONE STREAM ROW AT A TIME. A booked shift is
--   stored as several rows, one per calendar block, so a 4-block shift already
--   sends FOUR "starting in 2 hours" emails, each naming a different block's
--   start time. Production sample from the prep-time work: 71 stream rows ->
--   18 physical arrivals. Adding two more tiers on top of that would triple an
--   already-wrong number.
--
--   This migration re-bases reminders on the ARRIVAL (a contiguous run of
--   blocks for the same person at the same brand) instead of the block. Net
--   effect once 077 is applied: reminder email volume roughly HALVES even
--   though two new tiers are added.
--
--   Recipients narrow to hosts and moderators. Producers are view-only and see
--   the whole schedule already; reminding them of every shift is noise.
--
-- APPLY ORDERING / DEPLOY DEPENDENCY
--   1. Apply THIS file. It changes no behaviour on its own — it creates a
--      table and a function, and schedules NOTHING. The live 2-hour job keeps
--      running exactly as before.
--   2. Deploy the Edge Function (tier-aware email copy):
--        supabase functions deploy send-notification-email
--      Safe to deploy before 077: the new copy falls back to "starts soon"
--      when no tier is present, so existing rows still render.
--   3. Dry-run against live data, sending zero emails:
--        SELECT * FROM public._emit_shift_reminders('48h', true);
--        SELECT * FROM public._emit_shift_reminders('24h', true);
--        SELECT * FROM public._emit_shift_reminders('2h',  true);
--   4. Only then apply 077, which swaps the cron jobs.
--
-- ROLLBACK
--   Fully reversible while 077 is unapplied — nothing calls the new function:
--     DROP FUNCTION IF EXISTS public._emit_shift_reminders(text, boolean);
--     DROP TABLE IF EXISTS public.shift_reminders;
--
-- TIMEZONE (safe-coding rule 5)
--   streams.start_time is PT wall-clock encoded as naive UTC. "Now" is
--   re-encoded into the same convention with the standard sandwich
--   ((now() AT TIME ZONE 'America/Los_Angeles')::timestamp AT TIME ZONE 'UTC').
--   Lead times are therefore WALL-CLOCK arithmetic: across a DST transition a
--   "24 hours before" reminder lands 23 or 25 real hours ahead. That is what a
--   human means by "the day before", and this is a reminder rather than a pay
--   calculation, so it is accepted deliberately and pinned by a test.
--
-- WHY A NEW TABLE AND NOT A COLUMN ON streams
--   streams.reminder_sent_at is a single timestamp and cannot express
--   "48h sent, 24h pending". More importantly, migration 061 holds an explicit
--   column-level GRANT list for streams: a new column that is not in that list
--   is deny-by-default, and PostgREST then fails the ENTIRE query rather than
--   returning null (see the note at src/lib/supabase/types.ts:465). A separate
--   table avoids that class of outage completely.
--
--   streams.reminder_sent_at is left in place and simply stops being written
--   (additive-first, rule 13). Dropping it is a later, separate migration.

----------------------------------------------------------------------
-- 1. Per-tier dedup ledger.
--
--    stream_id is the FIRST block of the arrival (its anchor). ON DELETE
--    CASCADE is required, not decorative: approving a shift cancellation
--    hard-DELETEs the stream row when no producer is attached
--    (agent2migrations/002:466-473).
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shift_reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id      uuid        NOT NULL REFERENCES public.streams(id) ON DELETE CASCADE,
  recipient_role text        NOT NULL CHECK (recipient_role IN ('host', 'moderator')),
  recipient_ref  uuid        NOT NULL,
  tier           text        NOT NULL CHECK (tier IN ('48h', '24h', '2h')),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, recipient_role, recipient_ref, tier)
);

COMMENT ON TABLE public.shift_reminders IS
  'One row per reminder actually emitted, per arrival per person per tier. stream_id is the arrival''s first block. Written only by _emit_shift_reminders; the UNIQUE constraint is the backstop against a cron overlap double-sending.';

CREATE INDEX IF NOT EXISTS shift_reminders_stream_idx
  ON public.shift_reminders (stream_id);

-- Rule 16: RLS on in the same migration. No policies by design — this table is
-- written by a SECURITY DEFINER function and read by nobody in the app, and it
-- reveals who works when. Same posture as email_events (migration 037).
ALTER TABLE public.shift_reminders ENABLE ROW LEVEL SECURITY;

----------------------------------------------------------------------
-- 2. Seed the 2h tier from the old per-row flag.
--
--    Guards the cutover only. When 077 swaps the jobs, anyone whose shift is
--    already inside the 2-hour band has been reminded by the OLD job but has
--    no row in the NEW ledger, and would be reminded a second time. Streams
--    carrying reminder_sent_at with a start still in the future are, by
--    construction, only those within ~2 hours of now, so this is a handful of
--    rows.
----------------------------------------------------------------------
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

----------------------------------------------------------------------
-- 3. The emitter.
--
--    SECURITY DEFINER because pg_cron and the notifications INSERT path need
--    to write rows no ordinary user could. search_path is pinned per rule 17.
--
--    Migration 059 had to retrofit a REVOKE onto 038's emitter after it
--    shipped world-executable — PostgreSQL grants EXECUTE to PUBLIC by
--    default, and PostgREST exposes it (a leading underscore hides nothing).
--    Anyone with a stream id could then spam real contractor inboxes and
--    permanently silence that shift's reminder. The REVOKE below is part of
--    this migration, not a follow-up.
--
--    Identity is never taken from a caller-supplied argument: the only inputs
--    are a tier name and a dry-run flag.
----------------------------------------------------------------------
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
             (array_agg(g.id ORDER BY g.start_time))[1]   AS anchor_id
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
      INSERT INTO public.notifications
        (recipient_id, type, host_name, brand_name, brand_id,
         shift_start, shift_end, actor_host_id, body, is_read)
      VALUES
        (r.recipient_uid, 'shift_reminder', r.host_name, COALESCE(r.brand_name, '?'),
         r.brand_id, r.session_start, r.session_end, r.anchor_host_id, p_tier, v_read);

      INSERT INTO public.shift_reminders
        (stream_id, recipient_role, recipient_ref, tier)
      VALUES
        (r.anchor_id, r.role, r.ref, p_tier)
      ON CONFLICT DO NOTHING;

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

COMMENT ON FUNCTION public._emit_shift_reminders(text, boolean) IS
  'Emits one shift_reminder notification per ARRIVAL per assigned host/moderator for the given tier (48h/24h/2h). Called by the shift-reminders pg_cron job. Pass p_dry_run => true to see what would be sent without sending anything. Deduped by public.shift_reminders.';

-- Not callable by anyone but the owner. pg_cron runs as postgres and is
-- unaffected; the Supabase SQL editor also runs as postgres, so the dry-run
-- works there. See the note above about migration 059.
REVOKE ALL ON FUNCTION public._emit_shift_reminders(text, boolean)
  FROM PUBLIC, anon, authenticated;
