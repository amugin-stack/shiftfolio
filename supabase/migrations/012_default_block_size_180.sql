-- ============================================================
-- Default new brand calendars to 180-minute (3-hour) shift blocks
-- ============================================================
-- Day window stays 12:00 PM – 12:00 AM (720 → 1440 minutes), which
-- divides evenly into four 180-minute shifts. Existing brands keep
-- whatever they were configured with.
-- ============================================================

ALTER TABLE public.brands
  ALTER COLUMN block_size_minutes SET DEFAULT 180;
