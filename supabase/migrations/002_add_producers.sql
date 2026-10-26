-- ============================================================
-- Add producers (mirrors hosts) and tie a producer to each stream
-- ============================================================

-- 1. producers table
CREATE TABLE IF NOT EXISTS public.producers (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  email      TEXT,
  user_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_producers_user_id ON public.producers(user_id);

-- 2. RLS — same pattern as hosts/brands
ALTER TABLE public.producers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "producers: authenticated read"
  ON public.producers FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "producers: admin insert"
  ON public.producers FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "producers: admin update"
  ON public.producers FOR UPDATE
  USING (public.is_admin());

CREATE POLICY "producers: admin delete"
  ON public.producers FOR DELETE
  USING (public.is_admin());

-- 3. Add producer_id to streams (nullable so existing rows survive)
ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS producer_id UUID REFERENCES public.producers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_streams_producer_id ON public.streams(producer_id);

-- 4. Update the streams SELECT policy so producers tied to a profile see their own streams
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
  );
