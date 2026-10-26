/**
 * sms-inbound Edge Function
 *
 * Twilio's webhook target for inbound SMS replies (YES/NO/STOP/etc.). Verifies
 * the request actually came from Twilio via X-Twilio-Signature, forwards the
 * reply to the SECURITY DEFINER public.sched_handle_sms_reply RPC (which is
 * idempotent per MessageSid), and replies with TwiML so Twilio sends back
 * whatever text (if any) the scheduler decided on.
 *
 * Auth: verify_jwt=false; Twilio signs requests instead (see _shared/sms.ts).
 * SMS_INBOUND_PUBLIC_URL must be the exact URL configured in Twilio's console
 * as this function's webhook, because Twilio signs the URL it invoked, not
 * any URL this function could infer from request headers (those can be
 * rewritten by a proxy).
 *
 * Env vars expected:
 *   - TWILIO_AUTH_TOKEN, SMS_INBOUND_PUBLIC_URL (required)
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { verifyTwilioSignature } from '../_shared/sms.ts'

Deno.serve(async (req: Request) => {
  // Retained for architecture review only. No live SMS workflow is available.
  return new Response('Portfolio transport disabled', { status: 410 })

  if (req.method !== 'POST') {
    return textResponse(405, '')
  }

  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')
  const publicUrl = Deno.env.get('SMS_INBOUND_PUBLIC_URL')
  if (!authToken || !publicUrl) {
    console.error('[sms-inbound] TWILIO_AUTH_TOKEN or SMS_INBOUND_PUBLIC_URL not configured')
    return jsonResponse(500, { error: 'not_configured' })
  }

  const rawBody = await req.text()
  const params: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(rawBody)) {
    params[key] = value
  }

  const signatureHeader = req.headers.get('X-Twilio-Signature')
  const verified = await verifyTwilioSignature(authToken, publicUrl, params, signatureHeader)
  if (!verified) {
    return jsonResponse(403, { error: 'invalid_signature' })
  }

  const messageSid = params['MessageSid']
  const from = params['From']
  const smsBody = params['Body']
  if (!messageSid || !from || smsBody === undefined) {
    return jsonResponse(400, { error: 'missing_required_field' })
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

  const { data: reply, error } = await supabase.rpc('sched_handle_sms_reply', {
    p_provider_sid: messageSid,
    p_from: from,
    p_body: smsBody,
  })
  if (error) {
    console.error('[sms-inbound] sched_handle_sms_reply failed')
    // 500 so Twilio retries; the RPC is idempotent by MessageSid, so a retry
    // after a transient failure is safe.
    return textResponse(500, '')
  }

  const twiml = reply
    ? `<Response><Message>${escapeXml(reply)}</Message></Response>`
    : '<Response/>'
  return textResponse(200, twiml)
})

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml' },
  })
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
