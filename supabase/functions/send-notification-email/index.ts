/**
 * send-notification-email Edge Function
 *
 * Invoked by a Supabase Database Webhook on INSERT to public.notifications.
 * Resolves the recipient's email, shapes the row into a RenderableNotification,
 * renders subject + HTML via the shared template dispatcher, sends through
 * Resend with an Idempotency-Key, and writes the result back to the
 * notifications row.
 *
 * Returns:
 *   - 200 on success or deliberate skip (already_sent, no_address, etc.) —
 *     prevents the webhook from retrying.
 *   - 500 on transient errors (Resend down, network); migration 079 retries reminders.
 *
 * Auth: the function is deployed with verify_jwt=false; instead it validates
 * a shared `X-Webhook-Secret` header against the WEBHOOK_SECRET env var.
 * The trigger reads the matching value from Supabase Vault.
 *
 * Env vars expected in Supabase Edge Function secrets:
 *   - RESEND_API_KEY       (required)
 *   - WEBHOOK_SECRET       (required; same value as Vault.email_webhook_secret)
 *   - SENDING_FROM         (optional; defaults to Resend sandbox)
 *   - APP_URL              (optional; defaults to https://scheduler.example.invalid)
 *   - REPLY_TO             (optional)
 *   - SUPABASE_URL         (auto-injected by Supabase)
 *   - SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)
 */

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

import type {
  NotificationType,
  RecipientRole,
  RenderableNotification,
} from '../_shared/types.ts'
import { renderEmail } from '../_shared/templates/index.ts'

const APP_URL = Deno.env.get('APP_URL') ?? 'https://scheduler.example.invalid'
const SENDING_FROM =
  Deno.env.get('SENDING_FROM') ?? 'Studio <onboarding@resend.dev>'

interface ResolvedRecipient {
  email: string
  role: RecipientRole
  name: string | null
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  schema: string
  record: { id: string } & Record<string, unknown>
  old_record: unknown
}

