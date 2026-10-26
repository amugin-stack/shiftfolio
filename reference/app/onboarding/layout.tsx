import { redirect } from 'next/navigation'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { resolveRole } from '@/lib/role'
import { SignOutButton } from '@/components/auth/SignOutButton'

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getSessionUser()
  if (!user) redirect('/login')

  // Deactivation gate. This route group sits OUTSIDE (dashboard), so the
  // "Access removed" screen in (dashboard)/layout.tsx never ran for it — a
  // removed contractor could still open /onboarding/brands and request brands
  // (fanning an email to every admin), and still edit their PII at
  // /onboarding/profile. Mirrors the dashboard gate exactly.
  //
  // Backed by the database, not just this check: migration 065 rejects
  // request_brand for a deactivated caller (CLAUDE.md rule 26 — the UI is never
  // the boundary).
  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)
  if (userRoles.isDeactivated) {
    return (
      <div className="h-dvh flex items-center justify-center p-6 bg-background">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-lg font-semibold text-foreground">Access removed</h1>
          <p className="text-sm text-muted-foreground">
            Your account is no longer active on Studio. If you think this is a mistake,
            contact your manager.
          </p>
          <SignOutButton />
        </div>
      </div>
    )
  }

  // Page is reachable whether the profile is complete or not — the dashboard
  // layout still gates the rest of the app on completion. Visiting
  // /onboarding/profile after completion acts as an "edit profile" view.

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-start py-10 px-4">
      <div className="w-full max-w-xl">
        {children}
      </div>
    </div>
  )
}
