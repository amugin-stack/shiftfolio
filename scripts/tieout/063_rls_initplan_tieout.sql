-- ===========================================================================
-- TIE-OUT for migration 063 (RLS InitPlan rewrite)
-- ===========================================================================
--
-- WHAT THIS IS FOR. Migration 063 rewrites Row Level Security policies on the
-- live payroll database. It is supposed to be PERFORMANCE ONLY — the exact same
-- rows visible to the exact same people, just computed once per query instead
-- of once per row. This script is the EVIDENCE for that claim. "It should be
-- identical" is not evidence; matching fingerprints are.
--
-- HOW TO USE IT:
--   1. Run this whole file BEFORE applying 063. Save/screenshot the result.
--   2. Apply migration 063.
--   3. Run this whole file AGAIN. Compare to step 1.
--
--   EVERY count and EVERY fingerprint must be identical.
--   Any difference at all -> roll 063 back (rollback steps are in its footer).
--
-- WHY A FINGERPRINT AND NOT JUST A COUNT. Two different sets of rows can have
-- the same count. The fingerprint is an md5 of the exact list of row ids a user
-- can see, so it catches "same number of rows, but different rows" — which is
-- precisely the failure a count alone would wave through. The count is there so
-- you can eyeball whether a number looks sane; the fingerprint is the real test.
--
-- WHY IT IMPERSONATES PEOPLE. The Supabase SQL editor connects as the table
-- owner, and RLS does not apply to the owner. Run these queries normally and
-- you would see every row every time and prove nothing. `SET ROLE authenticated`
-- plus a fake JWT claim switches to a role that policies actually apply to.
-- That switch is the entire point of the script.
--
-- IS THIS SAFE TO RUN ON PRODUCTION? Yes. It only reads. It writes nothing
-- except a temporary result table that vanishes when you close the tab. It
-- changes no policies, no data, and no permissions. Safe to run any number of
-- times.
--
-- PASTE THE WHOLE FILE AND PRESS RUN ONCE. The final SELECT prints the results.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Somewhere to collect the results (temporary — disappears on disconnect).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS tieout_063;
CREATE TEMP TABLE tieout_063 (
  slot            text,
  who             text,
  user_id         uuid,
  n_streams       bigint,
  streams_fp      text,
  n_extra_pay     bigint,
  extra_pay_fp    text,
  note            text
);


-- ---------------------------------------------------------------------------
-- Pick six representative users and measure what each of them can see.
-- ---------------------------------------------------------------------------
--
-- The six slots are chosen to cover every branch of the policy 063 rewrites:
--   A  admin                  -> the is_admin() branch (the expensive one)
--   B  producer               -> the "producers see everything" branch
--   C  active host            -> the host branch, is_active = true
--   D  active moderator       -> the moderator branch, is_active = true
--   E  DEACTIVATED host       -> the host branch, is_active = false  (expect 0)
--   F  DEACTIVATED moderator  -> the moderator branch, is_active = false (expect 0)
--
-- Each candidate is required to actually HAVE streams (the EXISTS filters
-- below). A test user with no shifts would score 0 before and 0 after and prove
-- nothing at all.
DO $$
DECLARE
  r            record;
  v_n_streams  bigint;
  v_fp_streams text;
  v_n_extra    bigint;
  v_fp_extra   text;
BEGIN
  FOR r IN
        -- Each branch is PARENTHESISED. Postgres does not allow ORDER BY /
        -- LIMIT on a bare arm of a UNION -- it reads them as applying to the
        -- whole union and errors at the UNION keyword. The parentheses scope
        -- them to their own branch, which is what "pick one representative of
        -- each kind of user" needs.
        (SELECT 'A' AS slot, 'admin' AS who, p.id AS user_id
           FROM public.profiles p
          WHERE p.role = 'admin'
          ORDER BY p.id
          LIMIT 1)
    UNION ALL
        (SELECT 'B', 'producer', pr.user_id
           FROM public.producers pr
          WHERE pr.user_id IS NOT NULL
          ORDER BY pr.user_id
          LIMIT 1)
    UNION ALL
        (SELECT 'C', 'host (active)', h.user_id
           FROM public.hosts h
          WHERE h.user_id IS NOT NULL AND h.is_active
            AND EXISTS (SELECT 1 FROM public.streams s WHERE s.host_id = h.id)
          ORDER BY h.user_id
          LIMIT 1)
    UNION ALL
        (SELECT 'D', 'moderator (active)', m.user_id
           FROM public.moderators m
          WHERE m.user_id IS NOT NULL AND m.is_active
            AND EXISTS (SELECT 1 FROM public.streams s WHERE s.moderator_id = m.id)
          ORDER BY m.user_id
          LIMIT 1)
    UNION ALL
        (SELECT 'E', 'host (DEACTIVATED)', h.user_id
           FROM public.hosts h
          WHERE h.user_id IS NOT NULL AND NOT h.is_active
            AND EXISTS (SELECT 1 FROM public.streams s WHERE s.host_id = h.id)
          ORDER BY h.user_id
          LIMIT 1)
    UNION ALL
        (SELECT 'F', 'moderator (DEACTIVATED)', m.user_id
           FROM public.moderators m
          WHERE m.user_id IS NOT NULL AND NOT m.is_active
            AND EXISTS (SELECT 1 FROM public.streams s WHERE s.moderator_id = m.id)
          ORDER BY m.user_id
          LIMIT 1)
  LOOP
    -- Become this user, as far as the database is concerned.
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', r.user_id, 'role', 'authenticated')::text,
      true    -- local to this transaction
    );
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- Everything below here runs under that user's RLS policies.
    -- count(*) works despite the column locks from migration 061: Postgres
    -- allows it when you hold SELECT on at least one column, and `id` is
    -- granted.
    SELECT count(*), md5(string_agg(s.id::text, ',' ORDER BY s.id))
      INTO v_n_streams, v_fp_streams
      FROM public.streams s;

    SELECT count(*), md5(string_agg(e.id::text, ',' ORDER BY e.id))
      INTO v_n_extra, v_fp_extra
      FROM public.extra_pay_slots e;

    -- Back to being ourselves so we can write the result down.
    RESET ROLE;

    INSERT INTO tieout_063
    VALUES (r.slot, r.who, r.user_id,
            v_n_streams, v_fp_streams,
            v_n_extra,   v_fp_extra,
            NULL);
  END LOOP;

  RESET ROLE;  -- belt and braces
