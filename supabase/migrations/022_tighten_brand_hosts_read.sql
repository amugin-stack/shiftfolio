-- ============================================================
-- Tighten brand_hosts SELECT policy: own host links + admins only.
-- ============================================================
-- Previously every authenticated user could enumerate the entire
-- brand_hosts table, surfacing which hosts work on which brands.
-- No UI exposed this, but a curious client could read it directly.
--
-- New policy: a user sees their own host's brand links (matched via
-- hosts.user_id = auth.uid()), and admins see everything.
--
-- Verified safe — every existing read site only ever filters to the
-- caller's own host_id, OR runs from an admin page. The streams
-- visibility policy from migration 021 contains an EXISTS subquery
-- against brand_hosts; that subquery only needs the caller's own
-- rows, which the new policy still allows.
-- ============================================================

DROP POLICY IF EXISTS "brand_hosts: authenticated read" ON public.brand_hosts;

CREATE POLICY "brand_hosts: own or admin"
  ON public.brand_hosts FOR SELECT
  USING (
    public.is_admin()
    OR host_id IN (SELECT id FROM public.hosts WHERE user_id = auth.uid())
  );
