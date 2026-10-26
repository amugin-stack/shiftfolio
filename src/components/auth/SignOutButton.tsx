'use client'

// Minimal sign-out control. Extracted because the deactivated-account screen
// in (dashboard)/layout.tsx is a server component and there is no
// /auth/signout route — the app signs out client-side via the Supabase SDK
// (same call SidebarNav makes).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function SignOutButton({ className }: { className?: string }) {
  const supabase = createClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleSignOut() {
    setBusy(true)
    await supabase.auth.signOut()
    router.replace('/login')
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      className={className ?? 'text-sm text-primary hover:underline disabled:opacity-50'}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