END $$;


-- ---------------------------------------------------------------------------
-- Flag any slot that found no candidate at all.
-- ---------------------------------------------------------------------------
-- This matters. If (say) there is no deactivated host who has historical
-- streams, then the deactivation half of this test did not run. That must be
-- recorded as UNTESTED, not quietly counted as a pass.
INSERT INTO tieout_063 (slot, who, note)
SELECT v.slot, v.who,
       '!! NO CANDIDATE FOUND — this branch of the policy is UNTESTED, not passed'
  FROM (VALUES
          ('A','admin'),
          ('B','producer'),
          ('C','host (active)'),
          ('D','moderator (active)'),
          ('E','host (DEACTIVATED)'),
          ('F','moderator (DEACTIVATED)')
       ) AS v(slot, who)
 WHERE NOT EXISTS (SELECT 1 FROM tieout_063 t WHERE t.slot = v.slot);


-- ---------------------------------------------------------------------------
-- THE RESULT. Compare this table before vs after applying 063.
-- ---------------------------------------------------------------------------
SELECT
  slot,
  who,
  n_streams,
  streams_fp,
  n_extra_pay,
  extra_pay_fp,
  COALESCE(
    note,
    CASE
      WHEN slot IN ('E','F') AND n_streams > 0
        THEN '!! a DEACTIVATED worker can see streams — investigate (see below)'
      ELSE 'ok'
    END
  ) AS status
FROM tieout_063
ORDER BY slot;


-- ===========================================================================
-- HOW TO READ THE RESULT
-- ===========================================================================
--
--   All counts AND all fingerprints identical before vs after
--       -> PASS. 063 is proven performance-only. Nothing to do.
--
--   A count changed
--       -> STOP. Roll 063 back. The visible row set moved.
--
--   A count is the same but a fingerprint changed
--       -> STOP. Roll 063 back. Different rows, same number of them — exactly
--          the failure a count on its own would have missed.
--
--   Slot E or F shows n_streams > 0 in the BEFORE run
--       -> A pre-existing deactivation bypass. NOT caused by 063 and not fixed
--          by it. Note it and investigate separately; it does not block 063.
--
--   Slot E or F goes from 0 in BEFORE to >0 in AFTER
--       -> STOP AND ROLL BACK IMMEDIATELY. 063 broke the deactivation boundary.
--
--   A slot says "NO CANDIDATE FOUND"
--       -> That branch is UNTESTED. Write that down as untested. Do not record
--          it as a pass. (For E/F this just means nobody deactivated has old
--          shifts, which is plausible and not itself a problem.)
--
-- ===========================================================================
-- FALLBACK: doing one user by hand
-- ===========================================================================
-- If the block above ever fails to run, this is the same test for a single
-- person, using the pattern already established in migration 061. Substitute a
-- real user_id. The ROLLBACK is what guarantees it cannot alter anything.
--
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"sub":"<A REAL user_id>","role":"authenticated"}';
--     SELECT count(*)                                        AS n_streams,
--            md5(string_agg(id::text, ',' ORDER BY id))       AS streams_fp
--       FROM public.streams;
--   ROLLBACK;
--
-- Omitting the `SET LOCAL ROLE authenticated` line makes the test meaningless —
-- you would be reading as the table owner, who bypasses RLS entirely.
--
-- ===========================================================================
-- SEEING THE ACTUAL SPEEDUP (optional, read-only, run before and after)
-- ===========================================================================
-- Substitute a real admin user_id and a real brand id. Run it TWICE and use the
-- SECOND result — the first pass pays for a cold cache and would overstate the
-- improvement.
--
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"sub":"<ADMIN user_id>","role":"authenticated"}';
--     EXPLAIN (ANALYZE, BUFFERS, TIMING)
--     SELECT s.id, s.title, s.start_time, s.end_time,
--            b.name AS brand, h.name AS host, m.name AS moderator, p.name AS producer
--       FROM public.streams s
--       JOIN      public.brands     b ON b.id = s.brand_id
--       LEFT JOIN public.hosts      h ON h.id = s.host_id
--       LEFT JOIN public.moderators m ON m.id = s.moderator_id
--       LEFT JOIN public.producers  p ON p.id = s.producer_id
--      WHERE s.brand_id = '<A REAL BRAND uuid>'
--      ORDER BY s.start_time;
--   ROLLBACK;
--
-- BEFORE you expect, on the scan of streams, something like:
--     Filter: (is_admin() OR (SubPlan 1) OR (created_by = uid()) OR (SubPlan 2))
-- with the node's actual time dominated by that filter — is_admin() and
-- auth.uid() being called once per row.
--
-- AFTER you expect `InitPlan 1 (returns $0)` to appear ABOVE the scan and the
-- filter to shrink to a reference like `Filter: ($0 OR ...)`. For an admin the
-- planner often collapses it to `One-Time Filter: $0`, meaning the check ran
-- ONCE for the whole query. Compare the final `Execution Time:` lines.
--
-- Sanity check on the result: the saving should be LARGER for brands with more
-- history. If it isn't, you are probably not measuring what you think you are.