Deno.serve(async (req: Request) => {
  // Retained for architecture review only. Portfolio copies never send mail.
  return jsonResponse(410, { error: 'portfolio_transport_disabled' })

  // Validate the shared webhook secret. verify_jwt=false on this function
  // because the trigger that calls us is in Postgres and can't easily mint
  // a JWT; we use a Vault-stored shared secret instead.
  const expectedSecret = Deno.env.get('WEBHOOK_SECRET')
  if (!expectedSecret) {
    console.error('[send-notification-email] WEBHOOK_SECRET not configured')
    return jsonResponse(500, { error: 'webhook_secret_not_configured' })
  }
  const presentedSecret = req.headers.get('X-Webhook-Secret')
  if (presentedSecret !== expectedSecret) {
    return jsonResponse(401, { error: 'invalid_webhook_secret' })
  }

  let payload: WebhookPayload
  try {
    payload = (await req.json()) as WebhookPayload
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' })
  }

  if (
    payload.type !== 'INSERT' ||
    payload.table !== 'notifications' ||
    payload.schema !== 'public'
  ) {
    return jsonResponse(200, { skipped: 'not_a_notifications_insert' })
  }

  const notificationId = payload.record?.id
  if (!notificationId) {
    return jsonResponse(400, { error: 'missing_notification_id' })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }) },
    },
  )

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    console.error('[send-notification-email] RESEND_API_KEY not configured')
    return jsonResponse(500, { error: 'resend_api_key_not_configured' })
  }

  // Fetch full notification row (the webhook payload may not include all
  // columns reliably across schema changes, so we re-read).
  const { data: notification, error: fetchErr } = await supabase
    .from('notifications')
    .select(
      'id, recipient_id, type, host_name, brand_id, brand_name, shift_start, shift_end, body, email_sent_at, email_skipped_reason, actor_host_id, request_id, email_deferred, reminder_role',
    )
    .eq('id', notificationId)
    .single()

  if (fetchErr || !notification) {
    console.error(
      '[send-notification-email] failed to fetch notification',
      notificationId,
      fetchErr,
    )
    return jsonResponse(500, { error: 'notification_lookup_unavailable' })
  }

  // Idempotency guard 1: already sent or already skipped.
  if (notification.email_sent_at) {
    return jsonResponse(200, { skipped: 'already_sent' })
  }
  if (notification.email_skipped_reason) {
    return jsonResponse(200, { skipped: 'already_skipped' })
  }

  if (notification.email_deferred) {
    const { data: allowed, error } = await supabase.rpc('_reminder_dispatch_allowed', {
      p_notification_id: notificationId,
    })
    if (error) return jsonResponse(500, { error: 'dispatch_validation_unavailable' })
    if (allowed !== true) return jsonResponse(200, { skipped: 'not_current_worker_attempt' })
  }

  // Tiered reminders are tied to a snapshot of the complete assigned session.
  // Revalidate at delivery, including the first attempt, because the schedule
  // may change between database enqueue and this asynchronous invocation.
  if (notification.type === 'shift_reminder' && (notification.email_deferred || ['48h', '24h', '2h'].includes(notification.body))) {
    const { data: current, error: currentError } = await supabase.rpc(
      notification.email_deferred ? '_reminder_outbox_is_current' : '_shift_reminder_is_current', { p_notification_id: notificationId },
    )
    if (currentError) {
      await markError(supabase, notificationId, 'reminder_validation_unavailable')
      return jsonResponse(500, { error: 'reminder_validation_unavailable' })
    }
    if (current !== true) {
      await markSkipped(supabase, notificationId, 'stale_reminder')
      return jsonResponse(200, { skipped: 'stale_reminder' })
    }
  }

  // Resolve recipient email from role tables (host → moderator → producer).
  let recipient: ResolvedRecipient | null
  try {
    recipient = await resolveRecipientEmail(
      supabase, notification.recipient_id,
      notification.type === 'reminder_delivery_alert' ? 'admin' : notification.reminder_role,
    )
  } catch {
    await markError(supabase, notificationId, 'recipient_lookup_unavailable')
    return jsonResponse(500, { error: 'recipient_lookup_unavailable' })
  }
  if (!recipient) {
    await markSkipped(supabase, notificationId, 'no_address_or_disabled')
    return jsonResponse(200, { skipped: 'no_address_or_disabled' })
  }

  // Shape into the agent2-owned contract.
  const renderable = buildRenderable(notification, recipient)

  // Render subject + HTML. renderEmail is async (returns Promise) — backed
  // by @react-email/render which is Promise-based since v1+.
  let subject: string
  let html: string
  try {
    const rendered = await renderEmail(renderable)
    subject = rendered.subject
    html = rendered.html
  } catch (e) {
    console.error('[send-notification-email] render failed', e)
    await markError(supabase, notificationId, `render_failed: ${stringifyError(e)}`)
    return jsonResponse(500, { error: 'render_failed' })
  }

  // Send via Resend HTTP API directly. Idempotency-Key blocks duplicate
  // sends if the webhook retries before we manage to flip email_sent_at.
  let sendBody: Record<string, unknown> = {
    from: SENDING_FROM,
    to: recipient.email,
    subject,
    html,
    headers: {
      'List-Unsubscribe': '<mailto:unsubscribe@scheduler.example.invalid>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
  const replyTo = Deno.env.get('REPLY_TO')
  if (replyTo) sendBody.reply_to = replyTo

  // Reserve one provider slot per second across concurrent deferred invocations.
  // Revalidate after waiting: a schedule may change while this attempt is paced.
  if (notification.email_deferred) {
    const { data: waitMs, error: slotError } = await supabase.rpc('_claim_reminder_send_slot', {
      p_notification_id: notificationId,
    })
    if (slotError || typeof waitMs !== 'number' || waitMs < 0 || waitMs > 55_000) {
      return jsonResponse(500, { error: 'delivery_slot_unavailable' })
    }
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    const { data: stillAllowed, error: checkError } = await supabase.rpc('_reminder_dispatch_allowed', {
      p_notification_id: notificationId,
    })
    if (checkError) return jsonResponse(500, { error: 'dispatch_validation_unavailable' })
    if (stillAllowed !== true) return jsonResponse(200, { skipped: 'not_current_worker_attempt' })
    if (waitMs > 0) {
      try {
        const currentRecipient = await resolveRecipientEmail(supabase, notification.recipient_id,
          notification.type === 'reminder_delivery_alert' ? 'admin' : notification.reminder_role)
        if (!currentRecipient) {
          await markSkipped(supabase, notificationId, 'no_address_or_disabled')
          return jsonResponse(200, { skipped: 'no_address_or_disabled' })
        }
        sendBody.to = currentRecipient.email
      } catch {
        await markError(supabase, notificationId, 'recipient_lookup_unavailable')
        return jsonResponse(500, { error: 'recipient_lookup_unavailable' })
      }
    }
  }

  if (notification.email_deferred) {
    const { data: prepared, error: preparationError } = await supabase.rpc('_prepare_reminder_email', {
      p_notification_id: notificationId, p_payload: sendBody,
    })
    if (preparationError || !prepared || typeof prepared !== 'object' || !prepared.to || !prepared.html) {
      return jsonResponse(500, { error: 'email_preparation_unavailable' })
    }
    if (prepared.to !== sendBody.to) {
      await markSkipped(supabase, notificationId, 'recipient_address_changed')
      return jsonResponse(200, { skipped: 'recipient_address_changed' })
    }
    sendBody = prepared
  }

  let sendRes: Response
  try {
    sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': notificationId,
      },
      body: JSON.stringify(sendBody),
    })
  } catch (e) {
    const msg = `network_error: ${stringifyError(e)}`
    console.error('[send-notification-email]', msg)
    await markError(supabase, notificationId, msg)
    return jsonResponse(500, { error: 'network_error', detail: msg })
  }

  const sendJson = (await sendRes.json().catch(() => ({}))) as {
    id?: string
    message?: string
    name?: string
  }

  if (!sendRes.ok || !sendJson.id) {
    const msg =
      sendJson.message ?? `resend_http_${sendRes.status}`
    console.error('[send-notification-email] resend error', sendRes.status, sendJson)
    await markError(supabase, notificationId, msg)
    // Provider throttling and outages are retryable. The outbox bounds all attempts.
    const status = sendRes.status >= 500 || sendRes.status === 429 ? 500 : 200
    return jsonResponse(status, { error: msg, status: sendRes.status })
  }

  if (!await markSent(supabase, notificationId, sendJson.id)) {
    return jsonResponse(500, { error: 'acceptance_persist_unavailable' })
  }
  return jsonResponse(200, { sent: true, message_id: sendJson.id })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walks hosts → moderators → producers → profiles looking for a row whose
 * user_id (or, for profiles, id) matches the recipient_id. Returns the first
 * match with a non-disabled email. The profiles fall-through exists so admin
 * recipients (who have NO host/moderator/producer row) still receive
 * admin-targeted emails — cancellation_request being the current trigger.
 */
