-- 064_order_pay_rpcs_for_paging.sql
--
-- INTENT: make the pay accessor functions safe to read in pages, so the app can
-- stop silently losing money data.
--
-- ---------------------------------------------------------------------------
-- THE BUG THIS IS HALF OF
-- ---------------------------------------------------------------------------
--
-- PostgREST caps EVERY response at `max_rows` — 1000 here (supabase/config.toml
-- line 18). It truncates SILENTLY: no error, no flag, the array just stops.
-- That cap applies to stored procedures exactly as it does to tables; the
-- config file's own comment says so ("a view, table, or stored procedure").
--
-- `admin_stream_pay()` (migration 055) returns one row per stream, for every
-- stream that has ever existed, with no window and no ORDER BY. Its header
-- comment reads "Just 3 small columns, admin-only, infrequent — no window
-- needed." That reasoning was about PAYLOAD SIZE. It missed max_rows entirely.
--
-- So on a database past 1000 streams — which this one is; the brand calendar
-- hit the same wall at 1,079 — the function returns an arbitrary 1000 of them.
-- Seven admin money screens then build a Map from that partial result and do:
--
--     streamPayMap.get(s.id)?.host_rate_cents ?? null
--
-- A MISSING map entry is indistinguishable from a genuinely NULL frozen rate.
-- And `null` does not mean "unknown" downstream — in payout.ts it means "fall
-- back to the host's CURRENT flat rate". So a historical shift that was frozen
-- at $20/hr gets silently re-priced at whatever the host earns today.
--
-- Worked example. A 3-hour shift, frozen at host_rate_cents = 2000. The host is
-- now on 3000. Correct pay is ROUND(2000 * 180 / 60) = 6000 ($60.00). If that
-- stream id is not among the 1000 rows that happened to come back, the app
-- computes 9000 ($90.00) instead. A $30 error, on one shift, with no warning —
-- and it lands in the payroll CSV an admin pays from.
--
-- Because there is no ORDER BY, WHICH 1000 rows come back is heap order. It is
-- not stable: it changes after an UPDATE or a VACUUM. Two loads of the same
-- payroll page can return two different subsets, so the totals move between
-- refreshes with nothing having changed. That matches the reported symptom.
--
-- Affected: admin/payroll/hosts (+ per-host), the payroll CSV export route,
-- admin/dashboard (+ per-brand), admin/performance (+ per-host), and — via
-- get_my_stream_pay() — the contractor's own My Shifts earnings page. On the
-- performance pages the dropped column is gmv_cents, so reported revenue reads
-- $0 for the missing sessions.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES (and what it deliberately does NOT do)
-- ---------------------------------------------------------------------------
--
-- The app-side half of the fix is to read these functions in 1000-row PAGES
-- via src/lib/supabase/fetchAll.ts, the helper written for this exact bug after
-- the calendar incident.
--
-- Paging with PostgREST's Range header is only CORRECT if the underlying result
-- has a deterministic total order. Without one, page 2 can repeat rows from
-- page 1 or skip rows entirely — which would turn a truncation bug into a
-- duplication bug, i.e. from underpaying into overpaying. So the ordering has
-- to exist in the database before the paging code can be trusted.
--
-- That is all this migration does: it adds `ORDER BY <primary key>` to the five
-- pay accessors. `id` is the primary key on every one of these tables, so the
-- order is total (no ties) and stable across calls.
--
-- Signatures, arguments, return types, permissions and the WHERE clauses are
-- UNCHANGED, byte for byte. In particular every `WHERE public.is_admin()` and
-- the `WHERE h.user_id = auth.uid()` ownership test on get_my_stream_pay are
-- reproduced exactly. This migration cannot change WHO can read WHAT — only the
-- order rows come back in.
--
-- APPLY ORDER: after 055 (which defines these functions). Independent of 063.
-- Safe to apply BEFORE or AFTER the application deploy, and the two do not have
-- to be simultaneous:
--   * Applied first, old code still running: callers still fetch one page, but
--     now get a DETERMINISTIC 1000 rows instead of a shifting sample. Strictly
--     better than today — the numbers stop moving between refreshes, though
--     they are still incomplete until the code lands.
--   * Code deployed first, migration not yet applied: the paging code runs
--     against unordered functions, which is the one combination to avoid. So
--     APPLY THIS MIGRATION FIRST if you are doing them separately.
--
-- No data is read, written or modified. Safe to re-run.
--
-- ROLLBACK: re-apply migration 055 verbatim (it CREATE OR REPLACEs all five of
-- these). Note that rolling back while the paging code is deployed reintroduces
-- the ordering hazard described above — roll the code back too.

