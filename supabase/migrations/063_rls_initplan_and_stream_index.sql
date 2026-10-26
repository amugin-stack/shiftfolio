-- 063_rls_initplan_and_stream_index.sql
--
-- INTENT (PERFORMANCE ONLY — this migration must not change who can see what):
-- the whole portal got slow, and the largest single cause is the SHAPE of one
-- RLS policy rather than anything in the application code.
--
-- WHAT IS ACTUALLY WRONG. The SELECT policy on streams (migration 058) begins:
--
--     USING ( public.is_admin() OR auth.uid() IN ( ... ) OR ... )
--
-- `public.is_admin()` there is a BARE function call used as a boolean. Postgres
-- cannot hoist a bare function call into an InitPlan (a value computed once at
-- the start of the statement), and it cannot use it as an index key either,
-- because it is not being compared against a column. So it degrades to a plain
-- row filter: Postgres calls it AGAIN FOR EVERY ROW IT SCANS. And is_admin()
-- (059:93) runs a lookup against `profiles`. Scanning 3,000 streams therefore
-- performs 3,000 profile lookups to answer a question whose answer cannot
-- change during the statement. Same story for the bare `auth.uid()` calls,
-- which each parse the JWT claims JSON out of a session variable, per row.
--
-- This is why the app got slower over time rather than all at once: the cost is
-- proportional to the number of rows in `streams`, which grows every week.
--
-- THE FIX, in one sentence: wrapping a call in `(SELECT ...)` turns it into a
-- scalar sub-select, which Postgres promotes to an InitPlan and evaluates ONCE
-- per statement instead of once per row. This is the standard remedy and is
-- exactly what Supabase's own `auth_rls_initplan` performance advisor
-- recommends. Nothing else about the predicate changes.
--
-- WHY THIS CANNOT CHANGE THE VISIBLE ROW SET. `is_admin()` and `auth.uid()` are
-- both declared STABLE, which is a promise to Postgres that they return the
-- same answer for the duration of the statement. Postgres was ALREADY entitled
-- to call them once; it simply wasn't, because the syntax gave it nowhere to
-- cache the result. `(SELECT ...)` gives it that place. We are not asking for a
-- different answer — we are asking for the same answer to stop being
-- recomputed. Every branch of the policy, and every `is_active` and
-- `user_id IS NOT NULL` guard from 058, is reproduced below BYTE-FOR-BYTE apart
-- from those wrappers.
--
-- Even so: RLS is a security boundary (CLAUDE.md rule 6), and "it should be
-- identical" is not evidence. The tie-out script that ships alongside this file
-- (scripts/tieout/063_rls_initplan_tieout.sql) is the evidence. RUN IT.
--
-- ---------------------------------------------------------------------------
-- WHAT I DELIBERATELY DID NOT DO, and why (recorded so nobody redoes the work)
-- ---------------------------------------------------------------------------
--
-- The four-branch UNION inside the policy is CORRELATED — each branch
-- references streams.host_id / brand_id / producer_id / moderator_id, i.e. a
-- value from the row being tested. A correlated subquery genuinely cannot be
-- hoisted; there is no single answer to cache. It runs per row and no wrapper
-- changes that.
--
-- It CAN be rewritten as four separate EXISTS clauses, and that rewrite is
-- exactly equivalent. Recording the proof here so it does not have to be
-- re-derived. Let u = auth.uid(), and S = the set the UNION produces:
--
--   * Every branch carries `user_id IS NOT NULL`, so S CONTAINS NO NULLS. That
--     guard is load-bearing — it is the entire reason the rewrite would be
--     safe. An IN-to-EXISTS rewrite over a subquery that CAN return NULL is a
--     classic way to silently change behaviour, because `x IN (set containing
--     NULL)` yields NULL rather than FALSE when x is absent.
--   * If u IS NOT NULL: S has no NULLs, so `u IN S` is plain TRUE/FALSE, never
--     NULL. And u is in S exactly when some branch has a row passing its own
--     WHERE whose user_id equals u — which is precisely what adding
--     `AND user_id = u` to that branch's WHERE tests. UNION's de-duplication is
--     irrelevant to set membership. Identical.
--   * If u IS NULL: `NULL IN S` is FALSE (empty S) or NULL (non-empty). The
--     EXISTS form gives FALSE, since `user_id = NULL` is NULL for every row.
--     FALSE and NULL are indistinguishable in an RLS USING clause — both mean
--     "row not visible". Identical outcome. (Unreachable anyway: you need the
--     `authenticated` grant to read the table at all.)
--   * Stream with a NULL host_id: `id = streams.host_id` is NULL for every
--     hosts row, so the branch contributes nothing in the UNION form and the
--     EXISTS is FALSE. Identical. Same for producer_id and moderator_id, both
--     nullable. brand_id is NOT NULL.
--   * A hosts row with a NULL user_id: excluded by the guard in BOTH forms.
--   * The case that catches a careless rewrite: a DEACTIVATED host whose
--     user_id = u, on a stream where u is ALSO the brand owner. UNION: branch 1
--     is excluded by is_active, branch 2 emits u, row visible. EXISTS: E1 is
--     FALSE, E2 is TRUE, row visible. Identical — but ONLY because each guard
--     stays welded to its own branch.
--
-- >>> AND YET THE REWRITE IS NOT IN THIS FILE. Three reasons. <<<
--
--   1. It would buy almost nothing. Postgres evaluates OR left-to-right and
--      stops at the first TRUE. `(SELECT public.is_admin())` is written FIRST
--      and is TRUE for an admin, so after this migration the UNION is NEVER
--      EXECUTED for admins at all. Admins are the ones running the unfiltered
--      payroll, dashboard and export queries. The expensive workload already
--      skips the expensive clause.
--   2. Non-admins don't hit it hard either — their queries already filter to
--      themselves (my-shifts uses .eq('host_id',...), assignments uses
--      .eq('moderator_id',...)), so the UNION runs over few rows.
--   3. This is a live payroll database and the diff you can REVIEW is the diff
--      you should ship. What follows differs from 058 by four `(SELECT ...)`
--      wrappers on an otherwise character-identical predicate — checkable at a
--      glance. The EXISTS version is a structural rewrite that is correct for
--      reasons involving three-valued logic. Both are correct; only one is
--      OBVIOUSLY correct, and on this database that is the deciding factor.
--
--   If profiling ever shows the UNION is genuinely hot for some specific
--   non-admin, a later migration can apply the rewrite — as FOUR separate
--   EXISTS clauses, each keeping its own guards. NOT as one EXISTS with OR'd
--   conditions: that would apply `is_active` to the brand and producer
--   branches, which have no such concept, and would silently hide rows.
--
-- ---------------------------------------------------------------------------
-- THE INDEX — one, and only one
-- ---------------------------------------------------------------------------
--
-- The stream-overlap check that runs whenever the booking modal opens (and
-- again as a race guard on save) filters `start_time < A AND end_time > B`
-- across ALL brands — six call sites in StreamEventModal.tsx. There is
-- currently NO index on end_time anywhere. Worse, `start_time < A` is nearly
-- useless as an index boundary because most streams are in the PAST, so it
-- matches almost the whole table — which is why this ends up a sequential scan
-- today. `end_time > B` with B around "now" is the selective half: only live
-- and future shifts. Leading the index on end_time is the fix. Including
-- start_time as the second column lets Postgres apply that condition inside the
-- index rather than fetching each candidate row from the heap to check it —
-- strictly better for the same write cost as a single-column index.
--
-- Everything else was already covered, and I checked before proposing:
--   brand_id + start_time  -> streams_unique_slot (brand_id, start_time), the
--                             UNIQUE constraint from migration 007. A new index
--                             here would be an exact duplicate.
--   host_id                -> idx_streams_host_id       (001)
--   moderator_id           -> idx_streams_moderator_id  (026)
--   producer_id            -> idx_streams_producer_id   (002)
--   start_time alone       -> idx_streams_start_time    (001)
--
-- I considered (host_id, start_time) to skip a sort on my-shifts and rejected
-- it: it fully SUBSUMES idx_streams_host_id, so adding it without dropping that
-- one means paying two index writes per insert for one index's worth of reads
-- — to save sorting roughly 150 rows. Revisit if streams passes ~100k rows.
--
-- Write cost of the one index we ARE adding: one extra btree entry per INSERT
-- into streams, and per UPDATE that moves start_time/end_time. Going from 6
-- indexes to 7 on a few-thousand-row table is unmeasurable.
--
-- ---------------------------------------------------------------------------
-- >>> HOW TO APPLY THIS SAFELY <<<
-- ---------------------------------------------------------------------------
--
--   PASTE THIS ENTIRE FILE INTO THE SUPABASE SQL EDITOR AND RUN IT ONCE.
--   Do not split it into pieces. Do not run it a statement at a time.
--
--   Why that matters: the editor sends the whole script as one message, and
--   Postgres wraps a multi-statement message in a single implicit transaction.
--   So it is all-or-nothing — if anything fails, NOTHING is applied and the
--   database is exactly as it was. Run piecemeal, there would be a window
--   between DROP POLICY and CREATE POLICY where the policy does not exist, and
--   because permissive SELECT policies are OR'd together, during that window
--   every non-producer would see ZERO streams.
--
--   DO NOT use CREATE INDEX CONCURRENTLY. It cannot run inside a transaction
--   block, so it would fail here — and if it ever half-succeeded it leaves
--   behind an INVALID index that costs writes, is never used for reads, and has
--   to be found and dropped by hand. You don't need it: on a table of a few
--   thousand rows a plain CREATE INDEX finishes in WELL UNDER 50 ms
--   (realistically 5-20 ms). It takes a SHARE lock, meaning READS CONTINUE
--   NORMALLY and only writes wait — for less time than one page load.
--
--   If the editor seems to hang for more than about five seconds, press Cancel.
--   The lock_timeout below will usually do it for you first. Either way the
--   transaction rolls back completely; there is no half-applied state. A hang
--   means someone had a long query open — wait a minute and re-run.
--
--   Best run at a quiet moment, but this does not require downtime.
--
-- APPLY ORDER: strictly AFTER 058 (whose predicate this reproduces) and after
-- 059 (whose policy comment this restores). The PRE-FLIGHT block below REFUSES
-- TO RUN if 058 is not actually live, because migrations here are applied by
-- hand and the files cannot tell us what is really in this database. That guard
-- is not ceremony: if 058 had been skipped, this file's CREATE POLICY would
-- install the is_active guards for the FIRST time, turning a performance
-- migration into a silent security change — exactly what CLAUDE.md rule 6
-- forbids doing unflagged. Better to abort loudly.
--
-- As 052 and 058 both warn: if the agent2migrations batch is ever re-run it
-- clobbers "streams: read own or admin" back to the LEAKY brand_hosts version.
-- Recovery is then 052 -> 058 -> 063, in that order.
--
-- ROLLBACK: see the block at the very bottom. Re-applying 058 alone is NOT
-- sufficient — it does not define "streams: producer read all" (that is 051)
-- and it does not restore 059's policy comment. All four steps are spelled out.
--
-- No data is read, written or modified by this file. It changes policy text,
-- adds one index, and restores one comment. Safe to re-run.

