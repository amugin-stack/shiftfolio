-- 037_email_notifications.sql
-- Schema additions for Resend-backed transactional email.
-- Sister files: 038_shift_reminder_cron.sql, 039_bulk_book_dedup.sql.
--
-- This migration is purely additive — no existing rows or columns are modified.

----------------------------------------------------------------------
-- 1. Track per-notification email delivery on the notifications table.
----------------------------------------------------------------------
ALTER TABLE public.notifications
  ADD COLUMN email_sent_at        timestamptz,
  ADD COLUMN email_message_id     text,
  ADD COLUMN email_error          text,
  ADD COLUMN email_skipped_reason text;

COMMENT ON COLUMN public.notifications.email_sent_at IS
  'When the email was successfully accepted by Resend. NULL = not yet sent. Used as the idempotency guard in send-notification-email Edge Function.';
COMMENT ON COLUMN public.notifications.email_message_id IS
  'Resend message ID, for correlating bounce/complaint events back to this notification.';
COMMENT ON COLUMN public.notifications.email_error IS
  'Last failure reason (if any) so partial failures are visible in the dashboard.';
COMMENT ON COLUMN public.notifications.email_skipped_reason IS
  'Reason the email was deliberately skipped (no_address, recipient_disabled, etc.). Distinguishes intentional skip from pending.';

-- Partial index over pending-email rows. The send-notification-email Edge
-- Function is triggered per-INSERT so it rarely scans, but ops queries
-- ("what's stuck?") use this index.
CREATE INDEX notifications_pending_email_idx
  ON public.notifications (created_at)
  WHERE email_sent_at IS NULL AND email_skipped_reason IS NULL;

----------------------------------------------------------------------
-- 2. Per-recipient bounce/complaint disable on each role table.
----------------------------------------------------------------------
ALTER TABLE public.hosts
  ADD COLUMN email_disabled_at     timestamptz,
  ADD COLUMN email_disabled_reason text;

ALTER TABLE public.moderators
  ADD COLUMN email_disabled_at     timestamptz,
  ADD COLUMN email_disabled_reason text;

ALTER TABLE public.producers
  ADD COLUMN email_disabled_at     timestamptz,
  ADD COLUMN email_disabled_reason text;

COMMENT ON COLUMN public.hosts.email_disabled_at IS
  'Set by resend-webhook on bounce/complaint events. send-notification-email skips sends to disabled addresses.';

----------------------------------------------------------------------
-- 3. Resend delivery event log.
----------------------------------------------------------------------
CREATE TABLE public.email_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  text        NOT NULL,
  recipient   text        NOT NULL,
  event_type  text        NOT NULL CHECK (event_type IN (
                'delivered', 'bounced', 'complained', 'opened', 'clicked',
                'sent', 'delivery_delayed', 'failed'
              )),
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_events_recipient_idx  ON public.email_events (recipient);
CREATE INDEX email_events_message_id_idx ON public.email_events (message_id);

COMMENT ON TABLE public.email_events IS
  'Append-only log of Resend webhook events (delivered, bounced, complained, etc.). Service-role writes only.';

-- Lock down email_events — service role bypasses RLS; no policies = no
-- non-service access. Email events can include recipient PII (addresses,
-- failure reasons) and should never be exposed to the anon/authenticated
-- roles.
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
