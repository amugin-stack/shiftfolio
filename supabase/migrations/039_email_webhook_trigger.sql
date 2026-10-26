-- 039_email_webhook_trigger.sql
-- Wires public.notifications INSERTs to the send-notification-email Edge
-- Function via pg_net + a Vault-stored shared secret.
--
-- Why a shared secret rather than the service-role JWT? The trigger lives
-- in the schema; embedding the JWT would leak it to anyone with admin
-- access who reads `pg_get_triggerdef`. The secret lives in Supabase
-- Vault (encrypted at rest) and is read at trigger execution time. The
-- Edge Function is deployed with verify_jwt=false and validates the
-- secret instead — see supabase/functions/send-notification-email/index.ts.
--
-- The secret itself is NOT created by this migration — it must exist in
-- Vault under the name 'email_webhook_secret'. Set it with:
--   SELECT vault.create_secret('<random-hex>', 'email_webhook_secret', '...');
-- Then store the same value in Supabase Edge Function secrets as
-- WEBHOOK_SECRET. Both halves must match.

----------------------------------------------------------------------
-- 1. Ensure pg_net is enabled (Supabase ships it; idempotent).
----------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

----------------------------------------------------------------------
-- 2. Trigger function: POST to the Edge Function on every INSERT.
--
-- net.http_post returns immediately; the actual HTTP request runs
-- asynchronously so the original transaction is never blocked by
-- network latency. pg_net writes outcomes to net._http_response for
-- post-hoc inspection.
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._fire_send_notification_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_secret text;
  v_url    text := 'https://demo-project.supabase.invalid/functions/v1/send-notification-email';
BEGIN
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'email_webhook_secret';

  IF v_secret IS NULL OR v_secret = '' THEN
    -- Secret not configured yet. We log and move on so notification rows
    -- still land in the table; once the secret is set, future inserts
    -- will fire emails. Existing rows can be re-fired by re-INSERTing
    -- their content if needed.
    RAISE NOTICE 'email_webhook_secret not in Vault; skipping email fire';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    body    := jsonb_build_object(
      'type',   'INSERT',
      'table',  TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', row_to_json(NEW)
    ),
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'X-Webhook-Secret', v_secret
    ),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public._fire_send_notification_email() IS
  'AFTER INSERT trigger function on notifications: POSTs the new row to send-notification-email Edge Function. Authenticates via shared secret from vault.';

----------------------------------------------------------------------
-- 3. Wire the trigger.
----------------------------------------------------------------------
DROP TRIGGER IF EXISTS notifications_send_email_trigger ON public.notifications;
CREATE TRIGGER notifications_send_email_trigger
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public._fire_send_notification_email();
