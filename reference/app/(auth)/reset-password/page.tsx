'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { parseRecoveryLink, RESET_REQUESTED_KEY } from '@/lib/auth/recoveryLink'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Status = 'checking' | 'ready' | 'invalid' | 'saving'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [status, setStatus] = useState<Status>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // Strict Mode runs effects twice in dev; a recovery code is single-use.
    if (started.current) return
    started.current = true

    // Read the credentials, then strip them from the address bar BEFORE the
    // Supabase client is created: the client would otherwise try (and fail)
    // to consume implicit-flow tokens itself, and they should not linger in
    // history either.
    const link = parseRecoveryLink(window.location.href)
    window.history.replaceState(null, '', '/reset-password')
    const supabase = createClient()

    async function establish() {
      switch (link.kind) {
        case 'error':
          setError(link.message)
          return false
        case 'implicit':
          return !(await supabase.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken })).error
        case 'code':
          return !(await supabase.auth.exchangeCodeForSession(link.code)).error
        case 'token_hash':
          return !(await supabase.auth.verifyOtp({ type: 'recovery', token_hash: link.tokenHash })).error
        case 'none':
          // e.g. a reload after the link was already consumed on this page.
          return !!(await supabase.auth.getUser()).data.user
      }
    }

    establish().then(ok => {
      if (ok) setStatus('ready')
      else {
        setError(prev => prev ?? 'This reset link is not valid or has expired. Request a new one below.')
        setStatus('invalid')
      }
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 6) return setError('Use at least 6 characters.')
    if (password !== confirm) return setError('The two passwords do not match.')
    setStatus('saving')
    const { error } = await createClient().auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setStatus('ready')
      return
    }
    try { window.localStorage.removeItem(RESET_REQUESTED_KEY) } catch {}
    router.replace('/calendar')
    router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8 gap-3">
          <Image
            src="/Studio-Gradient-Icon.png"
            alt="Studio"
            width={56}
            height={56}
            priority
            className="w-14 h-14 rounded-xl object-contain"
          />
          <div className="text-center">
            <h1 className="text-xl font-bold text-foreground">Studio</h1>
            <p className="text-sm text-muted-foreground">Internal Scheduler</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-foreground mb-1">Choose a new password</h2>

          {status === 'checking' && (
            <p role="status" className="text-sm text-muted-foreground">Checking your reset link…</p>
          )}

          {status === 'invalid' && (
            <div className="space-y-4">
              <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                {error}
              </p>
              <Link href="/login?forgot=1" className="block text-sm underline">Request a new reset link</Link>
            </div>
          )}

          {(status === 'ready' || status === 'saving') && (
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
                <p className="text-[11px] text-muted-foreground">At least 6 characters.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>

              {error && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={status === 'saving'}>
                {status === 'saving' ? 'Saving…' : 'Save new password'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