-- Fail fast instead of stalling the app if someone has a long query open.
-- RESET at the end so this cannot leak onto a pooled connection.
SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT: refuse to run unless 058 is genuinely live in THIS database
-- ---------------------------------------------------------------------------
--
-- Reads the LIVE policy out of the catalog rather than trusting the migration
-- files. If any check fails, the exception aborts the whole transaction and
-- nothing at all is applied. Same reasoning as the guarded DO block in 059.
DO $$
DECLARE
  v_streams_qual  text;
  v_extrapay_qual text;
BEGIN
  SELECT qual INTO v_streams_qual
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'streams'
     AND policyname = 'streams: read own or admin';

  IF v_streams_qual IS NULL THEN
    RAISE EXCEPTION
      '063 ABORT: policy "streams: read own or admin" does not exist on public.streams. Apply 052 then 058 first, verify them, then re-run 063.';
  END IF;

  IF v_streams_qual NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION
      '063 ABORT: the live streams policy has NO is_active guard, which means migration 058 was never applied to this database. 063 is a PERFORMANCE-ONLY migration and must not be the thing that changes a security boundary. Apply 058, verify it, then re-run 063.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'streams'
       AND policyname = 'streams_select'
  ) THEN
    RAISE EXCEPTION
      '063 ABORT: the legacy policy "streams_select" is still present. It grants deactivated hosts access and is a live bypass (see 058). Apply 058 first.';
  END IF;

  SELECT qual INTO v_extrapay_qual
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'extra_pay_slots'
     AND policyname = 'extra_pay: host reads own';

  IF v_extrapay_qual IS NULL THEN
    RAISE EXCEPTION
      '063 ABORT: policy "extra_pay: host reads own" does not exist. Apply 057 then 058 first.';
  END IF;

  IF v_extrapay_qual NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION
      '063 ABORT: the live extra_pay policy has NO is_active guard, so 058 was not applied here. Apply 058 first.';
  END IF;

  RAISE NOTICE '063 pre-flight OK: 058 is live on both streams and extra_pay_slots. Proceeding.';
