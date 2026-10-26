// Reads the password-recovery credentials Supabase puts on the reset link.
//
// Three shapes reach us, depending on how the email was sent:
//  - Dashboard "Send password recovery" (implicit flow): the tokens arrive in
//    the URL hash, e.g. #access_token=…&refresh_token=…&type=recovery. Our
//    browser client is PKCE-only and rejects these, which is why the link used
//    to land silently on /login.
//  - The app's own "Forgot password?" (PKCE flow): ?code=… , exchangeable only
//    in the browser that requested it.
//  - A customised email template: ?token_hash=…&type=recovery.
// Expired or reused links come back as #error=…&error_code=otp_expired.

export type RecoveryLink =
  | { kind: 'implicit'; accessToken: string; refreshToken: string }
  | { kind: 'code'; code: string }
  | { kind: 'token_hash'; tokenHash: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

export function parseRecoveryLink(href: string): RecoveryLink {
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const query = url.searchParams
  const get = (key: string) => hash.get(key) ?? query.get(key)

  if (get('error') || get('error_code') || get('error_description')) {
    const expired = get('error_code') === 'otp_expired'
    return {
      kind: 'error',
      message: expired
        ? 'This reset link has expired or was already used. Request a new one below.'
        : (get('error_description') ?? 'This reset link is not valid. Request a new one below.'),
    }
  }
  const accessToken = hash.get('access_token')
  const refreshToken = hash.get('refresh_token')
  if (accessToken && refreshToken) return { kind: 'implicit', accessToken, refreshToken }
  const tokenHash = query.get('token_hash')
  if (tokenHash && query.get('type') === 'recovery') return { kind: 'token_hash', tokenHash }
  const code = query.get('code')
  if (code) return { kind: 'code', code }
  return { kind: 'none' }
}

// Dashboard-sent links redirect to the Site URL; the middleware then bounces
// signed-out visitors to /login, and the browser keeps the hash. /login uses
// this to forward such arrivals to /reset-password.
export function isRecoveryHash(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return params.get('type') === 'recovery' || params.has('error_code')
}

// The app's own "Forgot password?" link returns with ?code=… to
// /reset-password when that URL is on Supabase's Redirect URL allow-list.
// If it is not, Supabase falls back to the Site URL, and the middleware keeps
// the code while bouncing to /login. Only forward it when this browser asked
// for a reset recently, so sign-up confirmation codes are left alone.
export const RESET_REQUESTED_KEY = 'studio-reset-requested-at'
const RESET_REQUEST_TTL_MS = 2 * 60 * 60 * 1000

export function resetCodeToForward(search: string, requestedAt: string | null, now = Date.now()): string | null {
  const code = new URLSearchParams(search).get('code')
  const at = Number(requestedAt)
  if (!code || !requestedAt || !Number.isFinite(at) || now - at < 0 || now - at > RESET_REQUEST_TTL_MS) return null
  return code
}
