-- ============================================================
-- Admins can delete any shift, past or future.
-- ============================================================
-- Previously (migrations 016 + 018) the DELETE policy was scoped
-- to "future only" — admins couldn't remove historical streams
-- even when explicitly trying to. Removing that time-gate so
-- admins can fully manage the schedule.
--
-- Past streams are still preserved by default (nothing auto-deletes
-- them); this just lets admins clean up if they want to.
-- ============================================================

DROP POLICY IF EXISTS "streams: admin delete future only" ON public.streams;
DROP POLICY IF EXISTS "streams: admin delete"             ON public.streams;

CREATE POLICY "streams: admin delete"
  ON public.streams FOR DELETE
  USING (public.is_admin());
