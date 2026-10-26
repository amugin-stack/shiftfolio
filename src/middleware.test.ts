import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'

describe('portfolio route boundary', () => {
  it.each(['/', '/favicon.ico', '/_next/static/chunks/app.js'])(
    'allows public demo asset %s', path => {
      const response = middleware(new NextRequest(`https://synthetic.invalid${path}`))
      expect(response.headers.get('x-middleware-next')).toBe('1')
      const csp = response.headers.get('content-security-policy')
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("object-src 'none'")
    },
  )

  it.each([
    '/login', '/onboarding', '/admin', '/past-pay', '/api/anything',
    '/_next/image?url=remote', '/Studio-Gradient-Icon.png',
  ])('returns 404 for original route %s', path => {
    const response = middleware(new NextRequest(`https://synthetic.invalid${path}`))
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })
})
