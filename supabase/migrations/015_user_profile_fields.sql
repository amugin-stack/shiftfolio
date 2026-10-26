-- ============================================================
-- Required profile fields + private headshot storage bucket
-- ============================================================
-- Every account must complete a profile before reaching the app.
-- Headshots live in a private Supabase Storage bucket; access is
-- gated by RLS so only the owner (or an admin) can read each photo.
-- ============================================================

-- 1. New profile columns (all nullable in DB; "completion" enforced at app layer)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone         TEXT,
  ADD COLUMN IF NOT EXISTS height        TEXT,
  ADD COLUMN IF NOT EXISTS weight        TEXT,
  ADD COLUMN IF NOT EXISTS hair_color    TEXT,
  ADD COLUMN IF NOT EXISTS eye_color     TEXT,
  ADD COLUMN IF NOT EXISTS top_size      TEXT,
  ADD COLUMN IF NOT EXISTS bottom_size   TEXT,
  ADD COLUMN IF NOT EXISTS shoe_size     TEXT,
  ADD COLUMN IF NOT EXISTS headshot_path TEXT;

-- 2. Private storage bucket for headshots (5 MB limit, image MIME types)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'headshots',
  'headshots',
  false,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage RLS — path convention: {user_id}/avatar.{ext}
DROP POLICY IF EXISTS "headshots: user upload own folder" ON storage.objects;
CREATE POLICY "headshots: user upload own folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'headshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "headshots: user/admin view" ON storage.objects;
CREATE POLICY "headshots: user/admin view"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'headshots'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_admin()
    )
  );

DROP POLICY IF EXISTS "headshots: user update own" ON storage.objects;
CREATE POLICY "headshots: user update own"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'headshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "headshots: user delete own" ON storage.objects;
CREATE POLICY "headshots: user delete own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'headshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
