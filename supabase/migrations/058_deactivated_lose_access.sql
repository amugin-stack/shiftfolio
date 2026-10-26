-- 058_deactivated_lose_access.sql
--
-- INTENT (the support team, 2026-08-25): deactivating a host or moderator (migration 054)
-- removed them from rosters and assignment dropdowns, but left their LOGIN
-- fully working — a removed worker could still sign in and read their old
-- shifts. This revokes read access at the database, so it holds even against a
-- raw PostgREST call that bypasses the UI.
--
-- The app-side gate in (dashboard)/layout.tsx is the UX half; per CLAUDE.md
-- rule 26 the UI is never the boundary. This migration is the boundary.
--
-- WHAT CHANGES: exactly two branches of the streams SELECT policy — the host
-- branch and the moderator branch each gain `AND is_active`. Every other
-- branch (admin, brand owner, producer-by-id, created_by, producer-sees-all)
-- is reproduced BYTE-FOR-BYTE from migration 052. This is a narrowing change:
-- it can only remove access, never grant it.
--
-- NOT AFFECTED:
--   * Admins and producers — no is_active column on those roles.
--   * Payroll, dashboards, exports — all admin-side, and admins match on the
--     is_admin() branch, so a deactivated worker's HISTORY stays fully visible
--     to admins. That is the whole point of soft-delete (054): the person
--     loses access, the record does not.
--   * `created_by = auth.uid()` still stands; a deactivated worker never
--     created streams (writes are admin-only since 051), so this is not a
--     bypass in practice.
--
-- APPLY ORDER: after 052 (which defines this policy name) and after 054 (which
-- adds is_active). Independent of 055/056/057. RLS SELECT policies are
-- last-writer-wins on the name, so if the agent2migrations batch is ever
-- re-run it will clobber this — re-apply 058 afterwards.
--
-- ROLLBACK: re-run migration 052 verbatim to restore the previous policy.
-- (The dropped legacy `streams_select` policy need not be restored — it was a
-- strict subset of 052's policy, so 052 alone returns access to exactly what
-- it was before. Its full text is in migration 001 if ever needed.)
--
-- VERIFY AFTER APPLYING — the check that actually matters is that NO remaining
-- SELECT policy on streams grants host access without an is_active test:
--   SELECT policyname, qual LIKE '%is_active%' AS guarded
--     FROM pg_policies
--    WHERE schemaname='public' AND tablename='streams' AND cmd='SELECT';
-- Expect exactly two rows: "streams: read own or admin" (guarded = true) and
-- "streams: producer read all" (false, correctly — producers have no
-- is_active concept). A third row means another bypass exists.

-- ---------------------------------------------------------------------------
-- FIRST: remove the redundant legacy policy, or none of this works
-- ---------------------------------------------------------------------------
--
-- `streams_select` is the original policy from migration 001. Postgres OR's
-- permissive SELECT policies together, so a row is visible if ANY of them
-- allows it. That policy grants a host access via hosts.user_id with NO
-- is_active check:
--
--     OR auth.uid() IN (SELECT user_id FROM hosts
--                        WHERE id = streams.host_id AND user_id IS NOT NULL)
--
-- Until 058, it was a harmless strict SUBSET of "streams: read own or admin"
-- and dropping it would have changed nothing. The moment 058 narrows the main
-- policy with `AND is_active`, this one stops being a subset and becomes a
-- BYPASS — a deactivated host would keep full access while the main policy
-- looked correctly locked down. Verifying only the main policy would show a
-- green light on a door that is still open.
--
-- So dropping it is REQUIRED for this migration to mean anything, not a
-- tidy-up. (chore/hardening-correctness also drops it as migration 056 for
-- cleanliness reasons; whichever lands first, `DROP ... IF EXISTS` makes the
-- other a no-op.)
DROP POLICY IF EXISTS "streams_select" ON public.streams;

DROP POLICY IF EXISTS "streams: read own or admin" ON public.streams;

CREATE POLICY "streams: read own or admin"
  ON public.streams FOR SELECT
  USING (
    public.is_admin()
    OR auth.uid() IN (
      -- Host branch: now requires the host record to still be ACTIVE.
      SELECT user_id FROM public.hosts
        WHERE id = streams.host_id AND user_id IS NOT NULL AND is_active
      UNION
      SELECT user_id FROM public.brands
        WHERE id = streams.brand_id AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.producers
        WHERE id = streams.producer_id AND user_id IS NOT NULL
      UNION
      -- Moderator branch: same requirement.
      SELECT user_id FROM public.moderators
        WHERE id = streams.moderator_id AND user_id IS NOT NULL AND is_active
    )
    OR created_by = auth.uid()
    -- Producers (only) keep broad visibility into every stream — unchanged
    -- from 052. Producers have no is_active concept.
    OR EXISTS (SELECT 1 FROM public.producers WHERE user_id = auth.uid())
  );

-- Same treatment for the extra-pay slots introduced in 057, so a deactivated
-- host cannot read their old setup/training/office-hours pay either. Admin
-- read is untouched.
DROP POLICY IF EXISTS "extra_pay: host reads own" ON public.extra_pay_slots;
CREATE POLICY "extra_pay: host reads own"
  ON public.extra_pay_slots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.hosts h
      WHERE h.id = extra_pay_slots.host_id
        AND h.user_id = auth.uid()
        AND h.user_id IS NOT NULL
        AND h.is_active
    )
  );
