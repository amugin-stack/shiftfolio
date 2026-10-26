-- 062_gmv_write_requires_active_host.sql
--
-- INTENT: close the last write path a deactivated worker retains.
--
-- Migration 054 added soft-delete, 058/059 revoked a deactivated host's READ
-- access to streams and extra-pay. But `set_session_gmv` (agent2migrations/007)
-- authorizes on `h.user_id = auth.uid()` alone, with NO is_active test — so a
-- removed contractor holding a live session (058 revokes SELECT, not the JWT)
-- can still POST /rest/v1/rpc/set_session_gmv and rewrite gmv_cents on any of
-- their historical streams.
--
-- That corrupts the Host Performance dashboard and every GMV-derived report,
-- and it is invisible: there is no audit trail on gmv_cents. 058's "NOT
-- AFFECTED" list did not consider this RPC.
--
-- Note they can no longer READ the stream (058), but the RPC is SECURITY
-- DEFINER, so it does not need them to — they only need the stream id, which
-- they may still have from before deactivation or from a saved page.
--
-- WHAT CHANGES: one added condition, `AND h.is_active`. Everything else in the
-- function is byte-identical to agent2migrations/007 — same checks, same order,
-- same ERRCODEs, same messages.
--
-- APPLY ORDER: after 054 (adds is_active). Independent of everything else.
-- No data is modified. Safe to re-run.
--
-- ROLLBACK: re-apply the version in agent2migrations/007_host_gmv.sql.

CREATE OR REPLACE FUNCTION public.set_session_gmv(
  p_stream_id uuid,
  p_gmv_cents integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_id uuid;
  v_end     timestamptz;
BEGIN
  SELECT s.host_id, s.end_time
    INTO v_host_id, v_end
  FROM public.streams s
  WHERE s.id = p_stream_id;

  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'Session not found or has no host' USING ERRCODE = '22023';
  END IF;

  -- Caller must be the host of this stream AND still be an ACTIVE host.
  -- The is_active test is the fix: without it a deactivated worker keeps a
  -- live write path into revenue data.
  IF NOT EXISTS (
    SELECT 1 FROM public.hosts h
    WHERE h.id = v_host_id
      AND h.user_id = auth.uid()
      AND h.is_active
  ) THEN
    RAISE EXCEPTION 'Not authorized for this session' USING ERRCODE = '42501';
  END IF;

  -- Session must have ended (PT wall-clock comparison; see 007's header).
  IF (v_end AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'America/Los_Angeles') THEN
    RAISE EXCEPTION 'Session has not ended yet' USING ERRCODE = '22023';
  END IF;

  IF p_gmv_cents IS NOT NULL AND p_gmv_cents < 0 THEN
    RAISE EXCEPTION 'GMV must be non-negative' USING ERRCODE = '22023';
  END IF;

  UPDATE public.streams
     SET gmv_cents = p_gmv_cents
   WHERE id = p_stream_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_session_gmv(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_session_gmv(uuid, integer) TO authenticated;
