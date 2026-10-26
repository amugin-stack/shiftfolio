-- 074_gmv_moderators.sql
--
-- INTENT (the support team, 2026-09-03): "add moderators the permission to add gmv --
-- right now it's only hosts who have access to input data."
--
-- One clarification, because it changes what this migration is: the admin
-- Performance tab is read-only, for everybody. Nobody types GMV there. GMV is
-- entered by the worker on their own My Shifts page, and only hosts get that
-- section. So this makes MODERATORS able to report GMV for sessions they
-- moderated. The Performance tab itself is untouched.
--
-- DECISION (Alex, 2026-09-03): a session has ONE SHARED GMV number. Either the
-- host or the moderator may enter or correct it and they see the same figure.
-- Not two numbers, not a per-role column.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT JUST "ALSO ALLOW MODERATORS"
-- ---------------------------------------------------------------------------
--
-- GMV lives on ONE row per session -- the session's ANCHOR, the earliest stream
-- in a contiguous same-brand run. The reader (src/lib/gmv.ts buildSessions)
-- groups by BRAND AND TIME CONTIGUITY ONLY; it has no host or moderator field
-- at all. Host separation exists purely because every caller pre-filters to one
-- host's rows before calling it.
--
-- And set_session_gmv has never checked that the row it writes to IS the
-- anchor. The client computes an anchor and passes it; that is a convention,
-- not an enforced invariant.
--
-- A moderator's contiguous run does not have to match the host's, so simply
-- widening the permission produces two silent money-reporting bugs:
--
--   SILENTLY DISCARDED. Host works 9-12 (three rows), moderator covers 10-12.
--   The moderator's own run starts at 10, so their anchor is the 10-11 row
--   while the host's is the 9-10 row. buildSessions takes the ANCHOR's value,
--   so the moderator's number is thrown away with no error anywhere.
--
--   COUNTED TWICE. Brand X, 9-12 hosted by A, 12-14 hosted by B, moderator M
--   spanning both. M's entry lands in B's partition as its own session. The
--   per-host rows still look right, but the org-wide week/month tiles on the
--   Performance tab sum every host's sessions, so the same real revenue is
--   counted twice.
--
-- The fix is to stop trusting the caller's idea of the anchor and RESOLVE IT
-- SERVER-SIDE, so a host and a moderator writing "their" session always land on
-- the same row. That also closes the pre-existing hole where a host could write
-- GMV to a non-anchor row and have it silently ignored.
--
-- ---------------------------------------------------------------------------
-- APPLY ORDER: after 062 (which added the is_active guard this preserves) and
-- after 073. Apply BEFORE deploying the code -- the app calls
-- get_my_session_gmv(), which does not exist until this runs.
--
-- Paste the WHOLE FILE and Run once.
--
-- NO EXISTING GMV VALUE IS READ, MOVED OR CHANGED by this migration. It adds
-- two nullable columns and redefines functions. Tie-out below.
--
-- ROLLBACK: re-apply 062 verbatim, then
--   DROP FUNCTION IF EXISTS public.get_my_session_gmv();
--   DROP FUNCTION IF EXISTS public.gmv_session_anchor(UUID);
-- The audit columns can stay -- they are additive and nothing breaks if they
-- linger. Dropping them destroys the only record of who set a figure.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Pre-flight -- migrations here are applied by hand, so the files cannot tell
-- us what is actually live. Same guard pattern as 063 and 073.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_session_gmv';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      '074 ABORT: set_session_gmv() does not exist. Apply agent2migrations/007 then 062 first.';
  END IF;

  IF v_src NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION
      '074 ABORT: the live set_session_gmv has no is_active guard, so 062 was not applied here. Apply 062 first -- this migration preserves that guard and must not be the thing that introduces it.';
  END IF;

  -- Migration 072 removed a duplicate zero-argument get_my_stream_pay that made
  -- every no-argument call ambiguous and locked every host out of /my-shifts.
  -- Nothing here touches that function, but if the duplicate is still present
  -- this database is not in the state we think it is, and shipping GMV changes
  -- onto it would just add a second confusing failure on the same page.
  IF (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_my_stream_pay'
  ) <> 1 THEN
    RAISE EXCEPTION
      '074 ABORT: expected exactly ONE get_my_stream_pay. Apply migration 072 first.';
  END IF;

  RAISE NOTICE '074 pre-flight OK: 062 and 072 are live. Proceeding.';
