-- 065_request_brand_requires_active_host.sql
--
-- INTENT: close the last write path a deactivated worker retains, and make sure
-- closing it cannot resurrect their host record.
--
-- BACKGROUND. Migration 054 added soft-delete. 058/059 revoked a deactivated
-- host's READ access to streams. 062 closed set_session_gmv, and its header
-- argued the deactivation model should have no remaining write paths. It missed
-- this one.
--
-- `request_brand` (migration 023) resolves the caller's host record with
-- `WHERE user_id = v_user_id` and no is_active test anywhere in the function.
-- So a contractor removed from the roster yesterday -- whose session is still
-- alive, since deactivation revokes table access, not their JWT -- can still
-- call POST /rest/v1/rpc/request_brand and have it succeed. The function then
-- fans a brand_request notification out to EVERY admin, and migration 039's
-- trigger turns each of those rows into a real Resend email. A removed worker
-- can generate admin email at will.
--
-- WHY THE GUARD GOES BEFORE THE LOOKUP, NOT INSIDE IT. The obvious fix is to
-- add `AND is_active` to the SELECT. That would be WRONG here. The function is
-- find-or-create: if the lookup returns nothing it INSERTs a new hosts row.
-- Filtering the lookup would make a deactivated caller miss their own row, fall
-- into the create branch, and receive a brand new ACTIVE hosts row -- silently
-- undoing the deactivation, and colliding with migration 060's unique index on
-- hosts.user_id. Rejecting up front is the only version that cannot resurrect
-- them.
--
-- WHAT CHANGES: one guard, inserted immediately after the existing
-- "Not signed in" check and before any lookup or write. The rest of the
-- function was taken programmatically from 023 and asserted byte-identical --
-- same return type, same error strings, same branch order, same notification
-- columns. It fires only when a hosts row EXISTS and is inactive, so a
-- brand-new user with no hosts row still gets one created exactly as before.
-- Admins and producers are unaffected (no is_active concept on those roles).
--
-- APPLY ORDER: after 023 (defines the function) and 054 (adds is_active).
-- Independent of 063 and 064. No data is modified. Safe to re-run.
--
-- ROLLBACK: re-apply the request_brand function from
-- supabase/migrations/023_brand_request_system.sql verbatim.
--
-- NOTE -- the app-side half. `/onboarding/*` sits OUTSIDE the (dashboard) route
-- group, so the "Access removed" screen in (dashboard)/layout.tsx never runs
-- for it: a deactivated user can still load /onboarding/brands and edit their
-- PII at /onboarding/profile. That gate is added in the same branch as this
-- migration. This migration is the real boundary; the layout is the UX half
-- (CLAUDE.md rule 26).

CREATE OR REPLACE FUNCTION public.request_brand(p_brand_id UUID)
RETURNS public.brand_host_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_host_id     UUID;
  v_host_name   TEXT;
  v_brand_name  TEXT;
  v_request     public.brand_host_requests;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  -- Deactivated workers may not request brands (migration 065).
  --
  -- Checked BEFORE the find-or-create below, deliberately. Filtering that
  -- lookup with `AND is_active` instead would fall through to the auto-create
  -- branch and mint a fresh ACTIVE hosts row for someone who was deliberately
  -- removed -- silently undoing the deactivation, and colliding with migration
  -- 060's unique index on hosts.user_id. Rejecting up front is the only
  -- version that cannot resurrect them.
  --
  -- Fires only when a hosts row EXISTS and is inactive, so a brand-new user
  -- with no hosts row is untouched and still gets one created below.
  IF EXISTS (
    SELECT 1 FROM public.hosts h
    WHERE h.user_id = v_user_id AND NOT h.is_active
  ) THEN
    RAISE EXCEPTION 'Your account is no longer active';
  END IF;

  -- Find or auto-create a hosts row for this user
  SELECT id, name INTO v_host_id, v_host_name
  FROM public.hosts WHERE user_id = v_user_id LIMIT 1;

  IF v_host_id IS NULL THEN
    INSERT INTO public.hosts (name, email, user_id)
    SELECT
      COALESCE(NULLIF(p.full_name, ''), p.email, 'New Host'),
      p.email,
      p.id
    FROM public.profiles p WHERE p.id = v_user_id
    RETURNING id, name INTO v_host_id, v_host_name;
  END IF;

  -- Already linked? Reject
  IF EXISTS (
    SELECT 1 FROM public.brand_hosts
    WHERE brand_id = p_brand_id AND host_id = v_host_id
  ) THEN
    RAISE EXCEPTION 'You are already linked to this brand';
  END IF;

  -- Already pending? Reject (uniqueness index also enforces this race-safely)
  IF EXISTS (
    SELECT 1 FROM public.brand_host_requests
    WHERE host_user_id = v_user_id AND brand_id = p_brand_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending request for this brand';
  END IF;

  -- Snapshot brand name
  SELECT name INTO v_brand_name FROM public.brands WHERE id = p_brand_id;
  IF v_brand_name IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  INSERT INTO public.brand_host_requests (host_user_id, brand_id)
  VALUES (v_user_id, p_brand_id)
  RETURNING * INTO v_request;

  -- Fan out a brand_request notification to every admin
  INSERT INTO public.notifications
    (recipient_id, type, actor_host_id, host_name, brand_id, brand_name, request_id)
  SELECT
    p.id, 'brand_request', v_host_id, COALESCE(v_host_name, 'New Host'),
    p_brand_id, v_brand_name, v_request.id
  FROM public.profiles p
  WHERE p.role = 'admin';

  RETURN v_request;
END;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) The guard is live:
--
--       SELECT pg_get_functiondef(p.oid) ILIKE '%no longer active%' AS guarded
--         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE n.nspname = 'public' AND p.proname = 'request_brand';
--
-- (b) A DEACTIVATED host is rejected. Pick a user_id from a hosts row with
--     is_active = false. EXPECT the error 'Your account is no longer active' --
--     the error firing IS the pass.
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<DEACTIVATED host user_id>","role":"authenticated"}';
--         SELECT public.request_brand('<ANY REAL brand uuid>');
--       ROLLBACK;
--
-- (c) An ACTIVE host is still allowed. This is the regression check that
--     matters: (b) passing while (c) ALSO errors would mean nobody can request
--     brands any more. Wrapped in ROLLBACK so no real request is created.
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<ACTIVE host user_id>","role":"authenticated"}';
--         SELECT public.request_brand('<a brand they are NOT already linked to>');
--       ROLLBACK;
--
-- (d) Nothing resurrected a host row:
--
--       SELECT user_id, count(*) FROM public.hosts
--        WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*) > 1;
--       -- expect 0 rows
