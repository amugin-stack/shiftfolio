-- ============================================================
-- Per-brand hourly rate for shifts
-- ============================================================
-- Stored as integer cents to avoid floating-point issues.
-- Default 2000 cents = $20.00/hour.
-- ============================================================

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS hourly_rate_cents INT NOT NULL DEFAULT 2000;

ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_valid_hourly_rate;
ALTER TABLE public.brands
  ADD CONSTRAINT brands_valid_hourly_rate CHECK (hourly_rate_cents >= 0);