END $$;

-- ---------------------------------------------------------------------------
-- 1. Audit columns
-- ---------------------------------------------------------------------------
--
-- Migration 062's own header notes that gmv_cents has "no audit trail". While
-- only one person could write a figure that was a nice-to-have. Now that two
-- people share one field it is the safeguard that makes the shared-number model
-- acceptable: a disagreement becomes visible ("last saved by Sam") instead of a
-- silent overwrite.

ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS gmv_updated_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS gmv_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.streams.gmv_updated_by IS
  'Who last set gmv_cents (auth.uid() inside set_session_gmv, never client-supplied). Migration 074.';

-- Deliberately NOT added to any GRANT SELECT list in migration 055. These are
-- read only through the accessors below, so raw non-admin selects on streams
-- keep working exactly as they do today (055's grants are explicit column
-- lists, so a new column is simply not granted).

-- ---------------------------------------------------------------------------
-- 2. Canonical anchor resolution
-- ---------------------------------------------------------------------------
--
-- Walks BACKWARDS along the contiguous run containing p_stream_id and returns
-- its earliest stream. Mirrors buildSessions' rule exactly -- same brand, and
-- prev.end_time = next.start_time (exact instant equality, not overlap) -- with
-- host_id in the join, because the host partition is what every admin aggregate
-- groups by.
--
-- SECURITY DEFINER because it must see rows the CALLER cannot: a moderator has
-- no read access to the host's earlier streams, which is precisely why the
-- client cannot compute this itself.
--
-- NOT granted to authenticated. Exposed, it would let any signed-in user probe
-- the shape of another worker's schedule one stream id at a time. Same
-- reasoning as the revoke 059 applied to host_busy_in_range. It is only ever
-- called from inside set_session_gmv, which is itself SECURITY DEFINER and so
-- executes as the owner regardless.

