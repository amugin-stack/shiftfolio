-- ============================================================
-- Fix: auto-verify when a moderator is REMOVED from a stream
-- ============================================================
-- The INSERT trigger from 030 handles the "no moderator at create"
-- case. But if an admin assigns a moderator (verified flips false),
-- then later changes their mind and CLEARS moderator_id, the row
-- stays at verified=false forever — and no one can submit a summary
-- (the submit RPC requires the caller to be the moderator on the
-- stream, which is now NULL). Result: stream stuck unverified and
-- silently excluded from dashboard revenue.
--
-- Fix: extend the trigger with a BEFORE UPDATE arm that re-verifies
-- when moderator_id transitions to NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION public.streams_auto_verify_when_no_moderator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT: original behavior — new stream with no moderator is auto-verified.
  IF TG_OP = 'INSERT' THEN
    IF NEW.moderator_id IS NULL THEN
      NEW.verified := TRUE;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: moderator transitions to NULL (admin removed them).
  -- No one is on the hook for a summary anymore, so auto-verify.
  IF TG_OP = 'UPDATE'
     AND OLD.moderator_id IS NOT NULL
     AND NEW.moderator_id IS NULL
     AND NEW.verified = FALSE
  THEN
    NEW.verified    := TRUE;
    NEW.verified_at := COALESCE(NEW.verified_at, NOW());
  END IF;

  RETURN NEW;
END;
$$;

-- Re-create the trigger so it covers UPDATE too.
DROP TRIGGER IF EXISTS streams_auto_verify_no_mod ON public.streams;
CREATE TRIGGER streams_auto_verify_no_mod
  BEFORE INSERT OR UPDATE OF moderator_id ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.streams_auto_verify_when_no_moderator();

-- Heal any rows already stuck in the broken state from before this fix.
UPDATE public.streams
   SET verified    = TRUE,
       verified_at = COALESCE(verified_at, NOW())
 WHERE moderator_id IS NULL
   AND verified = FALSE;
