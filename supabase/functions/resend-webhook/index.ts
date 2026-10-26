/**
 * resend-webhook Edge Function
 *
 * Receives delivery events from Resend (delivered, bounced, complained, etc.)
 * via Resend Dashboard → Webhooks. Logs every event to public.email_events
 * for visibility, and on bounce/complaint marks the recipient's
 * email_disabled_at on the matching role table row so future sends skip them.
 *
 * Auth: verify_jwt=false. Resend webhook signatures are validated via Svix
 * (the signing system Resend uses). The signing secret is in
 * RESEND_WEBHOOK_SECRET. We verify the svix-signature header matches an
 * HMAC-SHA256 of `${svix-id}.${svix-timestamp}.${body}` keyed by the
 * decoded webhook secret.
 *
 * Env vars expected:
 *   - RESEND_WEBHOOK_SECRET (required; the "whsec_..." string from Resend dashboard)
 *   - SUPABASE_URL          (auto-injected)
 *   - SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

interface ResendEvent {
  type:
    | 'email.sent'
    | 'email.delivered'
    | 'email.delivery_delayed'
    | 'email.complained'
    | 'email.bounced'
    | 'email.opened'
    | 'email.clicked'
    | 'email.failed'
  created_at: string
  data: {
    email_id?: string
    to?: string[]
    from?: string
    subject?: string
    bounce?: { type?: string; subType?: string; message?: string }
    [k: string]: unknown
  }
}

Deno.serve(async (req: Request) => {
  // Retained for architecture review only. No live email workflow is available.
  return new Response('Portfolio transport disabled', { status: 410 })

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' })
  }

  const signingSecret = Deno.env.get('RESEND_WEBHOOK_SECRET')
  if (!signingSecret) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET not configured')
    return jsonResponse(500, { error: 'webhook_secret_not_configured' })
  }

  // Read body as text first so we can verify the signature, then parse JSON.
  const rawBody = await req.text()
  const svixId = req.headers.get('svix-id') ?? ''
  const svixTimestamp = req.headers.get('svix-timestamp') ?? ''
  const svixSignature = req.headers.get('svix-signature') ?? ''

  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonResponse(400, { error: 'missing_svix_headers' })
  }

  const verified = await verifySvixSignature(
    signingSecret,
    svixId,
    svixTimestamp,
    rawBody,
    svixSignature,
  )
  if (!verified) {
    return jsonResponse(401, { error: 'invalid_signature' })
  }

  let event: ResendEvent
  try {
    event = JSON.parse(rawBody) as ResendEvent
  } catch {
    return jsonResponse(400, { error: 'invalid_json' })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  if (!validEvent(event)) return jsonResponse(400, { error: 'invalid_event' })
  // Event receipt, audit rows, and suppression are one database transaction.
  // A failed transaction leaves no receipt, so the provider can safely retry.
  const { data, error } = await supabase.rpc('_process_resend_event', {
    p_event_id: svixId,
    p_event: event,
  })
  if (error) {
    console.error('[resend-webhook] event transaction failed')
    return jsonResponse(500, { error: 'event_processing_failed' })
  }
  return jsonResponse(200, { ok: true, duplicate: data === false })
})

// ---------------------------------------------------------------------------
// Svix signature verification (Resend's webhook signing format)
// ---------------------------------------------------------------------------

/**
 * Verifies an svix-signature header against the signing secret. svix-signature
 * is a space-separated list of `v1,base64-signature` pairs. Any matching
 * signature is sufficient.
 *
 * See https://www.svix.com/docs/receiving/verifying-payloads/how-manual/
 */
async function verifySvixSignature(
  signingSecret: string,
  svixId: string,
  svixTimestamp: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  // Svix signs each delivery attempt with a fresh timestamp. Reject replay
  // outside five minutes in either direction before any database operation.
  if (!/^\d+$/.test(svixTimestamp) || svixId.length > 256) return false
  const timestamp = Number(svixTimestamp)
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  // Resend's signing secret comes as "whsec_<base64>". Strip the prefix and
  // base64-decode to get the raw HMAC key.
  const secret = signingSecret.replace(/^whsec_/, '')
  let keyBytes: Uint8Array
  try {
    keyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0))
  } catch {
    return false
  }

  const signedContent = `${svixId}.${svixTimestamp}.${body}`
  const expectedSig = await hmacSha256Base64(keyBytes, signedContent)

  // Header format: "v1,base64sig v1,base64sig2 ..."
  const presented = signatureHeader
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3))

  for (const sig of presented) {
    if (timingSafeEqual(sig, expectedSig)) return true
  }
  return false
}

async function hmacSha256Base64(keyBytes: Uint8Array, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return arrayBufferToBase64(sigBuffer)
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function validEvent(event: ResendEvent): boolean {
  const types = ['email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.complained', 'email.bounced', 'email.opened', 'email.clicked', 'email.failed']
  return !!event && typeof event === 'object' && types.includes(event.type)
    && typeof event.created_at === 'string' && Number.isFinite(Date.parse(event.created_at))
    && !!event.data && typeof event.data === 'object'
    && typeof event.data.email_id === 'string' && event.data.email_id.length > 0
    && event.data.email_id.length <= 256
    && Array.isArray(event.data.to) && event.data.to.length > 0 && event.data.to.length <= 100
    && event.data.to.every(email => typeof email === 'string' && email.length <= 320
      && /^[^\s@]+@[^\s@]+$/.test(email))
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
