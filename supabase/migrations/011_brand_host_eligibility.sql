-- ============================================================
-- Brand × Host eligibility
-- ============================================================
-- Admins control which hosts can see and book on which brand calendars.
-- Existing hosts are backfilled with access to every existing brand so
-- the new constraint doesn't suddenly lock anyone out.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.brand_hosts (
  brand_id   UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  host_id    UUID NOT NULL REFERENCES public.hosts(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, host_id)
);

CREATE INDEX IF NOT EXISTS idx_brand_hosts_host  ON public.brand_hosts(host_id);
CREATE INDEX IF NOT EXISTS idx_brand_hosts_brand ON public.brand_hosts(brand_id);

ALTER TABLE public.brand_hosts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brand_hosts: authenticated read" ON public.brand_hosts;
CREATE POLICY "brand_hosts: authenticated read"
  ON public.brand_hosts FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "brand_hosts: admin insert" ON public.brand_hosts;
CREATE POLICY "brand_hosts: admin insert"
  ON public.brand_hosts FOR INSERT
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "brand_hosts: admin delete" ON public.brand_hosts;
CREATE POLICY "brand_hosts: admin delete"
  ON public.brand_hosts FOR DELETE
  USING (public.is_admin());

-- Backfill: every existing (brand, host) pair gets eligibility
INSERT INTO public.brand_hosts (brand_id, host_id)
SELECT b.id, h.id
FROM public.brands b CROSS JOIN public.hosts h
ON CONFLICT (brand_id, host_id) DO NOTHING;

-- Update book_shift to enforce eligibility
CREATE OR REPLACE FUNCTION public.book_shift(
  p_brand_id   UUID,
  p_start_time TIMESTAMPTZ,
  p_end_time   TIMESTAMPTZ
)
RETURNS public.streams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_id     UUID;
  v_brand       public.brands;
  v_existing    public.streams;
  v_minutes     INT;
  v_block_index INT;
  v_dow         INT;
  v_blocked     BOOLEAN;
  v_eligible    BOOLEAN;
  v_result      public.streams;
BEGIN
  IF p_end_time <= NOW() THEN
    RAISE EXCEPTION 'Cannot book a shift that has already ended';
  END IF;

  SELECT id INTO v_host_id
  FROM public.hosts
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You do not have a host profile linked to your account';
  END IF;

  -- Eligibility: host must be assigned to this brand
  SELECT EXISTS (
    SELECT 1 FROM public.brand_hosts WHERE brand_id = p_brand_id AND host_id = v_host_id
  ) INTO v_eligible;

  IF NOT v_eligible THEN
    RAISE EXCEPTION 'You are not assigned to this brand';
  END IF;

  SELECT * INTO v_brand FROM public.brands WHERE id = p_brand_id;
  IF v_brand.id IS NULL THEN
    RAISE EXCEPTION 'Brand not found';
  END IF;

  v_minutes := EXTRACT(HOUR FROM p_start_time AT TIME ZONE 'UTC')::int * 60
             + EXTRACT(MINUTE FROM p_start_time AT TIME ZONE 'UTC')::int;
  v_block_index := (v_minutes - v_brand.day_start_minutes) / v_brand.block_size_minutes;
  v_dow := EXTRACT(DOW FROM p_start_time AT TIME ZONE 'UTC')::int;

  SELECT is_blocked INTO v_blocked
  FROM public.brand_shift_rates
  WHERE brand_id = p_brand_id AND day_of_week = v_dow AND block_index = v_block_index;

  IF v_blocked IS TRUE THEN
    RAISE EXCEPTION 'This shift is blocked';
  END IF;

  SELECT * INTO v_existing
  FROM public.streams
  WHERE brand_id = p_brand_id AND start_time = p_start_time;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.host_id IS NOT NULL AND v_existing.host_id <> v_host_id THEN
      RAISE EXCEPTION 'This shift already has a host';
    END IF;
    UPDATE public.streams SET host_id = v_host_id WHERE id = v_existing.id RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.streams (brand_id, host_id, start_time, end_time, created_by)
    VALUES (p_brand_id, v_host_id, p_start_time, p_end_time, auth.uid())
    RETURNING * INTO v_result;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_shift(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