async function resolveRecipientEmail(
  supabase: SupabaseClient,
  userId: string,
  assignedRole?: RecipientRole,
): Promise<ResolvedRecipient | null> {
  const tables: Array<{ name: string; role: RecipientRole }> = [
    { name: 'hosts', role: 'host' },
    { name: 'moderators', role: 'moderator' },
    { name: 'producers', role: 'producer' },
  ]
  for (const { name, role } of tables) {
    if (assignedRole && assignedRole !== role) continue
    const { data, error } = await supabase
      .from(name)
      .select('email, email_disabled_at, name')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      console.error(`[resolveRecipientEmail] ${name} query failed`, error)
      throw new Error('recipient_lookup_unavailable')
    }
    const row = data as { email: string | null; email_disabled_at: string | null; name: string | null } | null
    if (row?.email && !row.email_disabled_at) {
      return { email: row.email, role, name: row.name }
    }
  }

  if (assignedRole && assignedRole !== 'admin') return null

  // Admin fallback. `profiles` is keyed by auth.users.id (== recipient_id)
  // and stores the email from auth.users. Migration083 tracks bounce-disable
  // on profiles as well, including administrator alerts.
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('email, full_name, role, email_disabled_at')
    .eq('id', userId)
    .maybeSingle()
  if (profileErr) {
    console.error('[resolveRecipientEmail] profiles query failed', profileErr)
    throw new Error('recipient_lookup_unavailable')
  }
  const profile = profileData as { email: string | null; full_name: string | null; role: string | null; email_disabled_at: string | null } | null
  if (profile?.email && profile.role === 'admin' && !profile.email_disabled_at) {
    return { email: profile.email, role: 'admin', name: profile.full_name }
  }
  return null
}

function buildRenderable(
  n: any,
  recipient: ResolvedRecipient,
): RenderableNotification {
  const type = n.type as NotificationType

  // For shift_* and shift_reminder, build a single-shift array from the
  // denormalized columns. Bulk variants will replace this with a multi-row
  // array once the bulk-book RPCs (migration 039) land.
  const shifts =
    n.shift_start && n.shift_end
      ? [
          {
            start: n.shift_start as string,
            end: n.shift_end as string,
            role: n.reminder_role ?? recipient.role,
            brandName: (n.brand_name as string) ?? 'Studio',
          },
        ]
      : []

  // For *_request notifications, host_name is the actor (the host who
  // initiated the request). For shift_* notifications, host_name is the
  // host on the shift (display info). Templates interpret per their type.
  const actorName = type.endsWith('_request') ||
    type.endsWith('_request_approved') ||
    type.endsWith('_request_denied')
    ? (n.host_name as string | undefined)
    : undefined

  return {
    type,
    recipientName: recipient.name ?? 'there',
    recipientRole: recipient.role,
    brand: {
      id: (n.brand_id as string | null) ?? '',
      name: (n.brand_name as string | null) ?? 'Studio',
    },
    shifts,
    appUrl: APP_URL,
    actorName,
    body: (n.body as string | null) ?? undefined,
    reminderMode: n.email_deferred && type === 'shift_reminder'
      ? (n.body === 'late' ? 'late' : n.body === 'corrected' ? 'corrected' : 'scheduled')
      : undefined,
  }
}

async function markSent(
  supabase: SupabaseClient,
  id: string,
  messageId: string,
) {
  const { error } = await supabase
    .from('notifications')
    .update({
      email_sent_at: new Date().toISOString(),
      email_message_id: messageId,
      email_error: null,
    })
    .eq('id', id)
  if (error) console.error('[markSent] failed', id, error)
  return !error
}

async function markError(
  supabase: SupabaseClient,
  id: string,
  error: string,
) {
  const { error: err } = await supabase
    .from('notifications')
    .update({ email_error: error })
    .eq('id', id)
  if (err) console.error('[markError] failed', id, err)
}

async function markSkipped(
  supabase: SupabaseClient,
  id: string,
  reason: string,
) {
  const { error } = await supabase
    .from('notifications')
    .update({ email_skipped_reason: reason })
    .eq('id', id)
  if (error) console.error('[markSkipped] failed', id, error)
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
