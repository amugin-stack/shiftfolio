import { redirect } from 'next/navigation'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { ProfileForm } from '@/components/onboarding/ProfileForm'

export default async function SettingsProfilePage() {
  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)

  // Sidebar already loads a fresh signed URL each render — for the settings
  // form we just point at the API proxy so users always see the current photo.
  const headshotUrl = profile?.headshot_path ? `/api/headshot/${user.id}` : null

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <ProfileForm
        userId={user.id}
        initial={profile}
        headshotUrl={headshotUrl}
        mode="settings"
      />
    </div>
  )
}
