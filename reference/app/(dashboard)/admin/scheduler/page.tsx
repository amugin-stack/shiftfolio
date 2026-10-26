import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { resolveRole } from '@/lib/role'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { BRAND_PUBLIC_COLUMNS, type BrandPublic } from '@/lib/supabase/types'
import { SchedulerManager } from '@/components/admin/scheduler/SchedulerManager'
import type { BotBookingRow } from '@/components/admin/scheduler/BotBookingsSection'
import type { RequestRow } from '@/components/admin/scheduler/RequestsSection'
import type { ContactWorker } from '@/components/admin/scheduler/PoolsContactsSection'

interface WorkerRow { id: string; name: string; is_active: boolean }

export default async function SchedulerPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const roles = await getSessionRoles(user.id, effectiveIsAdmin)
  // Admin-only, same gate as /admin/unavailability — the auto-scheduler
  // touches real pay (who works a shift) and real phone numbers.
  if (!effectiveIsAdmin || roles.isDeactivated) redirect('/calendar')

  const supabase = await createClient()
  const onTruncated = () => { throw new Error('Too many rows to load the auto-scheduler page.') }

  const [
    runtimeRes,
    brandsRes,
    hosts,
    moderators,
    brandModeratorsRes,
    contactsRes,
    botBookingsRes,
    requestsRes,
    textsRes,
  ] = await Promise.all([
    supabase.from('scheduler_runtime').select('*').eq('singleton', true).single(),
    fetchAllRows<BrandPublic>(() => supabase.from('brands').select(BRAND_PUBLIC_COLUMNS).order('name') as never, { onTruncated }),
    fetchAllRows<WorkerRow>(() => supabase.from('hosts').select('id, name, is_active').order('name'), { onTruncated }),
    fetchAllRows<WorkerRow>(() => supabase.from('moderators').select('id, name, is_active').order('name'), { onTruncated }),
    fetchAllRows<{ brand_id: string; moderator_id: string }>(() => supabase.from('brand_moderators').select('brand_id, moderator_id'), { onTruncated }),
    fetchAllRows<{ phone_e164: string; host_id: string | null; moderator_id: string | null; opt_in_at: string | null; opt_in_source: string | null; opted_out_at: string | null }>(
      () => supabase.from('sms_contacts').select('*'), { onTruncated },
    ),
    supabase.from('bot_bookings')
      .select('id, role, worker_id, booked_at, undone_at, coverage_requests(brand_id, run_start, run_end)')
      .order('booked_at', { ascending: false }).limit(50),
    supabase.from('coverage_requests')
      .select('id, role, brand_id, run_start, run_end, status, coverage_offers(worker_id, state, sent_at)')
      .in('status', ['open', 'escalated']).order('run_start'),
    supabase.from('sms_outbox').select('*').order('created_at', { ascending: false }).limit(50),
  ])

  if (runtimeRes.error) throw new Error(runtimeRes.error.message)
  if (botBookingsRes.error) throw new Error(botBookingsRes.error.message)
  if (requestsRes.error) throw new Error(requestsRes.error.message)
  if (textsRes.error) throw new Error(textsRes.error.message)

  const brandNameById = new Map(brandsRes.map(b => [b.id, b.name]))
  const hostNameById = new Map(hosts.map(h => [h.id, h.name]))
  const moderatorNameById = new Map(moderators.map(m => [m.id, m.name]))
  const workerName = (role: 'host' | 'moderator', id: string) =>
    (role === 'host' ? hostNameById.get(id) : moderatorNameById.get(id)) ?? 'Unknown person'

  // --- Bot bookings ---
  type BotBookingJoined = {
    id: string
    role: 'host' | 'moderator'
    worker_id: string
    booked_at: string
    undone_at: string | null
    coverage_requests: { brand_id: string; run_start: string; run_end: string } | { brand_id: string; run_start: string; run_end: string }[] | null
  }
  const botBookings: BotBookingRow[] = ((botBookingsRes.data ?? []) as unknown as BotBookingJoined[]).map(b => {
    const req = Array.isArray(b.coverage_requests) ? b.coverage_requests[0] : b.coverage_requests
    return {
      id: b.id,
      brandName: req ? (brandNameById.get(req.brand_id) ?? 'Unknown brand') : 'Unknown brand',
      role: b.role,
      workerName: workerName(b.role, b.worker_id),
      runStart: req?.run_start ?? b.booked_at,
      runEnd: req?.run_end ?? b.booked_at,
      bookedAt: b.booked_at,
      undoneAt: b.undone_at,
    }
  })

  // --- Open & escalated requests ---
  type CoverageRequestJoined = {
    id: string
    role: 'host' | 'moderator'
    brand_id: string
    run_start: string
    run_end: string
    status: string
    coverage_offers: { worker_id: string; state: string; sent_at: string }[] | null
  }
  const requests: RequestRow[] = ((requestsRes.data ?? []) as unknown as CoverageRequestJoined[]).map(r => ({
    id: r.id,
    brandName: brandNameById.get(r.brand_id) ?? 'Unknown brand',
    role: r.role,
    runStart: r.run_start,
    runEnd: r.run_end,
    status: r.status,
    offers: (r.coverage_offers ?? [])
      .slice()
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
      .map(o => ({ workerName: workerName(r.role, o.worker_id), state: o.state })),
  }))

  // --- Moderator pool per brand ---
  const moderatorPool = new Map<string, Set<string>>()
  for (const row of brandModeratorsRes) {
    if (!moderatorPool.has(row.brand_id)) moderatorPool.set(row.brand_id, new Set())
    moderatorPool.get(row.brand_id)!.add(row.moderator_id)
  }

  // --- SMS contacts, joined onto each roster entry ---
  const contactByHostId = new Map(contactsRes.filter(c => c.host_id).map(c => [c.host_id as string, c]))
  const contactByModeratorId = new Map(contactsRes.filter(c => c.moderator_id).map(c => [c.moderator_id as string, c]))
  const contacts: ContactWorker[] = [
    ...hosts.map(h => {
      const c = contactByHostId.get(h.id)
      return {
        id: h.id, name: h.name, role: 'host' as const, isActive: h.is_active,
        phone: c?.phone_e164 ?? '', optInAt: c?.opt_in_at ?? null,
        optInSource: c?.opt_in_source ?? null, optedOutAt: c?.opted_out_at ?? null,
      }
    }),
    ...moderators.map(m => {
      const c = contactByModeratorId.get(m.id)
      return {
        id: m.id, name: m.name, role: 'moderator' as const, isActive: m.is_active,
        phone: c?.phone_e164 ?? '', optInAt: c?.opt_in_at ?? null,
        optInSource: c?.opt_in_source ?? null, optedOutAt: c?.opted_out_at ?? null,
      }
    }),
  ].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="p-6">
      <SchedulerManager
        runtime={runtimeRes.data}
        brands={brandsRes}
        botBookings={botBookings}
        requests={requests}
        texts={textsRes.data ?? []}
        moderators={moderators}
        moderatorPool={moderatorPool}
        contacts={contacts}
      />
    </div>
  )
}
