-- ============================================================
-- Moderators entity + broadened streams visibility for backstage staff
-- ============================================================
-- Producers and moderators are trusted backstage roles. They need to
-- see every brand's schedule but cannot book or cancel anything; that
-- stays with admins. Hosts retain their narrower per-brand visibility.
-- ============================================================

-- 1. moderators table (mirrors producers) ---------------------

CREATE TABLE IF NOT EXISTS public.moderators (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT,
  user_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderators_user_id ON public.moderators(user_id);

ALTER TABLE public.moderators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "moderators: authenticated read" ON public.moderators;
CREATE POLICY "moderators: authenticated read"
  ON public.moderators FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "moderators: admin insert" ON public.moderators;
CREATE POLICY "moderators: admin insert"
  ON public.moderators FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "moderators: admin update" ON public.moderators;
CREATE POLICY "moderators: admin update"
  ON public.moderators FOR UPDATE
  USING (public.is_admin());

DROP POLICY IF EXISTS "moderators: admin delete" ON public.moderators;
CREATE POLICY "moderators: admin delete"
  ON public.moderators FOR DELETE
  USING (public.is_admin());

-- 2. streams.moderator_id -------------------------------------

ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS moderator_id UUID REFERENCES public.moderators(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_streams_moderator_id ON public.streams(moderator_id);

-- 3. Streams SELECT policy: any producer or moderator user sees every stream

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
    -- Backstage staff: any producer or moderator user sees every stream.
    OR EXISTS (SELECT 1 FROM public.producers  WHERE user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.moderators WHERE user_id = auth.uid())
  );
