-- 068_window_pay_accessors.sql
--
-- INTENT: make the pay accessors accept a date window, so the app stops
-- fetching every stream that has ever existed on every admin page load.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS URGENT
-- ---------------------------------------------------------------------------
--
-- Migration 064 + the paging change fixed a real correctness bug: PostgREST
-- silently truncates at 1000 rows, so admin_stream_pay() was returning an
-- arbitrary 1000-of-N and historical shifts were being re-priced at hosts'
-- current rates.
--
-- But the fix traded a wrong answer for a slow one. fetchAllRows() pages
-- SEQUENTIALLY — page 2 cannot start until page 1 returns — so a table with
-- 5,000 streams now costs FIVE round trips per call, on a function that seven
-- admin pages call. The pages got correct and noticeably slower at the same
-- time.
--
-- The waste is total: every one of those callers renders ONE MONTH. They were
-- fetching the entire history, building a Map from it, and then looking up the
-- handful of ids they actually display.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
--
-- Two optional arguments on the two functions that scan `streams`:
--
--     admin_stream_pay(p_from timestamptz DEFAULT NULL,
--                      p_to   timestamptz DEFAULT NULL)
--     get_my_stream_pay(p_from timestamptz DEFAULT NULL,
--                       p_to   timestamptz DEFAULT NULL)
--
-- Both default to NULL, which means "no bound" — byte-identical behaviour to
-- 064 for any caller that passes nothing. That matters for deploy ordering:
-- this migration is safe to apply BEFORE the code that uses the arguments,
-- because PostgREST resolves `rpc('admin_stream_pay')` with no args to the
-- all-defaults overload. Apply it first, deploy second, no broken window.
--
-- The filter is a half-open interval on end_time — `>= p_from AND < p_to` —
-- deliberately matching the payroll windows, which key on end_time so a shift
-- is paid in the period it FINISHES in (see the payroll-window change). Using
-- start_time here would let a caller's window and its pay map disagree about
-- which shifts belong to the period.
--
-- The rate/pricing maps (admin_host_rate_map, admin_moderator_rate_map,
-- admin_brand_pricing) are NOT touched. They are bounded by how many hosts,
-- moderators and brands exist — tens of rows, one round trip — so windowing
-- them would add argument-passing complexity for no measurable gain.
--
-- ORDER BY id is preserved from 064. It is what makes paging correct, and
-- callers that pass a wide window still page. Do not remove it.
--
-- APPLY ORDER: after 064. Apply BEFORE deploying the code that passes the
-- arguments (see above — the defaults make that safe either way).
-- No data is read, written or modified. Safe to re-run.
--
-- ROLLBACK: re-apply migration 064 verbatim, then drop the two-argument
-- overloads, which CREATE OR REPLACE will NOT remove because the signature
-- differs:
--   DROP FUNCTION IF EXISTS public.admin_stream_pay(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS public.get_my_stream_pay(timestamptz, timestamptz);
-- Roll the application back too, or its calls will resolve to nothing.

-- ---------------------------------------------------------------------------
-- 1. admin_stream_pay — the hot one (seven admin pages)
-- ---------------------------------------------------------------------------
-- Body identical to 064 apart from the two added predicates.

CREATE OR REPLACE FUNCTION public.admin_stream_pay(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  WHERE public.is_admin()
    AND (p_from IS NULL OR s.end_time >= p_from)
    AND (p_to   IS NULL OR s.end_time <  p_to)
  ORDER BY s.id;
$$;

COMMENT ON FUNCTION public.admin_stream_pay(timestamptz, timestamptz) IS
  'Per-stream frozen host rate + GMV, admin-only. PASS A WINDOW: unbounded it returns every stream ever, which exceeds PostgREST max_rows (1000) and costs one sequential round trip per 1000 rows. Half-open on end_time, matching the payroll windows. ORDER BY id (mig 064) keeps paging correct.';

-- ---------------------------------------------------------------------------
-- 2. get_my_stream_pay — the contractor's own My Shifts page
-- ---------------------------------------------------------------------------
-- Per-user, so smaller, but a long-tenured worker still crosses 1000 rows in
-- about a year and pays the same sequential-paging cost.

CREATE OR REPLACE FUNCTION public.get_my_stream_pay(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(stream_id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  JOIN public.hosts h ON h.id = s.host_id
  WHERE h.user_id = auth.uid()
    AND (p_from IS NULL OR s.end_time >= p_from)
    AND (p_to   IS NULL OR s.end_time <  p_to)
  ORDER BY s.id;
$$;

COMMENT ON FUNCTION public.get_my_stream_pay(timestamptz, timestamptz) IS
  'Caller''s own frozen shift pay + GMV. Pass a window where the surface has one. See migration 068.';

-- Permissions match 055/064. CREATE OR REPLACE preserves ACLs on an existing
-- signature, but these are NEW signatures (the arguments changed), so they need
-- granting explicitly.
REVOKE ALL ON FUNCTION public.admin_stream_pay(timestamptz, timestamptz)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_stream_pay(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_stream_pay(timestamptz, timestamptz)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_stream_pay(timestamptz, timestamptz) TO authenticated;

-- Make PostgREST notice the new signatures immediately. Without this its schema
-- cache can keep serving the old ones and calls with arguments fail with
-- PGRST202 "Could not find the function ... in the schema cache".
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) Both overloads exist (expect 2 rows each — the old no-arg form from 064
--     and the new windowed form; PostgREST picks by the arguments sent):
--
--       SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname='public'
--          AND p.proname IN ('admin_stream_pay','get_my_stream_pay')
--        ORDER BY p.proname, args;
--
-- (b) The window actually filters, and the unbounded call is unchanged:
--
--       SELECT count(*) AS all_rows       FROM public.admin_stream_pay();
--       SELECT count(*) AS one_month_rows FROM public.admin_stream_pay(
--         '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z');
--       -- one_month_rows must be far smaller, and all_rows must equal
--       -- (SELECT count(*) FROM public.streams)
--
-- (c) Still admin-only (run as a non-admin; expect 0, not an error):
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<NON-ADMIN user_id>","role":"authenticated"}';
--         SELECT count(*) FROM public.admin_stream_pay(NULL, NULL);
--       ROLLBACK;
