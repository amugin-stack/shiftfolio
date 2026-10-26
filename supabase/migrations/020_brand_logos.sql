-- ============================================================
-- Brand logos: nullable column on brands + public storage bucket
-- ============================================================
-- Logos are non-sensitive marketing assets, so the bucket is public
-- (read-only by anonymous). Writes are admin-only via storage RLS.
-- Path convention: {brand_id}/logo.jpg
-- ============================================================

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS logo_path TEXT;

-- Public bucket — direct CDN URLs, no proxy needed for reads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brand-logos',
  'brand-logos',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS: anyone can read, only admins can write/update/delete.
DROP POLICY IF EXISTS "brand-logos: public read" ON storage.objects;
CREATE POLICY "brand-logos: public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'brand-logos');

DROP POLICY IF EXISTS "brand-logos: admin insert" ON storage.objects;
CREATE POLICY "brand-logos: admin insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'brand-logos' AND public.is_admin());

DROP POLICY IF EXISTS "brand-logos: admin update" ON storage.objects;
CREATE POLICY "brand-logos: admin update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'brand-logos' AND public.is_admin());

DROP POLICY IF EXISTS "brand-logos: admin delete" ON storage.objects;
CREATE POLICY "brand-logos: admin delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'brand-logos' AND public.is_admin());
