-- ============================================================
-- Access model: producers are VIEW-ONLY everywhere (admins schedule)
-- ============================================================
-- Product decision (the support team, 2026-07-21): producers may SEE every brand's
-- schedule but may NOT create / edit / add / delete anything. Only admins
-- schedule from now on. This REVERSES the producer-scheduler grants from
-- 035_producer_scheduler_access and agent2migrations/002_producer_brand_assignment.
--
-- Mechanism: neutralize the two "is this user allowed to write" helpers to
-- admin-only. EVERY producer write path keys off one of these, so this blocks
-- them all at once — streams writes, roster (hosts/producers/moderators)
-- writes, brand_hosts, brand shift rates/overrides, brands.update, and the
-- decide_brand_request / decide_cancellation_request / unbook_shift RPCs —
-- with no per-policy edits. Admin writes are unaffected (is_admin() unchanged);
-- host/moderator read paths are unaffected.
--
-- Plus: producers get READ on ALL brands' streams via an additive SELECT
-- policy (brands SELECT is already all-authenticated), so they can view every
-- brand schedule.
--
-- >>> APPLY ORDER <<<
-- is_brand_scheduler() and is_scheduler() are also defined in the legacy
-- agent2migrations/002 file. This migration overrides both, so it MUST be
-- applied AFTER the agent2migrations batch (which is already live in prod, so
-- this is the natural order). Alex is the sole engineer and applies every
-- migration by hand in number order — no coordination needed; just don't
-- re-run the agent2migrations batch after this one, or the override reverts.
--
-- Rollback: restore is_scheduler / is_brand_scheduler to their prior bodies
-- (035 / agent2/002) and DROP POLICY "streams: producer read all".
-- ============================================================

-- 1. Writes: producers are no longer schedulers — admin only.
CREATE OR REPLACE FUNCTION public.is_scheduler()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.is_admin(); $$;

CREATE OR REPLACE FUNCTION public.is_brand_scheduler(p_brand_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.is_admin(); $$;

-- 2. Reads: a producer can view EVERY brand's streams. Additive SELECT policy
--    (RLS SELECT is permissive/OR) — leaves the existing admin / host /
--    created_by / moderator read policies untouched.
DROP POLICY IF EXISTS "streams: producer read all" ON public.streams;
CREATE POLICY "streams: producer read all"
  ON public.streams FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.producers p WHERE p.user_id = auth.uid()));