END $$;

-- ---------------------------------------------------------------------------
-- 1. streams: read own or admin   <- the one that matters
-- ---------------------------------------------------------------------------
--
-- Character-for-character identical to migration 058 (lines 74-97) except for
-- four wrappers:
--     public.is_admin()  ->  (SELECT public.is_admin())
--     auth.uid()         ->  (SELECT auth.uid())          [three occurrences]
-- Every branch, and every is_active / user_id IS NOT NULL guard, is preserved.
--
-- Clause order matters and is not accidental: (SELECT public.is_admin()) is
-- FIRST so that for an admin the OR short-circuits to TRUE immediately and the
-- correlated UNION below is never executed at all.

DROP POLICY IF EXISTS "streams: read own or admin" ON public.streams;

CREATE POLICY "streams: read own or admin"
  ON public.streams FOR SELECT
  USING (
    (SELECT public.is_admin())
    OR (SELECT auth.uid()) IN (
      -- Host branch: requires the host record to still be ACTIVE. (058)
      SELECT user_id FROM public.hosts
        WHERE id = streams.host_id AND user_id IS NOT NULL AND is_active
      UNION
      SELECT user_id FROM public.brands
        WHERE id = streams.brand_id AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.producers
        WHERE id = streams.producer_id AND user_id IS NOT NULL
      UNION
      -- Moderator branch: same requirement. (058)
      SELECT user_id FROM public.moderators
        WHERE id = streams.moderator_id AND user_id IS NOT NULL AND is_active
    )
    OR created_by = (SELECT auth.uid())
    -- Producers (only) keep broad visibility into every stream — unchanged
    -- from 052/058. Producers have no is_active concept.
    OR EXISTS (SELECT 1 FROM public.producers WHERE user_id = (SELECT auth.uid()))
  );

