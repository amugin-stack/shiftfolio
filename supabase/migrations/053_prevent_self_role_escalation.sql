-- ============================================================
-- 053_prevent_self_role_escalation.sql
--
-- INTENT (SECURITY — privilege escalation fix):
--   The original `profiles_update_own` policy (001_initial_schema.sql:111) is
--       USING (id = auth.uid()) WITH CHECK (id = auth.uid())
--   with NO restriction on the `role` column. Any authenticated user could
--   therefore run `UPDATE profiles SET role = 'admin' WHERE id = <own uid>`,
--   pass RLS (it is their own row), and become an admin — bypassing the entire
--   access model, payroll, client pricing, and all PII protections. This has
--   been latent since migration 001.
--
--   This migration adds a BEFORE UPDATE trigger on public.profiles that rejects
--   any change to the `role` column unless the caller is already an admin.
--   Signup is unaffected (handle_new_user INSERTs role='user' as SECURITY
--   DEFINER — this guard is UPDATE-only). Legitimate admin promotion/demotion
--   via the admin Users UI still works (is_admin() is true for the caller).
--
-- APPLY-ORDERING / LANE:
--   Pure main-lane fix. It touches ONLY the 001 boundary and has NO dependency
--   on any other migration or on the agent2migrations/ lane — so it can be
--   applied out of band as a standalone security hotfix on current production
--   (main @ 048) immediately if desired. Its number (053) reflects merge
--   sequencing only, not a dependency; reconcile the final number with the
--   other in-flight branches per the migration-collision flag.
--
-- SECURITY NOTE:
--   is_admin() is evaluated inside a BEFORE trigger, so its SELECT sees the
--   pre-update (OLD) role. A 'user' attempting to self-promote is therefore
--   still a 'user' at check time -> is_admin() = false -> rejected.
--
-- ROLLBACK:
--   DROP TRIGGER trg_prevent_self_role_escalation ON public.profiles;
--   DROP FUNCTION public.prevent_self_role_escalation();
--   (Reverting restores the pre-existing escalation hole — do not roll back
--    without a replacement guard.)
-- ============================================================

CREATE OR REPLACE FUNCTION public.prevent_self_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only guard actual role changes; ordinary profile edits (name, phone, etc.)
  -- are untouched. Non-admins may never change a role — their own or anyone's.
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an admin can change a profile role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_self_role_escalation ON public.profiles;

CREATE TRIGGER trg_prevent_self_role_escalation
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_self_role_escalation();
