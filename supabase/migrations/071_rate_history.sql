-- 071_rate_history.sql
--
-- INTENT: start recording what people were actually paid per hour, and when it
-- changed. Right now nothing does, anywhere.
--
-- ===========================================================================
-- THE PROBLEM THIS SOLVES (and the part it deliberately does NOT)
-- ===========================================================================
--
-- `hosts.rate_cents` and `moderators.rate_cents` are single mutable columns.
-- There is no history table, no audit log, not even an `updated_at`. Migration
-- 046's admin-only guards only RAISE on an unauthorised write; they record
-- nothing about an authorised one. So a raise overwrites the old rate and the
-- previous value is simply gone.
--
-- That matters because of the legacy un-frozen tail. Migration 067 stamps
-- `streams.host_rate_cents` at booking, but only for shifts booked from 067
-- onward. Every shift booked between migration 046 and 067 still has NULL
-- there, and payout.ts resolves NULL to the host's CURRENT rate. So changing
-- someone's rate today retroactively re-prices all of their older shifts, on
-- every surface at once -- the CSV, both payroll pages, both dashboards, and
-- the worker's own My Shifts.
--
--   Alice: 100 h in July, paid from a CSV reading $3,000.00 at $30/hr. Raised
--   to $35/hr on 1 August. Re-export the identical July range -> $3,500.00.
--   A $500 difference, no audit trail, both files well-formed, neither marked
--   wrong.
--
-- >>> THIS MIGRATION DOES NOT FIX THE EXISTING TAIL. It cannot: the historical
-- >>> rates are not recorded anywhere, so there is nothing to restore them
-- >>> from. Inventing a value would be worse than the current honest NULL.
--
-- What it does is stop the hole getting deeper, and create the record that any
-- future correction can be defended with. From today, every rate change is
-- captured with its effective date and who made it. A year from now, "what was
-- Alice on in March?" is answerable. Today it is not.
--
-- The only artefact that records what was ACTUALLY paid for the existing tail
-- is the payroll CSVs already exported and paid out. If those files still
-- exist, `Amount Owed / Total Hours` per host per period reconstructs the rate
-- in force. That reconstruction is a separate, deliberate migration requiring a
-- human decision and a tie-out -- see the note at the bottom.
--
-- ===========================================================================
-- DESIGN
-- ===========================================================================
--
-- One table for both roles, discriminated by `subject_kind`, because the two
-- are structurally identical and every consumer wants them together.
--
-- Append-only by construction: no UPDATE or DELETE policy exists, and the
-- trigger only ever INSERTs. A rate change is a new row, never an edit.
--
-- `effective_from` is when the change was recorded, in the PT-naive scheme this
-- codebase uses everywhere else (CLAUDE.md rule 5), so it compares directly
-- against stream timestamps without an offset.
--
-- `changed_by` is `auth.uid()`, captured inside a SECURITY DEFINER trigger --
-- never passed in by a caller (rule 17).
--
-- SEEDING: one row per existing host and moderator, stamped with the CURRENT
-- rate and today's date. That is an honest statement -- "this is what they were
-- on when we started recording" -- and NOT a claim about any earlier period.
-- It is what makes the series continuous from here.
--
-- APPLY ORDER: after 046 (rate columns) and 054 (is_active). Independent of
-- everything else. Additive only: creates one table, two triggers, seeds rows.
-- Touches no existing column and changes no existing behaviour, so no pay
-- figure moves as a result of applying it.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_record_host_rate_change ON public.hosts;
--   DROP TRIGGER IF EXISTS trg_record_moderator_rate_change ON public.moderators;
--   DROP FUNCTION IF EXISTS public.record_rate_change();
--   DROP TABLE IF EXISTS public.rate_history;

