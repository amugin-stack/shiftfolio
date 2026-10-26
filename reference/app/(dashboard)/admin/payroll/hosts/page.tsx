import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc, parseMonth } from '@/lib/utils'
import { computeHostShiftPayoutCents } from '@/lib/payout'
import {
  extraPayCents,
  extraPayDurationMinutes,
  isExtraPayRealized,
  EXTRA_PAY_ENABLED,
} from '@/lib/extraPay'
import { HostsDashboardView, type HostRow } from '@/components/admin/HostsDashboardView'

interface PageProps {
  searchParams: Promise<{ month?: string }>
}

export default async function HostDashboardListPage({ searchParams }: PageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) redirect('/calendar')

  const { month: monthParam } = await searchParams
  const { year, month, key: monthKey } = parseMonth(monthParam)

  const monthStart = new Date(Date.UTC(year, month, 1))
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))

  // Pull every host-assigned stream in the month. Expected counts every
  // booked shift (the host is scheduled to be paid for them); Realized
  // counts shifts whose end_time has already passed.
  // host_rate_cents (frozen per-shift) + host.rate_cents (flat) are locked from
  // raw reads (migration 055) — fetched via admin-only RPCs and merged back
  // onto the same objects the payout math reads below.
  const [streamsData, hostRateRows, streamPayRows] = await Promise.all([
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, host_id, start_time, end_time, host:hosts(id, name), brand:brands(id, name)')
        .not('host_id', 'is', null)
        .gte('end_time', monthStart.toISOString())
        .lt('end_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_host_rate_map') as never),
    fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: monthStart.toISOString(), p_to: monthEnd.toISOString() }) as never),
  ])

  const hostRateMap = new Map<string, number>(
    ((hostRateRows ?? []) as { host_id: string; rate_cents: number }[]).map(r => [r.host_id, r.rate_cents]),
  )
  const streamPayMap = new Map<string, { host_rate_cents: number | null; gmv_cents: number | null }>(
    ((streamPayRows ?? []) as { id: string; host_rate_cents: number | null; gmv_cents: number | null }[])
      .map(r => [r.id, { host_rate_cents: r.host_rate_cents, gmv_cents: r.gmv_cents }]),
  )

  type StreamRow = {
    id: string
    brand_id: string
    host_id: string | null
    host_rate_cents: number | null
    start_time: string
    end_time: string
    host:
      | { id: string; name: string; rate_cents: number }
      | { id: string; name: string; rate_cents: number }[]
      | null
    brand: { id: string; name: string } | { id: string; name: string }[] | null
  }
  const streams = ((streamsData ?? []) as unknown as StreamRow[])
    .map(s => ({
      ...s,
      host: Array.isArray(s.host) ? s.host[0] ?? null : s.host,
      brand: Array.isArray(s.brand) ? s.brand[0] ?? null : s.brand,
    }))
    .filter(s => s.host_id && s.brand)
  // Restore locked pay onto the same stream objects the payout math reads.
  for (const s of streams) {
    if (s.host) s.host.rate_cents = hostRateMap.get(s.host.id) ?? 0
    s.host_rate_cents = streamPayMap.get(s.id)?.host_rate_cents ?? null
  }

  const nowMs = nowPtAsUtc().getTime()

  // Aggregate per host
  type Acc = {
    name: string
    bookedMinutes: number
    completedMinutes: number
    shifts: number
    brands: Set<string>
    expectedCents: number
    realizedCents: number
  }
  const byHost = new Map<string, Acc>()

  for (const s of streams) {
    if (!s.host_id || !s.brand) continue
    const hostId = s.host_id
    const hostName = s.host?.name ?? 'Unknown'

    const startMs = new Date(s.start_time).getTime()
    const endMs = new Date(s.end_time).getTime()
    const durationMinutes = (endMs - startMs) / 60_000

    // Frozen pre-migration rate when present, else the host's flat rate.
    const { totalCents: earningsCents } = computeHostShiftPayoutCents(
      s.start_time, s.end_time, s.host_rate_cents, s.host?.rate_cents,
    )

    const prev = byHost.get(hostId) ?? {
      name: hostName,
      bookedMinutes: 0,
      completedMinutes: 0,
      shifts: 0,
      brands: new Set<string>(),
      expectedCents: 0,
      realizedCents: 0,
    }
    prev.bookedMinutes += durationMinutes
    prev.shifts += 1
    prev.brands.add(s.brand_id)
    prev.expectedCents += earningsCents
    // Realized = past shifts only.
    if (endMs <= nowMs) {
      prev.completedMinutes += durationMinutes
      prev.realizedCents += earningsCents
    }
    byHost.set(hostId, prev)
  }

  // Non-livestream paid work (setup / training / office hours, mig 057).
  // MUST be folded in here: the payroll CSV already includes it, so omitting it
  // on this page made the two disagree — and an admin paying from this screen
  // would underpay by exactly the extra-pay amount, with nothing on the page
  // explaining the gap. Each slot is priced at its OWN frozen rate.
  if (EXTRA_PAY_ENABLED) {
    const { data: extraData, error: extraError } = await supabase
      .from('extra_pay_slots')
      .select('host_id, kind, rate_cents, status, start_time, end_time, host:hosts(name)')
      .neq('status', 'canceled')
      .gte('end_time', monthStart.toISOString())
      .lt('end_time', monthEnd.toISOString())

    // Non-fatal, matching the export route: a problem with an optional bonus
    // category must never blank the whole payroll page.
    if (extraError) {
      console.error('[payroll/hosts] extra-pay query failed; showing livestream pay only:', extraError.message)
    } else {
      type ExtraRow = {
        host_id: string
        kind: string
        rate_cents: number
        status: string
        start_time: string
        end_time: string
        host: { name: string } | { name: string }[] | null
      }
      for (const e of (extraData ?? []) as unknown as ExtraRow[]) {
        if (!e.host_id) continue
        const minutes = extraPayDurationMinutes(e.start_time, e.end_time)
        if (minutes <= 0) continue
        const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
        const name = (Array.isArray(e.host) ? e.host[0]?.name : e.host?.name) ?? 'Unknown'
        // A host may have ONLY extra pay this month and no shifts — they still
        // need a row, or that work silently never gets paid.
        const prev = byHost.get(e.host_id) ?? {
          name, bookedMinutes: 0, completedMinutes: 0, shifts: 0,
          brands: new Set<string>(), expectedCents: 0, realizedCents: 0,
        }
        if (prev.name === 'Unknown' && name !== 'Unknown') prev.name = name
        prev.bookedMinutes += minutes
        prev.expectedCents += cents
        // Same Realized cutoff as shifts: only completed blocks are payable.
        if (isExtraPayRealized(e.end_time, nowMs)) {
          prev.completedMinutes += minutes
          prev.realizedCents += cents
        }
        byHost.set(e.host_id, prev)
      }
    }
  }

  const rows: HostRow[] = Array.from(byHost.entries()).map(([hostId, h]) => ({
    hostId,
    hostName: h.name,
    bookedHours: h.bookedMinutes / 60,
    completedHours: h.completedMinutes / 60,
    shiftCount: h.shifts,
    brandCount: h.brands.size,
    expectedEarningsCents: h.expectedCents,
    realizedEarningsCents: h.realizedCents,
  }))

  return (
    <div className="p-6">
      <HostsDashboardView monthKey={monthKey} rows={rows} />
    </div>
  )
}
