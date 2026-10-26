-- ============================================================
-- Auto-verify past shifts at insert time
-- ============================================================
-- When an admin/producer backfills a past shift (e.g. to record
-- already-worked hours for payroll), the moderator typically can't
-- submit a stream summary for it — they may not have been on it,
-- and the summary dialog locks them out for past shifts they didn't
-- recap in time. With a moderator assigned, the existing trigger
-- left `verified = false`, which silently dropped the shift from
-- /admin/dashboard (brand revenue), /admin/payroll/hosts, and
-- /admin/payroll/moderators — all three filter on verified=true.
--
-- This migration extends the auto-verify trigger so any shift whose
-- end_time is already in the past at insert time is verified on the
-- spot, regardless of moderator assignment. Future-with-moderator
-- shifts are unchanged: they still wait for `submit_stream_summary`.
--
-- Function name is preserved so the existing trigger binding (set in
-- migrations 030 + 032) still routes to this updated body.
-- ============================================================

CREATE OR REPLACE FUNCTION public.streams_auto_verify_when_no_moderator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_pt_now TIMESTAMPTZ := ((NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
BEGIN
  -- INSERT: auto-verify if (a) no moderator, or (b) shift is already in the past.
  -- UPDATE: re-verify if the moderator was just cleared (preserves migration 032 behavior).
  IF TG_OP = 'INSERT' THEN
    IF NEW.moderator_id IS NULL OR NEW.end_time < v_pt_now THEN
      NEW.verified    := TRUE;
      NEW.verified_at := COALESCE(NEW.verified_at, NOW());
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.moderator_id IS NULL AND OLD.moderator_id IS NOT NULL AND NEW.verified = FALSE THEN
      NEW.verified    := TRUE;
      NEW.verified_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