CREATE OR REPLACE FUNCTION public.gmv_session_anchor(p_stream_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE back AS (
    SELECT s.id, s.host_id, s.brand_id, s.start_time
      FROM public.streams s
     WHERE s.id = p_stream_id
    UNION ALL
    SELECT s.id, s.host_id, s.brand_id, s.start_time
      FROM public.streams s
      JOIN back b
        ON s.host_id  = b.host_id
       AND s.brand_id = b.brand_id
       AND s.end_time = b.start_time
  )
  SELECT id FROM back ORDER BY start_time LIMIT 1;
$$;

COMMENT ON FUNCTION public.gmv_session_anchor(UUID) IS
  'Earliest stream of the contiguous same-brand, same-host run containing p_stream_id. Mirrors buildSessions in src/lib/gmv.ts. Internal to set_session_gmv; not granted to authenticated. Migration 074.';

REVOKE ALL ON FUNCTION public.gmv_session_anchor(UUID) FROM PUBLIC, anon;
-- No GRANT to authenticated. See the note above.

-- ---------------------------------------------------------------------------
-- 3. set_session_gmv -- SAME signature, so this genuinely REPLACES
-- ---------------------------------------------------------------------------
--
-- (uuid, integer) is unchanged, so CREATE OR REPLACE replaces the existing
-- function rather than adding an overload. Contrast migration 073, where the
-- argument list changed and the old signature had to be dropped explicitly --
-- the mistake that caused the outage migration 072 cleaned up. No DROP is
-- needed here, and the verify step below asserts there is still exactly one.
--
-- Preserved from 062 byte-for-byte: the is_active requirement, the "session has
-- ended" PT-naive comparison, the non-negative check, the ERRCODEs and the
-- messages. What changes is WHO may call it and WHICH ROW it writes.

CREATE OR REPLACE FUNCTION public.set_session_gmv(
  p_stream_id uuid,
  p_gmv_cents integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_id      uuid;
  v_moderator_id uuid;
  v_end          timestamptz;
  v_anchor_id    uuid;
BEGIN
  SELECT s.host_id, s.moderator_id, s.end_time
    INTO v_host_id, v_moderator_id, v_end
  FROM public.streams s
  WHERE s.id = p_stream_id;

  -- Kept from 062. A moderator-only session (no host) has no host partition, so
  -- GMV recorded against it would be invisible to every admin aggregate -- the
  -- Performance queries filter host_id IS NOT NULL. Write-only data that
  -- silently never appears anywhere is worse than not offering the field, so
  -- the UI does not offer those sessions and this rejects them.
  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'Session not found or has no host' USING ERRCODE = '22023';
  END IF;

  -- Caller must be the ACTIVE host OR the ACTIVE moderator of this stream.
  -- is_active on BOTH branches: that guard is the entire point of 062 -- without
  -- it a removed contractor keeps a live write path into revenue data, because
  -- this function is SECURITY DEFINER and so does not need them to be able to
  -- read the row.
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.hosts h
       WHERE h.id = v_host_id
         AND h.user_id = auth.uid()
         AND h.is_active
    )
    OR EXISTS (
      SELECT 1 FROM public.moderators m
       WHERE m.id = v_moderator_id
         AND m.user_id = auth.uid()
         AND m.is_active
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized for this session' USING ERRCODE = '42501';
  END IF;

  -- Session must have ended (PT wall-clock comparison; see 007's header).
  IF (v_end AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'America/Los_Angeles') THEN
    RAISE EXCEPTION 'Session has not ended yet' USING ERRCODE = '22023';
  END IF;

  IF p_gmv_cents IS NOT NULL AND p_gmv_cents < 0 THEN
    RAISE EXCEPTION 'GMV must be non-negative' USING ERRCODE = '22023';
  END IF;

  -- Write to the CANONICAL anchor, not to whatever row was passed. This is what
  -- makes "one shared number per session" true: a host whose run starts at 9 and
  -- a moderator who joined at 10 resolve to the same row, so the second save
  -- corrects the first instead of creating a second value that the reader either
  -- discards or double-counts. Also fixes the pre-existing case of a host
  -- writing to a non-anchor row.
  v_anchor_id := public.gmv_session_anchor(p_stream_id);

  UPDATE public.streams
     SET gmv_cents     = p_gmv_cents,
         gmv_updated_by = auth.uid(),
         gmv_updated_at = NOW()
   WHERE id = COALESCE(v_anchor_id, p_stream_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_session_gmv(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_session_gmv(uuid, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. One read accessor, serving BOTH roles
-- ---------------------------------------------------------------------------
--
-- gmv_cents is revoked from raw reads (migration 055), so a moderator cannot
-- see the current figure at all without an accessor, and neither role can see
-- the new audit columns.
--
-- WHY A NEW FUNCTION RATHER THAN WIDENING get_my_stream_pay. Two reasons, and
-- the second is the important one:
--
--   1. Widening it to also match moderator rows would hand a moderator the
--      HOST_RATE_CENTS of every stream they moderate, because that is what it
--      returns. That is a pay leak, and precisely what migration 055 exists to
--      prevent.
--
--   2. Adding the audit columns to it would change its RETURN TYPE, which
--      Postgres cannot do through CREATE OR REPLACE -- it needs a DROP first.
--      get_my_stream_pay is the function whose signature change caused the
--      outage that migration 072 cleaned up, and /my-shifts calls it with no
--      arguments on every page load for every host. Dropping and recreating it
--      to add two display-only fields is real downside risk for no functional
--      gain. Leave it completely untouched.
--
-- So: one narrow accessor, keyed on "the caller is the active host OR the
-- active moderator of this stream". Hosts already get gmv_cents from
-- get_my_stream_pay; receiving it here too is harmless and keeps one code path
-- in the app instead of two.
--
-- host_id IS NOT NULL mirrors the write path: a moderator-only session has no
-- host partition, so it is not offered for GMV entry and must not appear here
-- either, or the UI would show a row that cannot be saved.

CREATE OR REPLACE FUNCTION public.get_my_session_gmv()
RETURNS TABLE(
  stream_id       UUID,
  gmv_cents       INT,
  updated_by_name TEXT,
  updated_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.gmv_cents, p.full_name, s.gmv_updated_at
    FROM public.streams s
    LEFT JOIN public.profiles p ON p.id = s.gmv_updated_by
   WHERE s.host_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.hosts h
          WHERE h.id = s.host_id
            AND h.user_id = auth.uid()
            AND h.is_active
       )
       OR EXISTS (
         SELECT 1 FROM public.moderators m
          WHERE m.id = s.moderator_id
            AND m.user_id = auth.uid()
            AND m.is_active
       )
     )
   ORDER BY s.id;
$$;

COMMENT ON FUNCTION public.get_my_session_gmv() IS
  'Caller''s own hosted OR moderated streams: GMV + who last set it. Deliberately excludes host_rate_cents so it is safe for moderators -- see migration 074. ORDER BY id is required for correct paging.';

-- ORDER BY id is load-bearing, not tidiness: the app pages this through
-- fetchAllRows because PostgREST truncates at 1000 rows, and paging without a
-- deterministic order silently drops and repeats rows.

REVOKE ALL ON FUNCTION public.get_my_session_gmv() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_session_gmv() TO authenticated;

-- get_my_stream_pay is deliberately NOT modified by this migration.

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) TIE-OUT. Run this BEFORE applying and again after. Both numbers must be
--     IDENTICAL -- this migration must not move a single existing figure:
--
--       SELECT count(*) AS reported, sum(gmv_cents) AS total_cents
--         FROM public.streams WHERE gmv_cents IS NOT NULL;
--
-- (b) EXACTLY ONE of each function -- the migration-072 check. Assert the
--     COUNT, never just that the new one exists:
--
--       SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname = 'public'
--          AND p.proname IN ('set_session_gmv','get_my_stream_pay',
--                            'get_my_session_gmv','gmv_session_anchor')
--        ORDER BY p.proname, args;
--
--     Expect exactly 4 rows, one per name. Two rows sharing a name means an
--     overload survived and every call to it will fail as ambiguous.
--
-- (c) The anchor helper is NOT reachable from a client:
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SELECT public.gmv_session_anchor('00000000-0000-0000-0000-000000000000');
--       ROLLBACK;
--       -- expect: permission denied for function gmv_session_anchor
--
-- (d) Anchor resolution is CONSISTENT. Pick a real multi-row session (a host
--     with contiguous same-brand streams) -- every row must resolve to the same
--     id, and that id must be the earliest:
--
--       SELECT s.id, s.start_time, public.gmv_session_anchor(s.id) AS anchor
--         FROM public.streams s
--        WHERE s.host_id = '<A REAL host_id>'
--          AND s.brand_id = '<A REAL brand_id>'
--        ORDER BY s.start_time
--        LIMIT 20;
--       -- every `anchor` in one contiguous run must be identical, and equal to
--       -- the id of the earliest row of that run.
--
-- (e) A moderator sees their own rows and nobody else's:
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A REAL MODERATOR user_id>","role":"authenticated"}';
--         SELECT count(*) FROM public.get_my_session_gmv();
--       ROLLBACK;
--       -- must equal that moderator's stream count, and 0 for a DEACTIVATED one
--
-- (f) IN THE APP, the decisive check. Have a host and a moderator whose runs
--     START AT DIFFERENT TIMES on the same session both save a figure. Then:
--
--       SELECT id, start_time, gmv_cents FROM public.streams
--        WHERE host_id = '<that host>' AND brand_id = '<that brand>'
--        ORDER BY start_time;
--       -- EXACTLY ONE row in that contiguous run may have a non-null
--       -- gmv_cents, and it must be the earliest. Two means the anchor
--       -- resolution is not working and the reader will discard or
--       -- double-count one of them.
