-- ============================================================
-- Hosts assigned to a brand can see ALL streams on that brand.
-- ============================================================
-- Bug: the previous policy (002_add_producers.sql) only let a host
-- see a stream if they were the host on that specific stream. Result:
-- a host's calendar looked empty because every other host's bookings
-- were filtered out by RLS. They couldn't tell which slots were taken,
-- couldn't see chain-locked / past cells, and would try to book over
-- existing shifts (only to be rejected by book_shift).
--
-- Fix: extend the SELECT policy so any host who's assigned to the
-- brand (via brand_hosts) can see all of that brand's streams. Read
-- access only — booking and cancelling still go through the RPCs that
-- enforce ownership and adjacency.
-- ============================================================

DROP POLICY IF EXISTS "streams: read own or admin" ON public.streams;

CREATE POLICY "streams: read own or admin"
  ON public.streams FOR SELECT
  USING (
    public.is_admin()
    OR auth.uid() IN (
      SELECT user_id FROM public.hosts     WHERE id = streams.host_id     AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.brands    WHERE id = streams.brand_id    AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM public.producers WHERE id = streams.producer_id AND user_id IS NOT NULL
    )
    OR created_by = auth.uid()
    -- Hosts assigned to this brand see every stream on the brand,
    -- so the calendar shows which slots are taken vs available.
    OR EXISTS (
      SELECT 1
      FROM public.brand_hosts bh
      JOIN public.hosts h ON h.id = bh.host_id
      WHERE bh.brand_id = streams.brand_id
        AND h.user_id = auth.uid()
    )
  );
