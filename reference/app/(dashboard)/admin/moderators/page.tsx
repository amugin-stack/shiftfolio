import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { ModeratorsManager } from '@/components/admin/ModeratorsManager'
import { resolveRole } from '@/lib/role'
import {
  PROFILE_PICKER_COLUMNS, MODERATOR_PUBLIC_COLUMNS, type Moderator, type ModeratorPublic, type Profile } from '@/lib/supabase/types'

export default async function ModeratorsPage() {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)
  if (!userRoles.isScheduler) redirect('/calendar')

  // rate_cents is column-locked (migration 055) — fetch moderators on the safe
  // columns and merge each rate from the admin-only RPC. Admin-only page
  // (guard above), so the RPC returns the full map (empty for non-admins).
  const [{ data: moderatorsData }, { data: profilesData }, rateMapData, contactsData] = await Promise.all([
    supabase.from('moderators').select(MODERATOR_PUBLIC_COLUMNS).order('name'),
    supabase.from('profiles').select(PROFILE_PICKER_COLUMNS).order('email'),
    fetchAllRows(() => supabase.rpc('admin_moderator_rate_map') as never),
    // email/phone are column-locked (migration 066) — see the hosts page.
    fetchAllRows(() => supabase.rpc('admin_moderator_contacts') as never),
  ])

  const rateByModeratorId = new Map<string, number>()
  for (const r of ((rateMapData ?? []) as { moderator_id: string; rate_cents: number }[])) {
    rateByModeratorId.set(r.moderator_id, r.rate_cents)
  }
  const contactByModeratorId = new Map<string, { email: string | null; phone: string | null }>()
  for (const c of ((contactsData ?? []) as { moderator_id: string; email: string | null; phone: string | null }[])) {
    contactByModeratorId.set(c.moderator_id, { email: c.email, phone: c.phone })
  }
  const moderators = ((moderatorsData as unknown as ModeratorPublic[] | null) ?? [])
    .map(m => ({
      ...m,
      rate_cents: rateByModeratorId.get(m.id) ?? 0,
      email: contactByModeratorId.get(m.id)?.email ?? null,
      phone: contactByModeratorId.get(m.id)?.phone ?? null,
    }))

  return (
    <div className="p-6">
      <ModeratorsManager
        initialModerators={moderators as unknown as Moderator[]}
        profiles={(profilesData as Profile[] | null) ?? []}
        canEditRates={effectiveIsAdmin}
      />
    </div>
  )
}
