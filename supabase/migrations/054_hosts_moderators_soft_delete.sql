-- ============================================================
-- 054_hosts_moderators_soft_delete.sql
--
-- INTENT (data safety — replace hard-delete with soft-delete):
--   Admins need to remove hosts/moderators who've left. Hard-deleting them
--   erased their past pay + the brand's GMV from every payroll/report (those
--   surfaces skip rows with a null host/moderator, and a hard delete either
--   blocked on the FK or null'd the link). For a payroll app that history must
--   survive for bookkeeping.
--
--   Fix: add an `is_active` flag to hosts and moderators. "Deleting" in the UI
--   flips this to false — the row and all its stream links (and frozen
--   host_rate_cents) stay intact, so payroll/GMV history is preserved. Inactive
--   people drop off active rosters and assignment dropdowns; admins can
--   reactivate. We never issue DELETE FROM hosts/moderators anymore, so the
--   streams.host_id RESTRICT FK (migration 001) never fires — no FK change
--   needed, and the feat/fix-delete-host SET NULL migration is now moot (do
--   not merge it — SET NULL erases the very history this preserves).
--
-- ADDITIVE / SAFE (rule 13): new column, NOT NULL with DEFAULT true, so every
--   existing host/moderator stays active. No backfill needed. RLS unchanged —
--   existing hosts/moderators policies already cover the table; a new column
--   inherits them. No new policies required.
--
-- APPLY ORDER: independent. In the consolidated migration sequence this is 054
--   (049/050 training, 051/052 access-model, 053 role-escalation precede it);
--   no dependency on any of them. Alex applies by hand in number order.
--
-- ROLLBACK:
--   ALTER TABLE public.hosts       DROP COLUMN IF EXISTS is_active;
--   ALTER TABLE public.moderators  DROP COLUMN IF EXISTS is_active;
--   (Reverting makes every host/moderator "active" again — harmless; the UI
--    just loses the deactivate feature.)
-- ============================================================

ALTER TABLE public.hosts
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.moderators
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
