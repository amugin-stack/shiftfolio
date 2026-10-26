import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { UsersManager } from '@/components/admin/UsersManager'
import { resolveRole } from '@/lib/role'
import type { Profile } from '@/lib/supabase/types'

export default async function UsersPage() {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) redirect('/calendar')

  const { data: profilesData } = await supabase
    .from('profiles')
    .select('*')
    .order('role', { ascending: false }) // admins first
    .order('email')

  return (
    <div className="p-6">
      <UsersManager
        initialProfiles={(profilesData as Profile[] | null) ?? []}
        currentUserId={user.id}
      />
    </div>
  )
}
