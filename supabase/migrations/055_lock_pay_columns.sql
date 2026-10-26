-- ============================================================
-- 055_lock_pay_columns.sql
--
-- INTENT (SECURITY — close the raw-API pay/pricing/PII read leak):
--   SELECT RLS on hosts/brands/moderators is row-level only (auth.role() =
--   'authenticated'), so any logged-in user can GET /rest/v1/hosts?select=*
--   and read every worker's pay rate + all client pricing. streams.host_rate_cents
--   / gmv_cents leak the same way to producers. This migration locks those
--   columns from the `authenticated` role and provides is_admin()/own-data
--   SECURITY DEFINER functions so admins and each user's own-pay views keep
--   working (app code reroutes to these — see feat/lock-pay-columns).
--
-- ⚠️ SPLIT INTO TWO MIGRATIONS so the cutover has NO broken window.
--   This file (055) is now ADDITIVE ONLY: it creates the accessor functions and
--   changes no permissions, so it is safe to apply at any time, before the code
--   ships. Migration 061 holds the actual column locks.
--
--   The reason for the split: applied together, either order breaks something.
--   Lock first and the still-deployed OLD code reads a revoked column (a
--   PostgREST error, not a null — the whole query fails). Deploy first and the
--   NEW code calls functions that do not exist yet. Splitting removes the
--   window entirely:
--     1. apply 055 (functions appear; nothing else changes)
--     2. merge + deploy the code (it uses the functions, which now exist;
--        columns are still readable so nothing can break)
--     3. apply 061 (columns lock; the code already stopped reading them)
--     4. payroll tie-out + confirm the leak is closed
--
-- ⚠️ FRAGILITY: the safe-column GRANTs below are explicit lists. Any FUTURE
--   migration that ADDS a column to hosts/moderators/brands/streams MUST add it
--   to the matching GRANT here, or reads of the new column break for non-service
--   callers. (CLAUDE.md rule 25.)
--
-- ROLLBACK: GRANT SELECT ON <each table> TO authenticated;  (reopens the leak)
--   and DROP the functions below. Revert the code reroute too.
-- ============================================================

-- ---------- Own-data accessors (identity via auth.uid()) ----------

-- Caller's own host + moderator hourly rates (null if they aren't one).
CREATE OR REPLACE FUNCTION public.get_my_pay_context()
RETURNS TABLE(host_rate_cents INT, moderator_rate_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    (SELECT h.rate_cents FROM public.hosts h      WHERE h.user_id = auth.uid() LIMIT 1),
    (SELECT m.rate_cents FROM public.moderators m WHERE m.user_id = auth.uid() LIMIT 1);
$$;

-- Frozen per-shift host pay + session GMV for the caller's OWN shifts only.
CREATE OR REPLACE FUNCTION public.get_my_stream_pay()
RETURNS TABLE(stream_id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  JOIN public.hosts h ON h.id = s.host_id
  WHERE h.user_id = auth.uid();
$$;

-- ---------- Admin-only accessors (empty unless is_admin()) ----------

CREATE OR REPLACE FUNCTION public.admin_host_rate_map()
RETURNS TABLE(host_id UUID, rate_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT h.id, h.rate_cents FROM public.hosts h WHERE public.is_admin(); $$;

CREATE OR REPLACE FUNCTION public.admin_moderator_rate_map()
RETURNS TABLE(moderator_id UUID, rate_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT m.id, m.rate_cents FROM public.moderators m WHERE public.is_admin(); $$;

-- Per-stream frozen host rate + gmv (payroll/dashboard/performance). Returns
-- every stream's pay for admins (empty otherwise); callers look up by stream id.
-- Just 3 small columns, admin-only, infrequent — no window needed.
CREATE OR REPLACE FUNCTION public.admin_stream_pay()
RETURNS TABLE(id UUID, host_rate_cents INT, gmv_cents INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.host_rate_cents, s.gmv_cents
  FROM public.streams s
  WHERE public.is_admin();
$$;

CREATE OR REPLACE FUNCTION public.admin_brand_pricing()
RETURNS TABLE(brand_id UUID, client_rate_cents INT, contracted_hours_per_month INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT b.id, b.client_rate_cents, b.contracted_hours_per_month
  FROM public.brands b WHERE public.is_admin();
$$;

REVOKE ALL ON FUNCTION public.get_my_pay_context()            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_stream_pay()             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_host_rate_map()           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_moderator_rate_map()      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_stream_pay()             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_brand_pricing()           FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_pay_context()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_stream_pay()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_host_rate_map()           TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_moderator_rate_map()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_stream_pay()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_brand_pricing()           TO authenticated;
