-- ============================================================
-- 052_streams_host_reads_own_only.sql
--
-- INTENT (SECURITY — close the host "sees other hosts' shifts" leak):
--   The "streams: read own or admin" SELECT policy contains a brand_hosts
--   clause that lets ANY host linked to a brand read EVERY stream on that
--   brand — i.e. rival hosts' shifts — via the raw PostgREST API. This is the
--   competition concern the support team raised (2026-07-21). Removing hosts from the
--   brand calendar UI did NOT close it; the data layer still returns those
--   rows. This migration recreates the policy WITHOUT the brand_hosts clause,
--   so a host reads only streams where they are the assigned host (the
--   host_id branch of the own-role UNION) — plus their own created rows.
--   Admin / brand-owner / producer / moderator-on-stream read paths are
--   preserved byte-for-byte. Producers keep full visibility (the broad
--   producer clause here + the separate "streams: producer read all" policy
--   from migration 051).
--
-- >>> APPLY ORDER <<<
--   The SAME policy name is also defined in the legacy agent2migrations/002
--   file WITH the brand_hosts clause. RLS SELECT policies are last-writer-wins
--   on the policy NAME, so this fix only holds if applied AFTER the
--   agent2migrations batch (already live in prod — the natural order). Alex is
--   sole engineer and applies migrations by hand in number order; just don't
--   re-run the agent2 batch after this one. This is a Tier-0 security boundary
--   (rule 6): before it reaches production, verify on staging that a host
--   token sees ONLY its own streams via GET /rest/v1/streams.
--
-- ROLLBACK: re-run agent2migrations/002's or 029's version of
--   "streams: read own or admin" (restores the brand_hosts clause = the leak).
-- ============================================================

DROP POLICY IF EXISTS "streams: read own or admin" ON public.streams;

CREATE POLICY "streams: read own or admin"
  ON public.streams FOR SELECT
  USING (
    public.is_admin()
    OR auth.uid() IN (
      SELECT user_id FROM public.hosts      WHERE id = streams.host_id      AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.brands     WHERE id = streams.brand_id     AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.producers  WHERE id = streams.producer_id  AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.moderators WHERE id = streams.moderator_id AND user_id IS NOT NULL
    )
    OR created_by = auth.uid()
    -- (removed) brand_hosts clause: previously let a host read every stream on
    -- any brand they're linked to — the cross-host visibility leak. A host now
    -- matches only via host_id above (their own assigned shifts).
    --
    -- Producers (only) keep broad visibility into every stream.
    -- Moderators are intentionally NOT broadened — they get only streams
    -- they're directly assigned to (the moderator_id branch above).
    OR EXISTS (SELECT 1 FROM public.producers WHERE user_id = auth.uid())
  );
