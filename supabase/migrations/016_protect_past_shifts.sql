-- ============================================================
-- Past shifts are permanent — admins can edit but not delete
-- ============================================================
-- Past shifts are the historical record of who actually worked when.
-- Replace the broad admin DELETE policy with one that requires
-- end_time > NOW(), so the database rejects deletion of past streams
-- even if the UI is bypassed. UPDATE permissions are unchanged so
-- admins can still correct who was assigned ("Mary covered for John").
-- ============================================================

DROP POLICY IF EXISTS "streams: admin delete" ON public.streams;

CREATE POLICY "streams: admin delete future only"
  ON public.streams FOR DELETE
  USING (public.is_admin() AND end_time > NOW());