-- ---------------------------------------------------------------------------
-- 1. The one that matters: per-stream frozen host rate + session GMV
-- ---------------------------------------------------------------------------
-- Identical to 055:76-83 apart from the trailing ORDER BY.
CREATE OR REPLACE FUNCTION public.admin_stream_pay()
RETURNS TABLE(id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  WHERE public.is_admin()
  ORDER BY s.id;
$$;

COMMENT ON FUNCTION public.admin_stream_pay() IS
  'Per-stream frozen host rate + GMV, admin-only. Returns EVERY stream, so it exceeds PostgREST max_rows (1000) — callers MUST page it with fetchAllRows(). ORDER BY id (migration 064) is what makes that paging correct; do not remove it.';

-- ---------------------------------------------------------------------------
-- 2. The caller's OWN shift pay (My Shifts). Same defect, per-user scope.
-- ---------------------------------------------------------------------------
-- A worker crosses 1000 stream rows in roughly a year — the same horizon
-- my-shifts/page.tsx already documents for its own streams query, which IS
-- paged. This function covered the same row set and was not.
-- Identical to 055:51-59 apart from the trailing ORDER BY.
CREATE OR REPLACE FUNCTION public.get_my_stream_pay()
RETURNS TABLE(stream_id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  JOIN public.hosts h ON h.id = s.host_id
  WHERE h.user_id = auth.uid()
  ORDER BY s.id;
$$;

COMMENT ON FUNCTION public.get_my_stream_pay() IS
  'Caller''s own frozen shift pay + GMV. Unbounded in time, so it can exceed PostgREST max_rows for a long-tenured worker — callers MUST page it. ORDER BY id (migration 064) makes that paging correct.';

-- ---------------------------------------------------------------------------
-- 3-5. The roster/pricing maps
-- ---------------------------------------------------------------------------
-- These are bounded in practice by how many hosts, moderators and brands exist,
-- so they are nowhere near 1000 today and are NOT currently broken. Ordering
-- them anyway, for two reasons: it costs nothing on tables this size, and it
-- means a caller that pages them later (or a roster that grows past 1000) is
-- correct by construction rather than by luck.
-- Identical to 055:65-73 and 055:86-91 apart from the trailing ORDER BY.

CREATE OR REPLACE FUNCTION public.admin_host_rate_map()
RETURNS TABLE(host_id UUID, rate_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT h.id, h.rate_cents FROM public.hosts h WHERE public.is_admin() ORDER BY h.id; $$;

CREATE OR REPLACE FUNCTION public.admin_moderator_rate_map()
RETURNS TABLE(moderator_id UUID, rate_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT m.id, m.rate_cents FROM public.moderators m WHERE public.is_admin() ORDER BY m.id; $$;

CREATE OR REPLACE FUNCTION public.admin_brand_pricing()
RETURNS TABLE(brand_id UUID, client_rate_cents INT, contracted_hours_per_month INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT b.id, b.client_rate_cents, b.contracted_hours_per_month
  FROM public.brands b
  WHERE public.is_admin()
  ORDER BY b.id;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) All five functions carry an ORDER BY (expect 5 rows, ordered = true):
--
--       SELECT p.proname, pg_get_functiondef(p.oid) ILIKE '%order by%' AS ordered
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname = 'public'
--          AND p.proname IN ('admin_stream_pay','get_my_stream_pay',
--                            'admin_host_rate_map','admin_moderator_rate_map',
--                            'admin_brand_pricing')
--        ORDER BY p.proname;
--
-- (b) How bad the truncation actually was — compare the true row count against
--     the 1000 the API was returning. If n_streams > 1000, every admin pay
--     screen has been reading a partial map:
--
--       SELECT count(*) AS n_streams,
--              count(*) FILTER (WHERE host_rate_cents IS NOT NULL) AS n_frozen,
--              greatest(count(*) - 1000, 0) AS rows_the_api_was_dropping
--         FROM public.streams;
--
-- (c) Still admin-only (run as a non-admin; expect 0 rows, NOT an error):
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A NON-ADMIN user_id>","role":"authenticated"}';
--         SELECT count(*) FROM public.admin_stream_pay();
--       ROLLBACK;
--
-- (d) PAYROLL TIE-OUT. Because this changes what the pay screens can SEE, the
--     numbers are EXPECTED to move — that is the fix working. Export the
--     payroll CSV for a closed month BEFORE applying, and again after the code
--     deploy. Differences should be explainable as "this shift now uses its
--     frozen rate instead of the host's current rate". If a total moves for a
--     month where nobody's rate ever changed, stop and investigate.
