-- ============================================================
-- No double-booking: hosts & moderators
-- ============================================================
-- A host or moderator must never be assigned to two streams whose times
-- overlap. The app layer (StreamEventModal) greys out already-booked people
-- and skips conflicting cells, but that is client-side and racy. This trigger
-- is the authoritative, race-proof guarantee: every INSERT/UPDATE to a stream
-- is rejected if its host_id or moderator_id already appears on another stream
-- whose [start_time, end_time) overlaps.
--
-- Overlap is strict: s.start_time < NEW.end_time AND s.end_time > NEW.start_time
-- (touching, e.g. 5–7 then 7–9, is allowed). NULL host/moderator never conflict.
-- The trigger only evaluates NEW writes, so pre-existing overlaps in the data
-- are left untouched — but any future edit to such a row would be blocked until
-- the conflict is resolved.
--
-- Errors use SQLSTATE 23P01 (exclusion_violation) so the client can map them
-- to a friendly "already booked" message instead of a raw DB error.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_no_double_booking()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.host_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.streams s
    WHERE s.id <> NEW.id
      AND s.host_id = NEW.host_id
      AND s.start_time < NEW.end_time
      AND s.end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'Host is already booked for an overlapping time slot'
      USING ERRCODE = '23P01';
  END IF;

  IF NEW.moderator_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.streams s
    WHERE s.id <> NEW.id
      AND s.moderator_id = NEW.moderator_id
      AND s.start_time < NEW.end_time
      AND s.end_time   > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'Moderator is already booked for an overlapping time slot'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_no_double_booking ON public.streams;

CREATE TRIGGER trg_enforce_no_double_booking
  BEFORE INSERT OR UPDATE OF host_id, moderator_id, start_time, end_time
  ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_no_double_booking();
