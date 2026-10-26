-- ============================================================
-- Per-brand shift block configuration
-- ============================================================
-- Each brand calendar gets configurable time-block "shifts":
--   block_size_minutes  - duration of one shift block (default 2hr)
--   day_start_minutes   - minutes since midnight when the day starts (default 12:00 = 720)
--   day_end_minutes     - minutes since midnight when the day ends   (default 24:00 = 1440)
--
-- The streams table is truncated since the user wants a clean slate
-- under the new shift-block model.
-- ============================================================

-- 1. Wipe existing streams (clean slate per user request)
TRUNCATE TABLE public.streams CASCADE;

-- 2. Add the three new columns to brands
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS block_size_minutes INT NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS day_start_minutes  INT NOT NULL DEFAULT 720,
  ADD COLUMN IF NOT EXISTS day_end_minutes    INT NOT NULL DEFAULT 1440;

-- 3. Sanity constraints
ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_valid_block_size;
ALTER TABLE public.brands
  ADD CONSTRAINT brands_valid_block_size CHECK (block_size_minutes BETWEEN 15 AND 1440);

ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_valid_day_window;
ALTER TABLE public.brands
  ADD CONSTRAINT brands_valid_day_window CHECK (
    day_start_minutes >= 0
    AND day_end_minutes > day_start_minutes
    AND day_end_minutes <= 1440
  );
