-- 061_lock_pay_columns_revoke.sql
--
-- Part 2 of 2 of the pay/pricing column lock. Migration 055 created the
-- accessor functions (additive, safe alone); this file performs the actual
-- REVOKE, and is the step that closes the leak.
--
-- THE LEAK THIS CLOSES: hosts/moderators/brands/streams each had a blanket
-- `USING (auth.role() = 'authenticated')` SELECT policy and NO column grants
-- anywhere in the schema, so ANY logged-in user could issue one HTTP request
-- and read every contractor's pay rate, email and phone, plus all client
-- pricing. A brand login could read other brands' pricing; a producer could
-- read frozen payroll rates and revenue on every stream.
--
-- ⚠️ APPLY ONLY AFTER the rerouted app code is DEPLOYED. Until then the live
--   code still selects these columns, and PostgREST ERRORS the whole query on
--   a revoked column rather than returning null — so applying this early takes
--   down admin payroll pages, dashboards and rosters. Order:
--     1. migration 055 applied
--     2. code merged AND deployed (verify the site works)
--     3. THIS FILE
--     4. payroll tie-out, then confirm the leak is closed (see bottom)
--
-- ⚠️ FRAGILITY: the GRANTs below are explicit allow-lists. Any FUTURE migration
--   that ADDS a column to hosts/moderators/brands/streams MUST add it here too,
--   or reads of that new column fail for every non-service caller.
--
-- ROLLBACK (reopens the leak, but restores service instantly):
--   GRANT SELECT ON public.hosts      TO authenticated;
--   GRANT SELECT ON public.moderators TO authenticated;
--   GRANT SELECT ON public.brands     TO authenticated;
--   GRANT SELECT ON public.streams    TO authenticated;

-- ---------- Column locks ----------
-- Pattern: drop the blanket table SELECT for `authenticated`, then grant back
-- only the non-sensitive columns. RLS row filters continue to apply on top.
-- (Column-level REVOKE alone is ineffective while a table-level SELECT grant
-- exists, so we replace the table grant with a column grant.)

-- Drop the blanket table SELECT for `authenticated`, then grant back exactly
-- the non-sensitive columns. RLS row filters continue to apply on top.
-- (A column-level REVOKE alone is ineffective while a table-level SELECT grant
-- exists, so the table grant must be REPLACED by a column grant.)
--
-- These lists were generated from the LIVE schema, not from the migration
-- files, because the two had drifted: migration 030 (summary/verified) was
-- never applied, and three columns existed that no migration list knew about.
-- A column grant is deny-by-default, so a list built from the files would have
-- made real columns unreadable and left a real pricing column exposed.

REVOKE SELECT ON public.hosts FROM authenticated;
GRANT SELECT (id, name, email, user_id, created_at, email_disabled_at,
              email_disabled_reason, phone, sms_consent, sms_consent_at, is_active)
  ON public.hosts TO authenticated;
-- LOCKED: rate_cents

REVOKE SELECT ON public.moderators FROM authenticated;
GRANT SELECT (id, name, email, user_id, created_at, email_disabled_at,
              email_disabled_reason, phone, sms_consent, sms_consent_at, is_active)
  ON public.moderators TO authenticated;
-- LOCKED: rate_cents

REVOKE SELECT ON public.brands FROM authenticated;
GRANT SELECT (id, name, email, user_id, created_at, block_size_minutes,
              day_start_minutes, day_end_minutes, logo_path, producer_id, color)
  ON public.brands TO authenticated;
-- LOCKED: client_rate_cents, contracted_hours_per_month, and billing_rate_cents.
-- billing_rate_cents was NOT in the original migration's lock list: it postdates
-- it and no code reads it, so the lock as first written would have closed three
-- pricing columns and left a fourth wide open. Caught by diffing the grant list
-- against the live schema before applying.

REVOKE SELECT ON public.streams FROM authenticated;
GRANT SELECT (id, title, brand_id, host_id, start_time, end_time, notes,
              created_by, created_at, producer_id, moderator_id, reminder_sent_at)
  ON public.streams TO authenticated;
-- LOCKED: host_rate_cents, gmv_cents

-- ---------------------------------------------------------------------------
-- VERIFY THE LEAK IS ACTUALLY CLOSED (run as a real host, not as admin)
-- ---------------------------------------------------------------------------
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims = '{"sub":"<A REAL HOST user_id>","role":"authenticated"}';
--   -- EXPECT: permission denied for column rate_cents  (this failing IS the pass)
--   SELECT rate_cents FROM public.hosts LIMIT 1;
-- ROLLBACK;
--
-- And confirm normal reads still work for that same host:
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims = '{"sub":"<same user_id>","role":"authenticated"}';
--   SELECT count(*) FROM public.streams;   -- unchanged from before
--   SELECT count(*) FROM public.hosts;     -- unchanged from before
-- ROLLBACK;
