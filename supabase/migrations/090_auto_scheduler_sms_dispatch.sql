-- 090: Twilio SMS dispatch for the auto-scheduler (PR 2). ADDITIVE ONLY.
--
-- INTENT: 089 already queues rows into public.sms_outbox but ships with no
-- transport, so nothing is ever texted. This migration adds the dispatcher
-- that walks the outbox and calls the sms-send Edge Function (which owns the
-- actual Twilio call), plus the two SECURITY DEFINER functions that Edge
-- Function uses to claim a row and record the outcome. It also adds the
-- combined tick helper a later activation migration will hand to pg_cron.
--
-- SAFETY: dispatch is a no-op until (a) scheduler_runtime.enabled is true and
-- (b) the 'sms_webhook_secret' Vault secret exists — missing secret returns 0
-- quietly rather than erroring, matching 079/084's pattern for optional
-- webhook secrets. Rows in state 'dry_run' are never touched by anything
-- here, so flipping scheduler_runtime.dry_run stays a safe dial. Every
-- outbound send is revalidated against the live coverage_offers row twice
-- (once here, once in sms_claim_for_send) so a stale/expired/filled offer is
-- never texted even if it lingered in the queue.
--
-- APPLY: after 089. Deploy the sms-send and sms-inbound Edge Functions and
-- set TWILIO_* / SMS_WEBHOOK_SECRET / SMS_INBOUND_PUBLIC_URL secrets before
-- flipping scheduler_runtime.enabled — this migration does not schedule any
-- cron job (a future 091 activation migration does that).
-- ROLLBACK: no cron references this migration's functions yet, so dropping
-- them is safe: DROP FUNCTION public._dispatch_sms_outbox(),
--   public._run_auto_scheduler_cycle(), public.sms_claim_for_send(uuid),
--   public.sms_mark_result(uuid,text,text);
-- Rows already in sms_outbox are untouched by the rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Dispatcher: picks queued outbox rows and hands each to the sms-send
-- webhook. Never sends; only decides who gets a request and records the
-- attempt bookkeeping. The actual Twilio call and its result live in
-- sms-send / sms_mark_result so a crashed Edge Function invocation cannot
-- silently lose the retry counter.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public._dispatch_sms_outbox() RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_enabled boolean;
  v_secret  text;
  r record;
  v_sent integer := 0;
  v_backoff_minutes integer;
BEGIN
  SELECT enabled INTO v_enabled FROM public.scheduler_runtime WHERE singleton;
  IF NOT coalesce(v_enabled, false) THEN RETURN 0; END IF;

  -- No secret configured yet (pre-launch / secret rotation): stay quiet
  -- rather than raising, mirroring 079's email_webhook_secret guard.
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'sms_webhook_secret';
  IF v_secret IS NULL OR v_secret = '' THEN RETURN 0; END IF;

  FOR r IN
    SELECT o.* FROM public.sms_outbox o
     WHERE o.state = 'queued' AND o.next_attempt_at <= now() AND o.attempts < 5
     ORDER BY o.attempts, o.next_attempt_at
     LIMIT 20
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Revalidate offer rows before spending a text: a slow dispatch tick must
    -- never fire on a coverage offer that already went stale/expired/filled.
    IF r.kind = 'offer' AND NOT EXISTS (
      SELECT 1 FROM public.coverage_offers f
       WHERE f.id = r.offer_id AND f.state = 'pending' AND f.expires_at > now()
    ) THEN
      UPDATE public.sms_outbox SET state = 'canceled' WHERE id = r.id;
      CONTINUE;
    END IF;

    -- Backoff 2, 4, 8, 16 minutes as attempts (post-increment) go 1, 2, 3, 4+.
    -- attempts<5 admits a 5th send (the final retry before sms_mark_result
    -- marks it failed); it reuses the 16-minute step rather than doubling
    -- past the documented backoff schedule.
    v_backoff_minutes := (2 ^ (least(r.attempts, 3) + 1))::integer;
    UPDATE public.sms_outbox
       SET attempts = r.attempts + 1,
           next_attempt_at = now() + make_interval(mins => v_backoff_minutes)
     WHERE id = r.id;

    PERFORM net.http_post(
      url := 'https://demo-project.supabase.invalid/functions/v1/sms-send',
      body := jsonb_build_object('id', r.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Webhook-Secret', v_secret),
      timeout_milliseconds := 30000
    );
    v_sent := v_sent + 1;
  END LOOP;

  RETURN v_sent;
END $$;

-- One tick, both halves. A future 091 activation migration schedules THIS
-- with pg_cron; nothing here creates or touches a cron job.
CREATE FUNCTION public._run_auto_scheduler_cycle() RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM public._run_auto_scheduler();
  PERFORM public._dispatch_sms_outbox();
END $$;

-- ---------------------------------------------------------------------------
-- Called by sms-send (service_role) right before the Twilio call. Revalidates
-- again so a stale offer is never texted even if two dispatch ticks raced.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.sms_claim_for_send(p_id uuid)
RETURNS TABLE(to_e164 text, body text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.sms_outbox;
BEGIN
  SELECT * INTO r FROM public.sms_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.state <> 'queued' THEN
    RETURN;
  END IF;

  IF r.kind = 'offer' AND NOT EXISTS (
    SELECT 1 FROM public.coverage_offers f
     WHERE f.id = r.offer_id AND f.state = 'pending' AND f.expires_at > now()
  ) THEN
    UPDATE public.sms_outbox SET state = 'canceled' WHERE id = r.id;
    RETURN;
  END IF;

  RETURN QUERY SELECT r.to_e164, r.body;
END $$;

-- ---------------------------------------------------------------------------
-- Called by sms-send (service_role) after the Twilio call resolves.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.sms_mark_result(p_id uuid, p_provider_sid text, p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.sms_outbox;
BEGIN
  SELECT * INTO r FROM public.sms_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_provider_sid IS NOT NULL THEN
    UPDATE public.sms_outbox
       SET state = 'accepted', provider_sid = p_provider_sid, accepted_at = now()
     WHERE id = r.id;
  ELSE
    UPDATE public.sms_outbox
       SET last_error = left(coalesce(p_error, 'unknown_error'), 500),
           state = CASE WHEN r.attempts >= 5 THEN 'failed' ELSE r.state END
     WHERE id = r.id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public._dispatch_sms_outbox(), public._run_auto_scheduler_cycle(),
  public.sms_claim_for_send(uuid), public.sms_mark_result(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_claim_for_send(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.sms_mark_result(uuid,text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
