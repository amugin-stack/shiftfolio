import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProfileForm } from '@/components/onboarding/ProfileForm'
import type { Profile } from '@/lib/supabase/types'

export default async function OnboardingProfilePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profileData } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  const profile = profileData as Profile | null

  // Preview any existing headshot through our own authenticated proxy, the same
  // way the settings page does (CLAUDE.md rule 28: private buckets are never
  // served by signed/public URL).
  //
  // This used to mint a 1-hour signed storage URL. A signed URL is a bearer
  // credential sitting in a query string: it lands in browser history, leaks
  // via the Referer header on any outbound link, shows up in screenshots and
  // screen shares of the address bar, and is captured by any proxy or corporate
  // TLS-inspecting log — and for that hour it grants UNAUTHENTICATED read of a
  // contractor's headshot to anyone holding it. /api/headshot/[userId] does a
  // self-or-admin check on every request instead, and logs nothing.
  const headshotUrl = profile?.headshot_path ? `/api/headshot/${user.id}` : null

  return (
    <ProfileForm
      userId={user.id}
      initial={profile}
      headshotUrl={headshotUrl}
    />
  )
}
