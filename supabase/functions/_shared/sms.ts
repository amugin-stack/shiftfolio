/**
 * SMS transport shared by sms-send and sms-inbound.
 *
 * `SmsProvider` is the adapter boundary: sms-send calls `send()` and never
 * touches Twilio's HTTP shape directly, so the provider can be swapped or
 * stubbed in tests without touching the Edge Function.
 *
 * `verifyTwilioSignature` implements Twilio's request-signing algorithm
 * (https://www.twilio.com/docs/usage/security#validating-requests): HMAC-SHA1
 * over the full request URL followed by every POST param, sorted by key name,
 * each appended as `key + value` with no separator, keyed by the account auth
 * token, base64-encoded, compared in constant time against the
 * X-Twilio-Signature header.
 *
 * Env vars (Deno.env only — never read from a file, never logged):
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_MESSAGING_SERVICE_SID
 *   - SMS_WEBHOOK_SECRET        (shared secret for sms-send, mirrors WEBHOOK_SECRET)
 *   - SUPABASE_URL              (auto-injected)
 *   - SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   - SMS_INBOUND_PUBLIC_URL    (the exact public URL Twilio POSTs to; required
 *                                 for inbound signature verification, since Twilio
 *                                 signs the URL it called, not any URL we infer)
 */

export interface SmsProvider {
  send(to: string, body: string): Promise<{ sid: string }>
}

export interface SmsSendError extends Error {
  status?: number
}

const TWILIO_TIMEOUT_MS = 15_000

export class TwilioSmsProvider implements SmsProvider {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly messagingServiceSid: string,
  ) {}

  async send(to: string, body: string): Promise<{ sid: string }> {
    throw new Error('SMS transport is disabled in the portfolio demo')
    const form = new URLSearchParams()
    form.set('To', to)
    form.set('Body', body)
    form.set('MessagingServiceSid', this.messagingServiceSid)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${this.accountSid}:${this.authToken}`),
          },
          body: form.toString(),
        },
      )
    } catch (e) {
      // Never include `to`/`body` in a thrown message — no PII in logs.
      const err: SmsSendError = new Error(
        e instanceof Error && e.name === 'AbortError' ? 'twilio_request_timeout' : 'twilio_network_error',
      )
      throw err
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const err: SmsSendError = new Error(`twilio_http_${res.status}`)
      err.status = res.status
      throw err
    }

    const json = (await res.json().catch(() => ({}))) as { sid?: string }
    if (!json.sid) {
      const err: SmsSendError = new Error('twilio_missing_sid')
      throw err
    }
    return { sid: json.sid }
  }
}

/** Builds a TwilioSmsProvider from Deno.env, or returns null if unconfigured. */
export function createTwilioProviderFromEnv(): TwilioSmsProvider | null {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID')
  if (!accountSid || !authToken || !messagingServiceSid) return null
  return new TwilioSmsProvider(accountSid, authToken, messagingServiceSid)
}

// ---------------------------------------------------------------------------
// Twilio request signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies an X-Twilio-Signature header against the account auth token.
 * `fullUrl` must be the exact URL Twilio invoked (scheme, host, path, query —
 * no trailing modifications), and `params` the full set of POST form fields
 * exactly as received.
 */
export async function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false

  let data = fullUrl
  for (const key of Object.keys(params).sort()) {
    data += key + params[key]
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const expected = arrayBufferToBase64(sigBuffer)

  return timingSafeEqual(expected, signatureHeader)
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
