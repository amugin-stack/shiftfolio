import { expect, it } from 'vitest'
import { isRecoveryHash, parseRecoveryLink, resetCodeToForward } from './recoveryLink'

const BASE = 'https://example.test/reset-password'

it('reads dashboard-sent implicit tokens from the hash', () => {
  expect(parseRecoveryLink(`${BASE}#access_token=aaa&expires_in=3600&refresh_token=rrr&token_type=bearer&type=recovery`))
    .toEqual({ kind: 'implicit', accessToken: 'aaa', refreshToken: 'rrr' })
})

it('reads a PKCE code from the query', () => {
  expect(parseRecoveryLink(`${BASE}?code=ccc`)).toEqual({ kind: 'code', code: 'ccc' })
})

it('reads a token_hash recovery link, but only for type=recovery', () => {
  expect(parseRecoveryLink(`${BASE}?token_hash=hhh&type=recovery`)).toEqual({ kind: 'token_hash', tokenHash: 'hhh' })
  expect(parseRecoveryLink(`${BASE}?token_hash=hhh&type=signup`)).toEqual({ kind: 'none' })
})

it('explains an expired or reused link', () => {
  const r = parseRecoveryLink(`${BASE}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`)
  expect(r.kind).toBe('error')
  expect(r.kind === 'error' && r.message).toMatch(/expired/)
})

it('prefers an error over any tokens and returns none for a bare visit', () => {
  expect(parseRecoveryLink(`${BASE}?code=ccc#error=server_error`).kind).toBe('error')
  expect(parseRecoveryLink(BASE)).toEqual({ kind: 'none' })
  // A lone access token without its refresh token is not a usable session.
  expect(parseRecoveryLink(`${BASE}#access_token=aaa&type=recovery`)).toEqual({ kind: 'none' })
})

it('recognises recovery hashes that the middleware carried to /login', () => {
  expect(isRecoveryHash('#access_token=aaa&refresh_token=rrr&type=recovery')).toBe(true)
  expect(isRecoveryHash('#error=access_denied&error_code=otp_expired')).toBe(true)
  expect(isRecoveryHash('')).toBe(false)
  expect(isRecoveryHash('#section-2')).toBe(false)
})

it('forwards a returning reset code only when this browser recently asked for a reset', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  const asked = String(now - 10 * 60 * 1000)
  expect(resetCodeToForward('?code=ccc', asked, now)).toBe('ccc')
  expect(resetCodeToForward('?code=ccc', null, now)).toBeNull()
  expect(resetCodeToForward('?code=ccc', String(now - 3 * 60 * 60 * 1000), now)).toBeNull()
  expect(resetCodeToForward('?code=ccc', 'garbage', now)).toBeNull()
  expect(resetCodeToForward('', asked, now)).toBeNull()
})