-- Restore the comment migration 059 attached to this policy. DROP POLICY
-- silently takes the comment with it, and without this line a documented
-- caveat about the hosts/brands read leak would just quietly disappear from the
-- database. Verbatim from 059:282-283, plus one sentence noting this rewrite.
COMMENT ON POLICY "streams: read own or admin" ON public.streams IS
  'Deactivated hosts/moderators lose stream reads (mig 058/059). NOTE: this does NOT revoke reads on hosts/brands — that leak is tracked in migration 055 (feat/lock-pay-columns). Migration 063 rewrote this policy for PERFORMANCE ONLY (InitPlan wrapping); the predicate logic is unchanged from 058.';

-- ---------------------------------------------------------------------------
-- 2. streams: producer read all
-- ---------------------------------------------------------------------------
--
-- Honest note: this one is already fine. Its EXISTS is UNCORRELATED — it
-- references no column of streams — and Postgres already promotes a subquery
-- with no outer references to an InitPlan by itself. So it evaluates once per
-- statement TODAY, and the change below will not make anything measurably
-- faster.
--
-- Applying it anyway for two reasons: it silences Supabase's auth_rls_initplan
-- advisor (so the advisor's output stays a meaningful signal rather than a list
-- of known-benign noise), and it makes every streams policy follow one
-- consistent form so the next person does not have to re-derive which bare
-- auth.uid() calls are the expensive ones.
--
-- Predicate is otherwise identical to migration 051 (lines 53-56).

