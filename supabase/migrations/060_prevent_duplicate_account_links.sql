-- 060_prevent_duplicate_account_links.sql
--
-- INTENT: stop one login being linked to two host (or moderator, or producer)
-- records, which silently strips a real worker of all access and all pay.
--
-- THE BUG: hosts.user_id, moderators.user_id and producers.user_id have no
-- UNIQUE constraint (migrations 001, 002, 026). Every lookup of "who am I"
-- uses `.maybeSingle()`, and PostgREST's maybeSingle returns
-- `data = null, error = PGRST116` when it matches MORE THAN ONE row. Every
-- caller in src/ destructures `{ data }` and discards `error`.
--
-- So a duplicated link does not raise anything anywhere. The person becomes
-- role-less: resolveUserRoles reports isHost=false/hostId=null, My Shifts shows
-- "No shifts linked", the calendar treats them as a stranger, and their pay
-- surfaces read zero — while their shifts and money sit untouched in the DB.
-- No error, no log, no clue. The only symptom is a worker saying "the app says
-- I have nothing".
--
-- This is REACHABLE TODAY, not theoretical:
--   * soft-delete (mig 054) keeps the old row, so deactivating someone and
--     re-creating them against the same profile makes two rows;
--   * the Linked Profile picker in HostsManager lists every profile with no
--     exclusion of ones already linked, so it is one mis-click.
-- The live payroll export already shows probable duplicate PEOPLE (two
-- spellings of one surname; one name with and without a last name), which is
-- the same class of data-entry problem one step earlier.
--
-- PARTIAL indexes (WHERE user_id IS NOT NULL): user_id is nullable and MANY
-- rows legitimately have NULL (records created before the person signed up).
-- A plain UNIQUE index would be fine on NULLs in Postgres, but the partial
-- form states the intent and keeps the index small.
--
-- ⚠️ APPLY ORDER + PRE-CHECK: this will FAIL if duplicates already exist —
-- which is the point; it refuses to hide them. Run this FIRST and fix any rows
-- it returns before applying:
--
--   SELECT 'hosts' AS tbl, user_id, count(*), string_agg(name, ' | ')
--     FROM public.hosts      WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*) > 1
--   UNION ALL
--   SELECT 'moderators', user_id, count(*), string_agg(name, ' | ')
--     FROM public.moderators WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*) > 1
--   UNION ALL
--   SELECT 'producers', user_id, count(*), string_agg(name, ' | ')
--     FROM public.producers  WHERE user_id IS NOT NULL GROUP BY user_id HAVING count(*) > 1;
--
-- To fix a duplicate: decide which row is the real one, move any streams off
-- the other (UPDATE streams SET host_id = <keeper> WHERE host_id = <dupe>),
-- then NULL the loser's user_id (do NOT delete it — mig 054 explains why).
--
-- ROLLBACK: DROP INDEX public.hosts_user_id_unique; (and the other two).

CREATE UNIQUE INDEX IF NOT EXISTS hosts_user_id_unique
  ON public.hosts (user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS moderators_user_id_unique
  ON public.moderators (user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS producers_user_id_unique
  ON public.producers (user_id) WHERE user_id IS NOT NULL;

COMMENT ON INDEX public.hosts_user_id_unique IS
  'One login = at most one host record. Without this, a duplicate link makes .maybeSingle() return null+PGRST116 and the worker silently loses all access and pay. See migration 060.';
