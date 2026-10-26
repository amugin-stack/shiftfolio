'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { isRecoveryHash, resetCodeToForward, RESET_REQUESTED_KEY } from '@/lib/auth/recoveryLink'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Mode = 'signin' | 'signup' | 'forgot'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    // A dashboard-sent reset link lands on the Site URL and is bounced here by
    // the middleware with its tokens still in the hash. Hand it to the reset
    // page instead of silently showing the sign-in form.
    if (isRecoveryHash(window.location.hash)) {
      window.location.replace(`/reset-password${window.location.hash}`)
      return
    }
    let requestedAt: string | null = null
    try { requestedAt = window.localStorage.getItem(RESET_REQUESTED_KEY) } catch {}
    const code = resetCodeToForward(window.location.search, requestedAt)
    if (code) {
      window.location.replace(`/reset-password?code=${encodeURIComponent(code)}`)
      return
    }
    if (new URLSearchParams(window.location.search).has('forgot')) setMode('forgot')
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setInfo(null)

    const supabase = createClient()

    if (mode === 'forgot') {
      try { window.localStorage.setItem(RESET_REQUESTED_KEY, String(Date.now())) } catch {}
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      // Same message whether or not the address has an account, so this form
      // cannot be used to check who works here. Only rate limits are surfaced.
      if (error && error.status === 429) {
        setError('Too many reset requests. Please wait a few minutes and try again.')
      } else {
        setInfo('If that email has an account, a reset link is on its way. Open it in this browser.')
      }
      setLoading(false)
      return
    }

    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
        setLoading(false)
      } else {
        router.push('/calendar')
        router.refresh()
      }
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName.trim() || null,
            phone: phone.trim() || null,
          },
        },
      })

      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }

      // If email confirmation is disabled, session is returned and we can redirect
      if (data.session) {
        router.push('/calendar')
        router.refresh()
      } else {
        setInfo('Check your email to confirm your account, then sign in.')
        setMode('signin')
        setPassword('')
        setLoading(false)
      }
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setInfo(null)
  }

  const isSignup = mode === 'signup'
  const isForgot = mode === 'forgot'

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
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

        {/* Card */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-xl">
          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-secondary rounded-md mb-5">
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className={`flex-1 text-sm font-medium py-1.5 rounded transition-colors ${
                mode === 'signin'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => switchMode('signup')}
              className={`flex-1 text-sm font-medium py-1.5 rounded transition-colors ${
                mode === 'signup'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Sign up
            </button>
          </div>

          <h2 className="text-lg font-semibold text-foreground mb-1">
            {isForgot ? 'Reset your password' : isSignup ? 'Create an account' : 'Welcome back'}
          </h2>
          <p className="text-sm text-muted-foreground mb-5">
            {isForgot
              ? 'Enter your email and we will send you a link to choose a new password.'
              : isSignup
                ? 'Sign up to get started with the scheduler.'
                : 'Enter your credentials to access the scheduler.'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignup && (
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Full Name</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="Jane Doe"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  autoComplete="name"
                />
              </div>
            )}

            {isSignup && (
              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  autoComplete="tel"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.invalid"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            {!isForgot && (
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                minLength={isSignup ? 6 : undefined}
              />
              {isSignup && (
                <p className="text-[11px] text-muted-foreground">At least 6 characters.</p>
              )}
              {mode === 'signin' && (
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="text-[12px] text-muted-foreground underline hover:text-foreground"
                >
                  Forgot password?
                </button>
              )}
            </div>
            )}

            {error && (
              <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            {info && (
              <p className="text-sm text-foreground bg-primary/10 border border-primary/30 rounded-md px-3 py-2">
                {info}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {isForgot
                ? loading ? 'Sending…' : 'Send reset link'
                : loading
                  ? isSignup ? 'Creating account…' : 'Signing in…'
                  : isSignup ? 'Create Account' : 'Sign in'}
            </Button>

            {isForgot && (
              <button
                type="button"
                onClick={() => switchMode('signin')}
                className="block w-full text-center text-sm text-muted-foreground underline hover:text-foreground"
              >
                Back to sign in
              </button>
            )}
          </form>
        </div>

        {isSignup && (
          <p className="text-center text-[11px] text-muted-foreground mt-4">
            New accounts are created as regular users. Ask an admin to grant you access.
          </p>
        )}
      </div>
    </div>
  )
}