DROP POLICY IF EXISTS "streams: producer read all" ON public.streams;

CREATE POLICY "streams: producer read all"
  ON public.streams FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.producers p WHERE p.user_id = (SELECT auth.uid())));

-- ---------------------------------------------------------------------------
-- 3. extra_pay: host reads own
-- ---------------------------------------------------------------------------
--
-- This EXISTS is CORRELATED (it references extra_pay_slots.host_id), so unlike
-- the producer policy above it really does run per row — and the auth.uid()
-- inside it is therefore parsed out of the JWT claims per row. Wrapping it
-- hoists that one call.
--
-- Identical to 058 (lines 103-113) apart from that wrapper. All three guards
-- preserved: h.user_id = auth.uid(), h.user_id IS NOT NULL, and h.is_active.

DROP POLICY IF EXISTS "extra_pay: host reads own" ON public.extra_pay_slots;

CREATE POLICY "extra_pay: host reads own"
  ON public.extra_pay_slots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.hosts h
      WHERE h.id = extra_pay_slots.host_id
        AND h.user_id = (SELECT auth.uid())
        AND h.user_id IS NOT NULL
        AND h.is_active
    )
  );

-- ---------------------------------------------------------------------------
-- 4. extra_pay: admin read all
-- ---------------------------------------------------------------------------
--
-- Found while auditing every policy for this pattern: "extra_pay: admin read
-- all" (migration 057:81-83) is `USING (public.is_admin())` — bare, exactly the
-- same defect as the streams policy, on a table that holds PAY data. Fixing it
-- in the same pass rather than leaving a known per-row profiles lookup on a
-- payroll table. Same one-wrapper change, same reasoning as section 1.

DROP POLICY IF EXISTS "extra_pay: admin read all" ON public.extra_pay_slots;

CREATE POLICY "extra_pay: admin read all"
  ON public.extra_pay_slots FOR SELECT
  USING ((SELECT public.is_admin()));

-- ---------------------------------------------------------------------------
-- 5. The one missing index
-- ---------------------------------------------------------------------------
--
-- Serves `start_time < A AND end_time > B` — the cross-brand overlap check the
-- booking modal runs on open and again as a race guard on save. Rationale for
-- the column order is in the header.
--
-- IF NOT EXISTS so this file stays safe to re-run.
-- Plain CREATE INDEX, NOT CONCURRENTLY — see the apply instructions above.

CREATE INDEX IF NOT EXISTS idx_streams_end_start
  ON public.streams (end_time, start_time);

COMMENT ON INDEX public.idx_streams_end_start IS
  'Migration 063. Serves the cross-brand overlap check (start_time < A AND end_time > B) in StreamEventModal. Leads on end_time because start_time alone is unselective — most streams are in the past.';

