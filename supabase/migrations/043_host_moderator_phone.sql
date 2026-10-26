-- ============================================================
-- Phone number on hosts & moderators
-- ============================================================
-- Direct, optional contact number on the host/moderator records
-- themselves (separate from profiles.phone, migration 015 — most
-- roster rows aren't linked to a profile). Plain nullable TEXT,
-- treated exactly like the existing `email` column: no NOT NULL,
-- no default, no special RLS/triggers. Starts blank everywhere;
-- numbers are entered later via the admin manager UI.
-- ============================================================

ALTER TABLE public.hosts
  ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE public.moderators
  ADD COLUMN IF NOT EXISTS phone TEXT;
