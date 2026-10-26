import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc } from '@/lib/utils'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { UnavailabilityManager, type Absence, type Worker } from '@/components/admin/UnavailabilityManager'

export default async function UnavailabilityPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const roles = await getSessionRoles(user.id, effectiveIsAdmin)
  if (!effectiveIsAdmin || roles.isDeactivated) redirect('/calendar')
  const supabase = await createClient()
  const page = Math.max(1, Math.min(1000, Number.parseInt((await searchParams).page ?? '1', 10) || 1))
  const pageSize = 50
  const today = nowPtAsUtc().toISOString().slice(0, 10)
  // Read one extra row for Next; never download years of expired absences.
  const onTruncated = () => { throw new Error('Too many workers to load unavailability.') }
  const [result, hosts, moderators] = await Promise.all([
    supabase.from('staff_unavailability')
      .select('id, host_id, moderator_id, start_date, end_date').gte('end_date', today)
      .order('start_date').order('id').range((page - 1) * pageSize, page * pageSize),
    fetchAllRows<Worker>(() => supabase.from('hosts').select('id, name, is_active').order('id'), { onTruncated }),
    fetchAllRows<Worker>(() => supabase.from('moderators').select('id, name, is_active').order('id'), { onTruncated }),
  ])
  if (result.error) throw new Error(result.error.message)
  const absences = (result.data ?? []) as Absence[]
  return <div className="p-6">
    <UnavailabilityManager key={page} initialAbsences={absences.slice(0, pageSize)} hosts={hosts} moderators={moderators} />
    <nav aria-label="Unavailability pages" className="flex items-center gap-4 mt-4 text-sm">
      {page > 1 && <Link className="underline" href={`/admin/unavailability?page=${page - 1}`}>Previous</Link>}
      <span>Page {page}</span>
      {absences.length > pageSize && <Link className="underline" href={`/admin/unavailability?page=${page + 1}`}>Next</Link>}
    </nav>
  </div>
}
