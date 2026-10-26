import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { Topbar } from '@/components/topbar/Topbar'
import { resolveRole } from '@/lib/role'
import {
  getModeratorBrandIds,
  getSessionProfile,
  getSessionRoles,
  getSessionUser,
} from '@/lib/auth/session'
import { isProfileComplete } from '@/lib/profile'
import { SignOutButton } from '@/components/auth/SignOutButton'
import { BRAND_PUBLIC_COLUMNS, type Brand } from '@/lib/supabase/types'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  // Request-scoped cache (src/lib/auth/session.ts): the page rendered inside
  // this layout asks the same questions, and now shares the answers instead of
  // re-issuing an auth round-trip plus four queries.
  const user = await getSessionUser()

  if (!user) redirect('/login')

  // Sidebar only needs name + logo_path + day/block config + linked-user id; the
  // pricing column is sensitive and only the admin Dashboard / Brands editor
  // needs it. Even before we know the caller's role, fetch the safe subset —
  // the sidebar / nav consumers never read client_rate_cents anyway.
  const [profile, { data: brandsData }] = await Promise.all([
    getSessionProfile(user.id),
    supabase.from('brands').select(BRAND_PUBLIC_COLUMNS).order('name'),
  ])

  // Forced onboarding gate: incomplete profiles can't reach the app
  if (!isProfileComplete(profile)) {
    redirect('/onboarding/profile')
  }

  // BRAND_PUBLIC_COLUMNS produces BrandPublic rows; we widen to Brand for the
  // Sidebar prop because no sidebar consumer touches client_rate_cents.
  const allBrands = (brandsData as unknown as Brand[] | null) ?? []
  const { actualIsAdmin, viewingAsHost } = await resolveRole(profile)
  const effectiveIsAdmin = actualIsAdmin && !viewingAsHost

  // Resolve all role memberships (host / producer / moderator) in one shot.
  const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)

  // Access removed (the support team 2026-08-25): deactivating a host/moderator used to
  // leave their login working, so a removed worker could still sign in and
  // read their old shifts. Every dashboard page renders through this layout,
  // so gating here covers all of them at once. Backed by RLS in migration 058
  // — this is the UX half; the DB is the real boundary (CLAUDE.md rule 26).
  if (userRoles.isDeactivated) {
    return (
      <div className="h-dvh flex items-center justify-center p-6 bg-background">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-lg font-semibold text-foreground">Access removed</h1>
          <p className="text-sm text-muted-foreground">
            Your account is no longer active on Studio. If you think this is a mistake,
            contact your manager.
          </p>
          <Link href="/past-pay" className="block text-sm underline">View your past pay</Link>
          <SignOutButton />
        </div>
      </div>
    )
  }

  const hasHostProfile = userRoles.isHost

  // Brand visibility (the support team 2026-07-21 access model):
  //   admin       → every brand
  //   producer    → every brand (view-only across all schedules)
  //   moderator   → only brands where they have a stream assignment
  //   host only   → NONE (hosts are passive — they use My Shifts, never a
  //                 brand calendar), so no brand links appear in their sidebar
  let brands = allBrands
  if (!effectiveIsAdmin) {
    if (userRoles.isProducer) {
      // Producers see all brand schedules (read-only), same list as admins.
      brands = allBrands
    } else {
      // Hosts contribute nothing here — no brand-calendar access.
      const allowed = userRoles.isModerator && userRoles.moderatorId
        ? await getModeratorBrandIds()
        : new Set<string>()
      brands = allBrands.filter(b => allowed.has(b.id))
    }
  }

  // Avatar served via our own API proxy — bypasses the Cloudflare/Supabase
  // CDN edge case where a Range probe can poison the cache with 1 byte.
  const headshotUrl = profile?.headshot_path
    ? `/api/headshot/${user.id}`
    : null

  // Shared sidebar payload — desktop renders <Sidebar> permanently; the
  // mobile drawer in <Topbar> re-renders the same content via MobileSidebar.
  const sidebarProps = {
    profile,
    brands,
    actualIsAdmin,
    viewingAsHost,
    hasHostProfile,
    isProducer: userRoles.isProducer,
    isModerator: userRoles.isModerator,
    headshotUrl,
    userId: user.id,
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar {...sidebarProps} />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar userId={user.id} sidebarProps={sidebarProps} />
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
