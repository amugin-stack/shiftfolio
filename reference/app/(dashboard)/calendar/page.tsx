import { redirect } from 'next/navigation'
import Link from 'next/link'
import { CalendarDays, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { resolveRole } from '@/lib/role'
import {
  getModeratorBrandIds,
  getSessionProfile,
  getSessionRoles,
  getSessionUser,
} from '@/lib/auth/session'
import { BRAND_PUBLIC_COLUMNS, type Brand } from '@/lib/supabase/types'

export default async function CalendarLandingPage() {
  const supabase = await createClient()

  // Shared with the dashboard layout for this request (src/lib/auth/session.ts).
  // This page is a redirect hop, so it used to re-run the layout's identity
  // work and then make the layout run it a third time at the destination.
  const user = await getSessionUser()
  if (!user) redirect('/login')

  const [profile, { data: brandsData }] = await Promise.all([
    getSessionProfile(user.id),
    // This page only uses brand id + name to redirect — no need for pricing.
    supabase.from('brands').select(BRAND_PUBLIC_COLUMNS).order('name'),
  ])

  const allBrands = (brandsData as unknown as Brand[] | null) ?? []
  const { effectiveIsAdmin } = await resolveRole(profile)

  // Brand list by role for non-admins (the support team 2026-07-21 access model):
  //   - Producer: every brand (view-only).
  //   - Moderator: brands where they have at least one assigned stream.
  //   - Host: NONE — hosts are passive and land on /my-shifts (below).
  let brands = allBrands
  if (!effectiveIsAdmin) {
    // Was two bespoke producers/moderators lookups here, duplicating what the
    // layout had already resolved for this same request. Same answers, one
    // shared resolution — and the same helper the layout uses, so the two can
    // no longer drift apart.
    const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)

    if (userRoles.isProducer) {
      brands = allBrands // producers view all brand schedules
    } else {
      const allowed = userRoles.moderatorId
        ? await getModeratorBrandIds()
        : new Set<string>()
      brands = allBrands.filter(b => allowed.has(b.id))
    }
  }

  if (brands.length > 0) {
    redirect(`/calendar/${brands[0].id}`)
  }

  // Non-admins with no brand calendar (notably hosts) belong on My Shifts.
  if (!effectiveIsAdmin) {
    redirect('/my-shifts')
  }

  // Empty state — no brands exist yet
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mx-auto">
          <CalendarDays className="w-6 h-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">No calendars yet</h1>
          <p className="text-sm text-muted-foreground">
            {effectiveIsAdmin
              ? 'Add your first brand to create a calendar.'
              : 'Ask an admin to add a brand to get started.'}
          </p>
        </div>
        {effectiveIsAdmin && (
          <Button asChild size="sm" className="gap-2">
            <Link href="/admin/brands">
              <Plus className="w-4 h-4" />
              Add Brand
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}