CREATE TABLE IF NOT EXISTS public.rate_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind   text NOT NULL CHECK (subject_kind IN ('host', 'moderator')),
  subject_id     uuid NOT NULL,
  rate_cents     integer NOT NULL CHECK (rate_cents >= 0),
  -- PT-naive, like every other timestamp here: the UTC fields ARE the PT
  -- wall-clock, so this compares directly against stream timestamps.
  effective_from timestamptz NOT NULL
    DEFAULT ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'),
  changed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- "What was this person on at time T" is the only query this table exists to
-- answer, so index for it directly.
CREATE INDEX IF NOT EXISTS idx_rate_history_subject
  ON public.rate_history (subject_kind, subject_id, effective_from DESC);

ALTER TABLE public.rate_history ENABLE ROW LEVEL SECURITY;

-- Admin-only. This is pay data: the same boundary as rate_cents itself
-- (migrations 055/061). InitPlan-wrapped per migration 063's lesson.
DROP POLICY IF EXISTS "rate_history: admin read" ON public.rate_history;
CREATE POLICY "rate_history: admin read"
  ON public.rate_history FOR SELECT
  USING ((SELECT public.is_admin()));

-- No INSERT / UPDATE / DELETE policy, deliberately. Rows arrive ONLY via the
-- SECURITY DEFINER trigger below, which runs as owner and bypasses RLS. That
-- makes the table append-only from the application's point of view: nobody can
-- rewrite pay history, including an admin.

CREATE OR REPLACE FUNCTION public.record_rate_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'hosts' THEN 'host' ELSE 'moderator' END;
BEGIN
  -- Only record actual CHANGES. An UPDATE that leaves rate_cents alone (editing
  -- a phone number, deactivating someone) must not add a row, or the history
  -- fills with noise and "when did this last change" stops being answerable.
  IF TG_OP = 'UPDATE' AND NEW.rate_cents IS NOT DISTINCT FROM OLD.rate_cents THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.rate_history (subject_kind, subject_id, rate_cents, changed_by)
  VALUES (v_kind, NEW.id, NEW.rate_cents, auth.uid());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_host_rate_change ON public.hosts;
CREATE TRIGGER trg_record_host_rate_change
  AFTER INSERT OR UPDATE OF rate_cents ON public.hosts
  FOR EACH ROW EXECUTE FUNCTION public.record_rate_change();

DROP TRIGGER IF EXISTS trg_record_moderator_rate_change ON public.moderators;
CREATE TRIGGER trg_record_moderator_rate_change
  AFTER INSERT OR UPDATE OF rate_cents ON public.moderators
  FOR EACH ROW EXECUTE FUNCTION public.record_rate_change();

-- ---------------------------------------------------------------------------
-- SEED: one row per existing person, at their CURRENT rate
-- ---------------------------------------------------------------------------
-- This asserts "as of today, this is the rate" -- nothing about earlier
-- periods. Guarded so re-running the migration does not duplicate the seed.
INSERT INTO public.rate_history (subject_kind, subject_id, rate_cents, changed_by)
SELECT 'host', h.id, h.rate_cents, NULL
  FROM public.hosts h
 WHERE NOT EXISTS (
   SELECT 1 FROM public.rate_history r
    WHERE r.subject_kind = 'host' AND r.subject_id = h.id
 );

INSERT INTO public.rate_history (subject_kind, subject_id, rate_cents, changed_by)
SELECT 'moderator', m.id, m.rate_cents, NULL
  FROM public.moderators m
 WHERE NOT EXISTS (
   SELECT 1 FROM public.rate_history r
    WHERE r.subject_kind = 'moderator' AND r.subject_id = m.id
 );

