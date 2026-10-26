/**
 * sms-send Edge Function
 *
 * Invoked only by public._dispatch_sms_outbox() (migration 090) via
 * net.http_post, one call per outbox row. Claims the row through the
 * SECURITY DEFINER sms_claim_for_send RPC (which revalidates the row is
 * still queued and, for offer texts, that the coverage offer is still
 * pending and unexpired), sends through the configured SmsProvider, and
 * records the outcome via sms_mark_result.
 *
 * Auth: verify_jwt=false; instead validates a shared X-Webhook-Secret header
 * against SMS_WEBHOOK_SECRET, the same pattern send-notification-email uses
 * for WEBHOOK_SECRET.
 *
 * Env vars expected:
 *   - SMS_WEBHOOK_SECRET        (required)
 *   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID (required)
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { createTwilioProviderFromEnv, timingSafeEqual, type SmsProvider } from '../_shared/sms.ts'

interface RequestBody {
  id?: string
}

Deno.serve(async (req: Request) => {
  // Retained for architecture review only. Portfolio copies never send SMS.
  return jsonResponse(410, { error: 'portfolio_transport_disabled' })

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' })
  }

  const expectedSecret = Deno.env.get('SMS_WEBHOOK_SECRET')
  if (!expectedSecret) {
    console.error('[sms-send] SMS_WEBHOOK_SECRET not configured')
    return jsonResponse(500, { error: 'webhook_secret_not_configured' })
  }
  const presentedSecret = req.headers.get('X-Webhook-Secret')
  if (!presentedSecret || !timingSafeEqual(presentedSecret, expectedSecret)) {
    return jsonResponse(401, { error: 'invalid_webhook_secret' })
  }

  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' })
  }
  if (!body.id) {
    return jsonResponse(400, { error: 'missing_id' })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) },
    },
  )

  const provider: SmsProvider | null = createTwilioProviderFromEnv()
  if (!provider) {
    console.error('[sms-send] Twilio env vars not configured')
    return jsonResponse(500, { error: 'twilio_not_configured' })
  }

  const { data: claimed, error: claimError } = await supabase.rpc('sms_claim_for_send', {
    p_id: body.id,
  })
  if (claimError) {
    console.error('[sms-send] claim failed')
    return jsonResponse(500, { error: 'claim_unavailable' })
  }
  const row = Array.isArray(claimed) ? claimed[0] : claimed
  if (!row || !row.to_e164 || !row.body) {
    // Nothing to send: already claimed elsewhere, canceled, or stale.
    return jsonResponse(200, { ok: true, skipped: true })
  }

  try {
    const { sid } = await provider.send(row.to_e164, row.body)
    const { error: markError } = await supabase.rpc('sms_mark_result', {
      p_id: body.id,
      p_provider_sid: sid,
      p_error: null,
    })
    if (markError) {
      console.error('[sms-send] mark_result (success) failed')
      return jsonResponse(500, { error: 'mark_result_unavailable' })
    }
    return jsonResponse(200, { ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown_error'
    const { error: markError } = await supabase.rpc('sms_mark_result', {
      p_id: body.id,
      p_provider_sid: null,
      p_error: message,
    })
    if (markError) {
      console.error('[sms-send] mark_result (error) failed')
      return jsonResponse(500, { error: 'mark_result_unavailable' })
    }
    // The provider/network failure itself is not this function's failure to
    // report to its caller — the outbox retry loop owns the retry policy.
    return jsonResponse(200, { ok: true, sent: false })
  }
})

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
