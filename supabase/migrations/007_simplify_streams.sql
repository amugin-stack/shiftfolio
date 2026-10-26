-- ============================================================
-- Streams now represent shift slots
-- ============================================================
-- Every cell on the calendar IS a stream. Title is no longer
-- needed; host can be unassigned ("not filled yet"). Each slot
-- (brand × start_time) uniquely maps to one stream record.
-- ============================================================

-- 1. Relax NOT NULL on title and host_id
ALTER TABLE public.streams ALTER COLUMN title   DROP NOT NULL;
ALTER TABLE public.streams ALTER COLUMN host_id DROP NOT NULL;

-- 2. One stream per (brand, start_time) — clicking the same slot edits the existing stream
ALTER TABLE public.streams DROP CONSTRAINT IF EXISTS streams_unique_slot;
ALTER TABLE public.streams ADD  CONSTRAINT streams_unique_slot UNIQUE (brand_id, start_time);