-- Do not leak the shortened lock timeout onto a pooled connection.
RESET lock_timeout;

-- ---------------------------------------------------------------------------
-- VERIFY IMMEDIATELY AFTER APPLYING — run these three in the SQL editor
-- ---------------------------------------------------------------------------
--
-- (a) 058's own check still passes, unchanged. Exactly TWO rows, and the
--     is_active guard is still on the right one:
--
--       SELECT policyname, qual LIKE '%is_active%' AS guarded
--         FROM pg_policies
--        WHERE schemaname='public' AND tablename='streams' AND cmd='SELECT';
--
--     Expect: "streams: read own or admin" -> true
--             "streams: producer read all" -> false  (correct — producers have
--                                                     no is_active concept)
--     A THIRD row means another read path exists and must be investigated.
--
-- (b) Every branch survived the rewrite. All five columns must be true:
--
--       SELECT qual LIKE '%hosts%'      AS has_host_branch,
--              qual LIKE '%brands%'     AS has_brand_branch,
--              qual LIKE '%producers%'  AS has_producer_branch,
--              qual LIKE '%moderators%' AS has_moderator_branch,
--              qual LIKE '%created_by%' AS has_created_by_branch
--         FROM pg_policies
--        WHERE schemaname='public' AND tablename='streams'
--          AND policyname='streams: read own or admin';
--
-- (c) The index exists and is VALID (indisvalid must be true):
--
--       SELECT indexrelid::regclass AS index_name, indisvalid
--         FROM pg_index
--        WHERE indexrelid = 'public.idx_streams_end_start'::regclass;
--
-- (d) THEN RUN THE TIE-OUT: scripts/tieout/063_rls_initplan_tieout.sql
--     Checks (a)-(c) only confirm the migration APPLIED. Only the tie-out
--     confirms that nobody's visible rows moved. It is the whole safety case
--     for this migration — do not skip it.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK — all four steps. Step 1 alone is NOT enough.
-- ---------------------------------------------------------------------------
--
--   1. Re-run migration 058 VERBATIM (the whole file,
--      supabase/migrations/058_deactivated_lose_access.sql). This restores
--      "streams: read own or admin" and "extra_pay: host reads own" to their
--      pre-063 text.
--
--   2. Re-run the "streams: producer read all" statement from migration 051
--      (051_producers_view_only.sql lines 53-56). 058 does NOT define this
--      policy, so step 1 leaves it in its 063 form:
--
--        DROP POLICY IF EXISTS "streams: producer read all" ON public.streams;
--        CREATE POLICY "streams: producer read all"
--          ON public.streams FOR SELECT
--          USING (EXISTS (SELECT 1 FROM public.producers p WHERE p.user_id = auth.uid()));
--
--   2b. Re-run the "extra_pay: admin read all" statement from migration 057
--       (lines 80-83):
--
--        DROP POLICY IF EXISTS "extra_pay: admin read all" ON public.extra_pay_slots;
--        CREATE POLICY "extra_pay: admin read all"
--          ON public.extra_pay_slots FOR SELECT
--          USING (public.is_admin());
--
--   3. Re-run 059's COMMENT ON POLICY (059 lines 282-283). Step 1's DROP POLICY
--      destroys the comment again:
--
--        COMMENT ON POLICY "streams: read own or admin" ON public.streams IS
--          'Deactivated hosts/moderators lose stream reads (mig 058/059). NOTE: this does NOT revoke reads on hosts/brands — that leak is tracked in migration 055 (feat/lock-pay-columns).';
--
--   4. Drop the index:
--
--        DROP INDEX IF EXISTS public.idx_streams_end_start;
--
--   Rolling back restores the SLOW behaviour, not a different one. Since 063
--   changes no visible row set, there is no data-correctness reason to roll
--   back — only a "something unexpected happened, put it back exactly" reason.
