import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { ProducersManager } from '@/components/admin/ProducersManager'
import { resolveRole } from '@/lib/role'
import { PROFILE_PICKER_COLUMNS, type Producer, type Profile } from '@/lib/supabase/types'

export default async function ProducersPage() {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)
  if (!userRoles.isScheduler) redirect('/calendar')

  const [{ data: producersData }, { data: profilesData }] = await Promise.all([
    supabase.from('producers').select('*').order('name'),
    supabase.from('profiles').select(PROFILE_PICKER_COLUMNS).order('email'),
  ])

  return (
    <div className="p-6">
      <ProducersManager
        initialProducers={(producersData as Producer[] | null) ?? []}
        profiles={(profilesData as Profile[] | null) ?? []}
      />
    </div>
  )
}
