-- 083: Replay-safe delivery callbacks. Apply after082, before webhook deployment.
-- Additive; old webhook remains compatible. Roll forward on failure; rolling
-- the handler back restores replay risk. Retain receipt history on rollback.
BEGIN;
CREATE TABLE IF NOT EXISTS public.email_webhook_receipts (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_webhook_receipts FROM PUBLIC, anon, authenticated;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS email_delivered_at timestamptz;

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS email_delivery_failed_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email_disabled_at timestamptz;

CREATE OR REPLACE FUNCTION public._process_resend_event(p_event_id text, p_event jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_type text := replace(p_event->>'type','email.','');
  v_recipient text; v_detail text; v_claim text;
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 256
    OR v_type IS NULL OR v_type NOT IN ('sent','delivered','delivery_delayed','complained','bounced','opened','clicked','failed')
    OR jsonb_typeof(p_event->'data'->'to') IS DISTINCT FROM 'array'
    OR coalesce(length(p_event->'data'->>'email_id'),0) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Invalid email event';
  END IF;
  IF jsonb_array_length(p_event->'data'->'to') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid recipients'; END IF;
  INSERT INTO public.email_webhook_receipts(event_id) VALUES(p_event_id)
    ON CONFLICT DO NOTHING RETURNING event_id INTO v_claim;
  IF v_claim IS NULL THEN RETURN false; END IF;
  v_detail := CASE WHEN v_type IN ('bounced','complained') THEN v_type END;
  FOR v_recipient IN SELECT DISTINCT jsonb_array_elements_text(p_event->'data'->'to') LOOP
    IF v_recipient IS NULL OR length(v_recipient)>320 OR v_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
      RAISE EXCEPTION 'Invalid recipient';
    END IF;
    INSERT INTO public.email_events(message_id,recipient,event_type,payload)
      VALUES(p_event->'data'->>'email_id',v_recipient,v_type,p_event);
    IF v_detail IS NOT NULL THEN
      UPDATE public.hosts SET email_disabled_at=now(),email_disabled_reason=v_detail
        WHERE lower(email)=lower(v_recipient) AND email_disabled_at IS NULL;
      UPDATE public.moderators SET email_disabled_at=now(),email_disabled_reason=v_detail
        WHERE lower(email)=lower(v_recipient) AND email_disabled_at IS NULL;
      UPDATE public.producers SET email_disabled_at=now(),email_disabled_reason=v_detail
        WHERE lower(email)=lower(v_recipient) AND email_disabled_at IS NULL;
      UPDATE public.profiles SET email_disabled_at=now()
        WHERE lower(email)=lower(v_recipient) AND email_disabled_at IS NULL;
    END IF;
  END LOOP;
  IF v_type='delivered' THEN
    UPDATE public.notifications SET email_delivered_at=coalesce(email_delivered_at,now())
      WHERE email_message_id=p_event->'data'->>'email_id';
  END IF;
  IF v_type IN ('failed','bounced','complained') THEN
    UPDATE public.notifications SET email_delivery_failed_at=coalesce(email_delivery_failed_at,now())
      WHERE email_message_id=p_event->'data'->>'email_id';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public._process_resend_event(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._process_resend_event(text,jsonb) TO service_role;
-- Profile owners may edit personal details, never provider suppression state.
CREATE OR REPLACE FUNCTION public.guard_profile_email_suppression()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF current_user IN ('anon','authenticated') AND NEW.email_disabled_at IS DISTINCT FROM OLD.email_disabled_at THEN
    RAISE EXCEPTION 'Email suppression is managed by delivery processing' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_profile_email_suppression ON public.profiles;
CREATE TRIGGER guard_profile_email_suppression BEFORE UPDATE OF email_disabled_at ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_email_suppression();
NOTIFY pgrst, 'reload schema';
COMMIT;