-- ---------------------------------------------------------------------------
-- Admin-only accessor, matching the pattern in 055/066
-- ---------------------------------------------------------------------------
-- Admins share the `authenticated` role, so RLS alone cannot distinguish them
-- for a table-level read in the way the app expects; the accessor keeps this
-- consistent with how every other pay figure is read.
CREATE OR REPLACE FUNCTION public.admin_rate_history(p_subject_id uuid DEFAULT NULL)
RETURNS TABLE(subject_kind text, subject_id uuid, rate_cents int, effective_from timestamptz, changed_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT r.subject_kind, r.subject_id, r.rate_cents, r.effective_from, r.changed_by
  FROM public.rate_history r
  WHERE public.is_admin()
    AND (p_subject_id IS NULL OR r.subject_id = p_subject_id)
  ORDER BY r.subject_id, r.effective_from DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_rate_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_rate_history(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY AFTER APPLYING
-- ---------------------------------------------------------------------------
--
-- (a) Everyone is seeded (both counts must match the roster sizes):
--
--       SELECT subject_kind, count(*) FROM public.rate_history GROUP BY 1;
--       SELECT 'hosts' AS t, count(*) FROM public.hosts
--       UNION ALL SELECT 'moderators', count(*) FROM public.moderators;
--
-- (b) A rate change records a row, and a NON-rate edit does not:
--
--       BEGIN;
--         UPDATE public.hosts SET phone = phone WHERE id = '<a host id>';
--         SELECT count(*) FROM public.rate_history
--          WHERE subject_id = '<same>';        -- unchanged (1)
--         UPDATE public.hosts SET rate_cents = rate_cents + 1 WHERE id = '<same>';
--         SELECT count(*) FROM public.rate_history
--          WHERE subject_id = '<same>';        -- now 2
--       ROLLBACK;
--
-- (c) Non-admins cannot read it (expect 0 rows, not an error):
--
--       BEGIN;
--         SET LOCAL ROLE authenticated;
--         SET LOCAL request.jwt.claims = '{"sub":"<NON-ADMIN user_id>","role":"authenticated"}';
--         SELECT count(*) FROM public.admin_rate_history();
--       ROLLBACK;
--
-- (d) MEASURE THE EXISTING TAIL -- how many shifts still have no frozen rate
--     and would therefore re-price if you changed somebody's pay:
--
--       SELECT count(*) FILTER (WHERE host_rate_cents IS NULL AND host_id IS NOT NULL)
--                AS unfrozen_shifts,
--              count(DISTINCT host_id) FILTER (WHERE host_rate_cents IS NULL AND host_id IS NOT NULL)
--                AS hosts_affected,
--              min(start_time) FILTER (WHERE host_rate_cents IS NULL AND host_id IS NOT NULL)
--                AS earliest,
--              max(start_time) FILTER (WHERE host_rate_cents IS NULL AND host_id IS NOT NULL)
--                AS latest
--         FROM public.streams;
--
-- ---------------------------------------------------------------------------
-- THE REMAINING DECISION (not made here, on purpose)
-- ---------------------------------------------------------------------------
--
-- Query (d) sizes the legacy tail. Fixing it needs a human decision, because
-- the data to do it correctly does not exist in this database:
--
--   Option A -- reconstruct from the payroll CSVs that were actually paid.
--     `Amount Owed / Total Hours` per host per period gives the effective rate
--     in force then. The most accurate option, and the only one that reproduces
--     what was really paid. Requires those files.
--
--   Option B -- freeze the tail at each host's CURRENT rate. Honest ONLY for
--     hosts who have never had a raise. Check first:
--       SELECT count(*) FROM public.rate_history GROUP BY subject_id HAVING count(*) > 1;
--     For anyone with more than one entry (once history accumulates), this
--     stamps a number that was never true. Prefer A for those.
--
--   Option C -- leave the tail NULL and simply never re-export a closed period.
--     Costs nothing and is defensible, provided everyone knows that a re-export
--     of an old month will not match what was paid.
--
-- Whichever is chosen: freeze only rows where host_rate_cents IS NULL (never
-- overwrite an existing frozen value -- CLAUDE.md rule 20), and tie out per
-- host per closed period before and after, explaining any non-zero delta.
--
-- SEPARATELY, AND WORTH DOING REGARDLESS: the payroll export route generates a
-- CSV and discards it. Nothing in the system records what was paid. Archiving
-- each export at generation time would mean this class of problem is always
-- reconstructable in future.
