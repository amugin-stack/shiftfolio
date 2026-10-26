-- ============================================================
-- Stream summaries + verification gate
-- ============================================================
-- Adds per-stream moderator recap fields and the verified flag that
-- the admin dashboard now uses to decide which streams count toward
-- revenue / hours. Pre-existing streams are backfilled to verified
-- so historical numbers survive the cutover.
-- ============================================================

ALTER TABLE public.streams
  ADD COLUMN IF NOT EXISTS summary     TEXT,
  ADD COLUMN IF NOT EXISTS verified    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Backfill: every existing stream counts as verified so the dashboard
-- doesn't suddenly drop historical revenue when the gate goes live.
UPDATE public.streams SET verified = TRUE WHERE verified = FALSE;

-- New streams without a moderator have no one to verify them, so we
-- auto-mark them verified on insert. New streams WITH a moderator
-- start unverified until the moderator submits a summary via the RPC.
CREATE OR REPLACE FUNCTION public.streams_auto_verify_when_no_moderator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.moderator_id IS NULL THEN
    NEW.verified := TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS streams_auto_verify_no_mod ON public.streams;
CREATE TRIGGER streams_auto_verify_no_mod
  BEFORE INSERT ON public.streams
  FOR EACH ROW
  EXECUTE FUNCTION public.streams_auto_verify_when_no_moderator();

-- ============================================================
-- RPC: submit_stream_summary
-- ============================================================
-- Moderator writes their recap. Locks the stream as verified.
-- Single-submit only: re-submitting raises.
-- ============================================================
CREATE OR REPLACE FUNCTION public.submit_stream_summary(
  p_stream_id UUID,
  p_summary   TEXT
)
RETURNS public.streams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      UUID := auth.uid();
  v_moderator_id UUID;
  v_stream       public.streams;
  v_pt_now       TIMESTAMPTZ := ((NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC');
  v_clean        TEXT;
  v_result       public.streams;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT id INTO v_moderator_id
  FROM public.moderators
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_moderator_id IS NULL THEN
    RAISE EXCEPTION 'You are not linked as a moderator';
  END IF;

  SELECT * INTO v_stream FROM public.streams WHERE id = p_stream_id;
  IF v_stream.id IS NULL THEN
    RAISE EXCEPTION 'Shift not found';
  END IF;

  IF v_stream.moderator_id IS DISTINCT FROM v_moderator_id THEN
    RAISE EXCEPTION 'You are not the moderator on this shift';
  END IF;

  IF v_stream.end_time > v_pt_now THEN
    RAISE EXCEPTION 'Cannot submit a summary before the shift has ended';
  END IF;

  IF v_stream.verified THEN
    RAISE EXCEPTION 'Summary has already been submitted';
  END IF;

  v_clean := BTRIM(COALESCE(p_summary, ''));
  IF v_clean = '' THEN
    RAISE EXCEPTION 'Summary cannot be empty';
  END IF;

  UPDATE public.streams
  SET summary     = v_clean,
      verified    = TRUE,
      verified_at = NOW()
  WHERE id = p_stream_id
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_stream_summary(UUID, TEXT) TO authenticated;

-- ============================================================
-- RPC: get_stream_summary
-- ============================================================
-- Returns the stream's summary text only for: admin, the producer
-- assigned to the stream, or the moderator assigned to the stream.
-- All other callers raise. Returns NULL when no summary exists yet.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_stream_summary(p_stream_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_stream    public.streams;
  v_allowed   BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO v_stream FROM public.streams WHERE id = p_stream_id;
  IF v_stream.id IS NULL THEN
    RAISE EXCEPTION 'Shift not found';
  END IF;

  IF public.is_admin() THEN
    v_allowed := TRUE;
  ELSIF v_stream.producer_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.producers
    WHERE id = v_stream.producer_id AND user_id = v_user_id
  ) THEN
    v_allowed := TRUE;
  ELSIF v_stream.moderator_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.moderators
    WHERE id = v_stream.moderator_id AND user_id = v_user_id
  ) THEN
    v_allowed := TRUE;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized to view this summary';
  END IF;

  RETURN v_stream.summary;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_stream_summary(UUID) TO authenticated;
