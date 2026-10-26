-- ============================================================
-- Brand color: how a brand appears on the master schedule
-- ============================================================
-- Admins can pick the color each brand renders as on the admin master
-- schedule. NULL means "no explicit color" — the app falls back to its index
-- palette (buildBrandColorMap), so existing brands look exactly as before until
-- a color is chosen. Stored as a #RRGGBB hex string; the CHECK keeps junk out.
-- Deliberately NOT added to BRAND_PUBLIC_COLUMNS — only the master-schedule page
-- selects `color` (explicitly), so the sidebar/layout queries don't hard-depend
-- on this migration being applied.
-- ============================================================

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_color_hex_chk;

ALTER TABLE public.brands
  ADD CONSTRAINT brands_color_hex_chk
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
