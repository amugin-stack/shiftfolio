-- 066_lock_contact_columns.sql
--
-- INTENT: stop every signed-in user from being able to download the company's
-- entire contractor contact list.
--
-- ---------------------------------------------------------------------------
-- THE LEAK
-- ---------------------------------------------------------------------------
--
-- The SELECT policies on `hosts` (migration 001) and `moderators` (026) are:
--
--     USING (auth.role() = 'authenticated')
--
-- i.e. any signed-in user may read every row. Migration 061 then replaced the
-- blanket table grant with a column grant to lock `rate_cents` — but it
-- deliberately re-granted `email` and `phone`.
--
-- So today, ANY authenticated user — a host, a moderator with a single shift,
-- a producer, or a contractor deactivated yesterday whose JWT has not yet
-- expired (058 revokes table access, not the token) — can run
--
--     GET /rest/v1/hosts?select=name,email,phone
--
-- against the public API with their own bearer token and receive the name,
-- email address and mobile number of every host in the company. Repeat against
-- /rest/v1/moderators for the rest. No app UI is involved and nothing is
-- logged as unusual.
--
-- Migration 059's header noted a "hosts/brands read leak" and filed it under
-- the pay/pricing work; 055/061 then closed the pay half and left the PII half
-- open. This closes it. Note the app has been careful about this for a while —
-- the brand calendar page has a long comment explaining why it selects only
-- `id, name` — but care in the app is not a boundary while the database will
-- hand the same columns to anyone who asks directly (CLAUDE.md rule 26).
--
-- ---------------------------------------------------------------------------
-- WHY COLUMN GRANTS RATHER THAN A NARROWER RLS POLICY
-- ---------------------------------------------------------------------------
--
-- A row-level rule ("you may read a host only if you share a brand") sounds
-- tighter, but it would break the app: the brand calendar serialises the full
-- ACTIVE host and moderator lists to populate assignment dropdowns for admins,
-- producers AND moderators. Narrowing rows would empty those dropdowns.
--
-- The problem was never WHICH ROWS are visible — names have to be. It is WHICH
-- COLUMNS. So this uses the exact pattern migration 061 established for
-- rate_cents: replace the table grant with a column grant that omits the
-- sensitive columns, and hand the omitted ones back to admins through a
-- SECURITY DEFINER accessor.
--
-- That indirection is necessary, not decorative: admins connect as the SAME
-- `authenticated` Postgres role as everyone else, so a column grant cannot tell
-- them apart. Only a SECURITY DEFINER function, which runs as the owner and can
-- test is_admin() in its body, can.
--
-- >>> Column grants are DENY-BY-DEFAULT, and requesting a revoked column makes
-- >>> PostgREST fail the ENTIRE query rather than return null. So the grant list
-- >>> below decides both what stays readable AND what breaks. It is reproduced
-- >>> from migration 061's live-schema-derived list, minus exactly `email` and
-- >>> `phone`. Do not retype it from the type definitions.
--
-- VERIFIED SAFE — every reader of these two columns was enumerated first:
--   * The notification emails are sent by Edge Functions
--     (send-notification-email, resend-webhook) using SUPABASE_SERVICE_ROLE_KEY,
--     which bypasses column grants entirely. Email delivery is UNAFFECTED.
--   * Database triggers are SECURITY DEFINER and run as owner. UNAFFECTED.
--   * In the app, only the admin Hosts and Moderators roster pages read these
--     columns. Both are rewired in the same branch to merge them from the new
--     accessors, exactly as they already do for rate_cents.
--   * There is no `select('*')` on either table anywhere in src/ — checked.
--
-- APPLY ORDER: after 061 (establishes the column-grant baseline this edits).
-- Independent of 063/064/065.
--
-- >>> DEPLOY ORDER MATTERS: APPLY THIS **AFTER** THE CODE DEPLOY. <<<
-- The currently-deployed code selects email and phone via HOST_PUBLIC_COLUMNS /
-- MODERATOR_PUBLIC_COLUMNS. Applying this first would make the admin Hosts and
-- Moderators pages fail outright (PostgREST errors the whole query) until the
-- new code lands. Deploy the branch, confirm both roster pages load, then apply
-- this. The leak has been open for months; a few more minutes is the correct
-- trade against breaking the roster pages.
--
-- ROLLBACK: re-run migration 061's hosts/moderators grant block verbatim (it
-- re-adds email and phone), then DROP the two functions created here:
--   DROP FUNCTION IF EXISTS public.admin_host_contacts();
--   DROP FUNCTION IF EXISTS public.admin_moderator_contacts();
--
-- No data is read, written or modified. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Lock the columns
-- ---------------------------------------------------------------------------
-- Same list as 061, minus email and phone. RLS row filters still apply on top.

