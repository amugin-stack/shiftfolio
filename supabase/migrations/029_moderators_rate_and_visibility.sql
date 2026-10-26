-- ============================================================
-- Moderators v2: flat per-moderator rate + scoped stream visibility
-- ============================================================
-- Adds a `rate_cents` column to moderators (admin sets it), and
-- tightens the streams SELECT policy so moderators no longer see
-- every stream — only ones they're assigned to as moderator.
-- Producers keep their broad visibility (untouched).
-- ============================================================

ALTER TABLE public.moderators
  ADD COLUMN IF NOT EXISTS rate_cents INT NOT NULL DEFAULT 0
  CHECK (rate_cents >= 0);

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
    OR EXISTS (
      SELECT 1
      FROM public.brand_hosts bh
      JOIN public.hosts h ON h.id = bh.host_id
      WHERE bh.brand_id = streams.brand_id
        AND h.user_id = auth.uid()
    )
    -- Producers (only) keep broad visibility into every stream.
    -- Moderators are intentionally NOT in this clause — they get only
    -- streams they're directly assigned to.
    OR EXISTS (SELECT 1 FROM public.producers WHERE user_id = auth.uid())
  );
