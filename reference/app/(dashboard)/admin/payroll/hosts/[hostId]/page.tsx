import { notFound, redirect } from 'next/navigation'
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
  EXTRA_PAY_LABELS,
  type ExtraPayKind,
} from '@/lib/extraPay'
import {
  HostDashboardView,
  type HostDetailData,
  type HostBrandBreakdown,
  type HostShiftDetail,
} from '@/components/admin/HostDashboardView'

interface PageProps {
  params: Promise<{ hostId: string }>
  searchParams: Promise<{ month?: string }>
}

export default async function HostDashboardDetailPage({ params, searchParams }: PageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) redirect('/calendar')

  const { hostId } = await params
  const { month: monthParam } = await searchParams
  const { year, month, key: monthKey } = parseMonth(monthParam)

  const monthStart = new Date(Date.UTC(year, month, 1))
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))

  // rate_cents (flat) + host_rate_cents (frozen per-shift) are locked from raw
  // reads (migration 055) — fetched via admin-only RPCs and merged back below.
  const [
    { data: hostData },
    streamsData,
    hostRateRows,
    streamPayRows,
  ] = await Promise.all([
    supabase.from('hosts').select('id, name').eq('id', hostId).single(),
    // Pull every host-assigned stream. Expected counts every booked shift;
    // Realized counts shifts whose end_time has already passed.
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, start_time, end_time, brand:brands(id, name, logo_path)')
        .eq('host_id', hostId)
        .gte('end_time', monthStart.toISOString())
        .lt('end_time', monthEnd.toISOString())
        .order('start_time')
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_host_rate_map') as never),
    fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: monthStart.toISOString(), p_to: monthEnd.toISOString() }) as never),
  ])

  const host = hostData as unknown as { id: string; name: string; rate_cents: number } | null
  if (!host) notFound()

  const hostRateMap = new Map<string, number>(
    ((hostRateRows ?? []) as { host_id: string; rate_cents: number }[]).map(r => [r.host_id, r.rate_cents]),
  )
  const streamPayMap = new Map<string, { host_rate_cents: number | null; gmv_cents: number | null }>(
    ((streamPayRows ?? []) as { id: string; host_rate_cents: number | null; gmv_cents: number | null }[])
      .map(r => [r.id, { host_rate_cents: r.host_rate_cents, gmv_cents: r.gmv_cents }]),
  )
  // Restore the host's flat rate onto the same object the payout math reads.
  host.rate_cents = hostRateMap.get(host.id) ?? 0

  type StreamRow = {
    id: string
    brand_id: string
    host_rate_cents: number | null
    start_time: string
    end_time: string
    brand:
      | { id: string; name: string; logo_path: string | null }
      | { id: string; name: string; logo_path: string | null }[]
      | null
  }
  const streams = ((streamsData ?? []) as unknown as StreamRow[])
    .map(s => ({
      ...s,
      brand: Array.isArray(s.brand) ? s.brand[0] ?? null : s.brand,
    }))
    .filter(s => s.brand)
  // Restore locked frozen per-shift rate onto the same objects the math reads.
  for (const s of streams) {
    s.host_rate_cents = streamPayMap.get(s.id)?.host_rate_cents ?? null
  }

  const nowMs = nowPtAsUtc().getTime()

  let bookedMinutes = 0
  let completedMinutes = 0
  let expectedCents = 0
  let realizedCents = 0

  type BrandAcc = {
    name: string
    logoPath: string | null
    minutes: number
    completedMinutes: number
    shifts: number
    expectedCents: number
    realizedCents: number
  }
  const brandMap = new Map<string, BrandAcc>()
  const shiftDetails: HostShiftDetail[] = []

  for (const s of streams) {
    if (!s.brand) continue
    const startMs = new Date(s.start_time).getTime()
    const endMs = new Date(s.end_time).getTime()
    const durationMinutes = (endMs - startMs) / 60_000
    const isPast = endMs <= nowMs
    // Realized = past shifts only.
    const isRealized = isPast

    // Frozen pre-migration rate when present, else the host's flat rate.
    const { rateCents, totalCents: earningsCents } = computeHostShiftPayoutCents(
      s.start_time, s.end_time, s.host_rate_cents, host.rate_cents,
    )

    bookedMinutes += durationMinutes
    expectedCents += earningsCents
    if (isRealized) {
      completedMinutes += durationMinutes
      realizedCents += earningsCents
    }

    const prev = brandMap.get(s.brand_id) ?? {
      name: s.brand.name,
      logoPath: s.brand.logo_path,
      minutes: 0,
      completedMinutes: 0,
      shifts: 0,
      expectedCents: 0,
      realizedCents: 0,
    }
    prev.minutes += durationMinutes
    prev.shifts += 1
    prev.expectedCents += earningsCents
    if (isRealized) {
      prev.completedMinutes += durationMinutes
      prev.realizedCents += earningsCents
    }
    brandMap.set(s.brand_id, prev)

    shiftDetails.push({
      id: s.id,
      brandId: s.brand_id,
      brandName: s.brand.name,
      brandLogoPath: s.brand.logo_path,
      startISO: s.start_time,
      endISO: s.end_time,
      durationMinutes,
      rateCents,
      earningsCents,
      isPast,
    })
  }

  // Non-livestream paid work (setup / training / office hours, mig 057).
  // The payroll CSV already counts this, so leaving it out here made the two
  // disagree and the block didn't even appear in the shift list below — the
  // admin could see a smaller total with nothing explaining why. Priced at
  // each slot's OWN frozen rate; folded into the same totals so this page and
  // the CSV always state the same number.
  if (EXTRA_PAY_ENABLED) {
    const { data: extraData, error: extraError } = await supabase
      .from('extra_pay_slots')
      .select('id, kind, rate_cents, status, start_time, end_time')
      .eq('host_id', hostId)
      .neq('status', 'canceled')
      .gte('end_time', monthStart.toISOString())
      .lt('end_time', monthEnd.toISOString())

    if (extraError) {
      console.error('[payroll/hosts/:id] extra-pay query failed; showing livestream pay only:', extraError.message)
    } else {
      type ExtraRow = {
        id: string; kind: ExtraPayKind; rate_cents: number
        start_time: string; end_time: string
      }
      for (const e of (extraData ?? []) as ExtraRow[]) {
        const minutes = extraPayDurationMinutes(e.start_time, e.end_time)
        if (minutes <= 0) continue
        const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
        const realized = isExtraPayRealized(e.end_time, nowMs)

        bookedMinutes += minutes
        expectedCents += cents
        if (realized) {
          completedMinutes += minutes
          realizedCents += cents
        }

        // Deliberately NOT added to brandMap: these are company-wide (the admin
        // UI never sets a brand), so attributing them to a brand would distort
        // per-brand cost. They still show in the shift list below.
        shiftDetails.push({
          id: e.id,
          brandId: `extra:${e.kind}`,
          brandName: EXTRA_PAY_LABELS[e.kind],
          brandLogoPath: null,
          startISO: e.start_time,
          endISO: e.end_time,
          durationMinutes: minutes,
          rateCents: e.rate_cents,
          earningsCents: cents,
          isPast: realized,
        })
      }
      shiftDetails.sort((a, b) => a.startISO.localeCompare(b.startISO))
    }
  }

  const brands: HostBrandBreakdown[] = Array.from(brandMap.entries())
    .map(([brandId, b]) => ({
      brandId,
      brandName: b.name,
      brandLogoPath: b.logoPath,
      hours: b.minutes / 60,
      shifts: b.shifts,
      expectedEarningsCents: b.expectedCents,
      realizedEarningsCents: b.realizedCents,
    }))
    .sort((a, b) => b.expectedEarningsCents - a.expectedEarningsCents)

  const data: HostDetailData = {
    hostId: host.id,
    hostName: host.name,
    bookedHours: bookedMinutes / 60,
    completedHours: completedMinutes / 60,
    shiftCount: shiftDetails.length,
    brandCount: brandMap.size,
    avgShiftMinutes: shiftDetails.length > 0 ? bookedMinutes / shiftDetails.length : 0,
    expectedEarningsCents: expectedCents,
    realizedEarningsCents: realizedCents,
    brands,
    shifts: shiftDetails,
  }

  return (
    <div className="p-6">
      <HostDashboardView monthKey={monthKey} data={data} />
    </div>
  )
}