REVOKE SELECT ON public.hosts FROM authenticated;
GRANT SELECT (id, name, user_id, created_at, email_disabled_at,
              email_disabled_reason, sms_consent, sms_consent_at, is_active)
  ON public.hosts TO authenticated;
-- LOCKED: rate_cents (061), email, phone (066)

REVOKE SELECT ON public.moderators FROM authenticated;
GRANT SELECT (id, name, user_id, created_at, email_disabled_at,
              email_disabled_reason, sms_consent, sms_consent_at, is_active)
  ON public.moderators TO authenticated;
-- LOCKED: rate_cents (061), email, phone (066)

-- NOTE: only SELECT is revoked. INSERT and UPDATE on email/phone are untouched,
-- so admins can still SET a contact detail — they just cannot read it back
-- through the table. The roster pages read it through the accessors below, and
-- the managers re-attach the value they just wrote into local state (the same
-- thing they already do for rate_cents).

-- ---------------------------------------------------------------------------
-- 2. Admin-only accessors
-- ---------------------------------------------------------------------------
-- Empty (not an error) for non-admins, matching the 055 accessors' behaviour.
-- ORDER BY id so these are safe to page with fetchAllRows if the roster ever
-- exceeds PostgREST's 1000-row cap — the lesson of migration 064.

CREATE OR REPLACE FUNCTION public.admin_host_contacts()
RETURNS TABLE(host_id UUID, email TEXT, phone TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT h.id, h.email, h.phone
  FROM public.hosts h
  WHERE public.is_admin()
  ORDER BY h.id;
$$;

CREATE OR REPLACE FUNCTION public.admin_moderator_contacts()
RETURNS TABLE(moderator_id UUID, email TEXT, phone TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT m.id, m.email, m.phone
  FROM public.moderators m
  WHERE public.is_admin()
  ORDER BY m.id;
$$;

REVOKE ALL ON FUNCTION public.admin_host_contacts()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_moderator_contacts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_host_contacts()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_moderator_contacts() TO authenticated;

COMMENT ON FUNCTION public.admin_host_contacts() IS
  'Admin-only host email/phone. These columns are revoked from `authenticated` (migration 066) because the hosts SELECT policy lets ANY signed-in user read every row. Empty for non-admins.';
COMMENT ON FUNCTION public.admin_moderator_contacts() IS
  'Admin-only moderator email/phone. See migration 066.';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) THE LEAK IS SHUT. Run as a real NON-ADMIN (a host or moderator user_id).
--     EXPECT: "permission denied for column email". The error IS the pass.
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<A NON-ADMIN user_id>","role":"authenticated"}';
--         SELECT email, phone FROM public.hosts LIMIT 1;   -- must ERROR
--       ROLLBACK;
--
--     Repeat for public.moderators.
--
-- (b) NORMAL READS STILL WORK for that same non-admin — this is the regression
--     check. If (a) passes but (b) errors, the app is broken for everyone.
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<same NON-ADMIN user_id>","role":"authenticated"}';
--         SELECT id, name, is_active FROM public.hosts LIMIT 5;      -- must WORK
--         SELECT id, name, is_active FROM public.moderators LIMIT 5; -- must WORK
--         SELECT count(*) FROM public.admin_host_contacts();         -- expect 0
--       ROLLBACK;
--
-- (c) ADMINS can still get contacts, through the accessor only:
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<AN ADMIN user_id>","role":"authenticated"}';
--         SELECT count(*) FROM public.admin_host_contacts();       -- = number of hosts
--         SELECT count(*) FROM public.admin_moderator_contacts();  -- = number of moderators
--         SELECT email FROM public.hosts LIMIT 1;                  -- still ERRORS, correctly
--       ROLLBACK;
--
--     That last line is not a bug: admins share the `authenticated` role, so the
--     column stays locked for them too. The accessor is how they read it.
--
-- (d) Confirm the final grant state on both tables:
--
--       SELECT table_name, column_name
--         FROM information_schema.column_privileges
--        WHERE grantee = 'authenticated' AND privilege_type = 'SELECT'
--          AND table_schema = 'public' AND table_name IN ('hosts','moderators')
--        ORDER BY table_name, column_name;
--
--     Neither `email`, `phone` nor `rate_cents` may appear.
--
-- (e) IN THE APP, after deploying: open Admin -> Hosts and Admin -> Moderators.
--     Both tables must still show email and phone. Edit someone's phone number,
--     save, and confirm the new value shows in the row afterwards.
