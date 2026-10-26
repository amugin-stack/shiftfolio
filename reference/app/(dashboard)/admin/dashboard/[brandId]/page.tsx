import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc, parseMonth } from '@/lib/utils'
import { computeHostShiftPayoutCents } from '@/lib/payout'
import { findSetupBonusStreamIds, setupBonusCents } from '@/lib/setupBonus'
import {
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
} from '@/lib/prepTime'
import { computeFillRate } from '@/lib/fill'
import {
  BrandDashboardView,
  type BrandDetailData,
  type BrandShiftDetail,
  type HostBreakdown,
} from '@/components/admin/BrandDashboardView'
import { BRAND_PUBLIC_COLUMNS, type Brand } from '@/lib/supabase/types'

interface BrandDashboardPageProps {
  params: Promise<{ brandId: string }>
  searchParams: Promise<{ month?: string }>
}

export default async function BrandDashboardDetailPage({ params, searchParams }: BrandDashboardPageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const roles = await getSessionRoles(user.id, effectiveIsAdmin)

  // Admins see the page for any brand; producers too (read-only, all brands,
  // with money stripped from the payload below). Anyone else bounces.
  if (!effectiveIsAdmin && !roles.isProducer) redirect('/calendar')

  const { brandId } = await params
  const { month: monthParam } = await searchParams
  const { year, month, key: monthKey } = parseMonth(monthParam)

  const monthStart = new Date(Date.UTC(year, month, 1))
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))

  const { data: brandData } = await supabase
    .from('brands')
    .select(BRAND_PUBLIC_COLUMNS)
    .eq('id', brandId)
    .single()

  const brand = brandData as unknown as Brand | null
  if (!brand) notFound()

  // No per-brand producer scoping: producers may view any brand's detail
  // (read-only, money stripped below), matching their all-brand visibility on
  // the parent dashboard and calendar (the support team 2026-07-21 access model).
  const showRevenue = effectiveIsAdmin

  // Pull all host-assigned streams in the month. Expected counts every
  // booked shift; Realized counts shifts whose end_time is in the past.
  // moderator_id + rate_cents come along for profit math below.
  // Pay/pricing columns are locked from raw reads (migration 055); fetched via
  // admin-only RPCs and merged back onto the same objects the math reads below.
  // +1 day on the upper bound: this page's streams queries window on
  // start_time, while admin_stream_pay windows on end_time (migration 068). A
  // shift starting just before month end can finish after it, so without the
  // pad it appears in the stream list but NOT in the pay map -- and a missing
  // pay-map entry silently re-prices it at the host's current rate.
  const payToISO = new Date(monthEnd.getTime() + 86_400_000).toISOString()

  const [
    streamsData,
    modStreamsData,
    hostRateRows,
    modRateRows,
    streamPayRows,
    brandPricingRows,
  ] = await Promise.all([
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, host_id, moderator_id, start_time, end_time, host:hosts(id, name), moderator:moderators(id)')
        .eq('brand_id', brandId)
        .not('host_id', 'is', null)
        .gte('start_time', monthStart.toISOString())
        .lt('start_time', monthEnd.toISOString())
        .order('start_time')
        .order('id') as never,
    ),
    // ALL moderator-assigned streams (host or not), across EVERY brand —
    // deliberately unscoped: prep suppression must see the moderator's
    // other-brand shifts, or this page would count prep that payroll
    // suppresses. Per-brand filtering happens in the loops below. Padded by
    // 1 day of lookback for prep session continuity.
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, moderator_id, start_time, end_time, moderator:moderators(id)')
        .not('moderator_id', 'is', null)
        .gte('start_time', new Date(monthStart.getTime() - 86_400_000).toISOString())
        .lt('start_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_host_rate_map') as never),
    fetchAllRows(() => supabase.rpc('admin_moderator_rate_map') as never),
    fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: monthStart.toISOString(), p_to: payToISO }) as never),
    fetchAllRows(() => supabase.rpc('admin_brand_pricing') as never),
  ])

  // Locked pay/pricing values → lookup maps (empty for producers → 0/null,
  // stripped via safeData below).
  const hostRateMap = new Map<string, number>(
    ((hostRateRows ?? []) as { host_id: string; rate_cents: number }[]).map(r => [r.host_id, r.rate_cents]),
  )
  const modRateMap = new Map<string, number>(
    ((modRateRows ?? []) as { moderator_id: string; rate_cents: number }[]).map(r => [r.moderator_id, r.rate_cents]),
  )
  const streamPayMap = new Map<string, { host_rate_cents: number | null; gmv_cents: number | null }>(
    ((streamPayRows ?? []) as { id: string; host_rate_cents: number | null; gmv_cents: number | null }[])
      .map(r => [r.id, { host_rate_cents: r.host_rate_cents, gmv_cents: r.gmv_cents }]),
  )
  const brandPricing = ((brandPricingRows ?? []) as { brand_id: string; client_rate_cents: number | null; contracted_hours_per_month: number | null }[])
    .find(r => r.brand_id === brandId)
  brand.client_rate_cents = brandPricing?.client_rate_cents ?? null
  brand.contracted_hours_per_month = brandPricing?.contracted_hours_per_month ?? null

  type StreamRow = {
    id: string
    brand_id: string
    host_id: string | null
    moderator_id: string | null
    host_rate_cents: number | null
    start_time: string
    end_time: string
    host:
      | { id: string; name: string; rate_cents: number }
      | { id: string; name: string; rate_cents: number }[]
      | null
    moderator: { id: string; rate_cents: number } | { id: string; rate_cents: number }[] | null
  }
  const streams = ((streamsData ?? []) as unknown as StreamRow[])
    .map(s => ({
      ...s,
      host: Array.isArray(s.host) ? s.host[0] ?? null : s.host,
      moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
    }))
    .filter(s => s.host_id)
  // Restore locked pay onto the same stream objects the math reads below.
  for (const s of streams) {
    if (s.host) s.host.rate_cents = hostRateMap.get(s.host.id) ?? 0
    if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
    s.host_rate_cents = streamPayMap.get(s.id)?.host_rate_cents ?? null
  }

  const nowMs = nowPtAsUtc().getTime()
  let bookedMinutes = 0
  let completedMinutes = 0
  // Cost buckets follow the same expected/realized gating as revenue so
  // profit = revenue − cost stays internally consistent in each bucket.
  let expectedHostCostCents = 0
  let realizedHostCostCents = 0
  let expectedModeratorCostCents = 0
  let realizedModeratorCostCents = 0

  // First-of-day setup pay (+30 min at the moderator's flat rate).
  type ModStreamRow = {
    id: string
    brand_id: string
    moderator_id: string | null
    start_time: string
    end_time: string
    moderator: { id: string; rate_cents: number } | { id: string; rate_cents: number }[] | null
  }
  const modStreams = ((modStreamsData ?? []) as unknown as ModStreamRow[])
    .map(s => ({
      ...s,
      moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
    }))
  // Restore locked moderator rate onto the same objects the setup/prep math reads.
  for (const s of modStreams) {
    if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
  }
  // Pre-cutoff first-of-day setup bonus (own rate), THIS brand only.
  const setupBonusIds = findSetupBonusStreamIds(modStreams)
  for (const s of modStreams) {
    if (!setupBonusIds.has(s.id) || !s.moderator) continue
    if (s.brand_id !== brandId) continue
    if (new Date(s.start_time).getTime() < monthStart.getTime()) continue // lookback row (instant compare — DB "+00:00" vs ".000Z")
    if (!setupBonusApplies(s.start_time)) continue // post-cutoff → prep rule
    const bonus = setupBonusCents(s.moderator.rate_cents)
    expectedModeratorCostCents += bonus
    if (new Date(s.end_time).getTime() <= nowMs) realizedModeratorCostCents += bonus
  }
  // Post-cutoff per-session flat-rate prep, THIS brand's sessions only —
  // suppression evaluated over the full cross-brand set above.
  const modRateById = new Map<string, number>()
  for (const s of modStreams) {
    if (s.moderator_id && s.moderator) modRateById.set(s.moderator_id, s.moderator.rate_cents)
  }
  for (const b of computePrepBlocks(modStreams, {
    fromISO: monthStart.toISOString(),
    toExclusiveISO: monthEnd.toISOString(),
  })) {
    if (b.brandId !== brandId) continue
    const cents = prepBlockCents(modRateById.get(b.moderatorId) ?? 0, b.durationMinutes)
    expectedModeratorCostCents += cents
    if (new Date(b.sessionEndISO).getTime() <= nowMs) realizedModeratorCostCents += cents
  }
  const hostMap = new Map<string, { name: string; minutes: number; shifts: number }>()

  const shiftDetails: BrandShiftDetail[] = streams.map(s => {
    const start = new Date(s.start_time).getTime()
    const end = new Date(s.end_time).getTime()
    const durationMinutes = (end - start) / 60_000
    const isPast = end <= nowMs
    // Realized = past shifts only.
    const isRealized = isPast

    bookedMinutes += durationMinutes
    if (isRealized) completedMinutes += durationMinutes

    // Host cost via payout.ts — frozen pre-migration rate when present,
    // else the host's flat rate. Same math as the host payroll pages.
    const hostCostCents = computeHostShiftPayoutCents(
      s.start_time, s.end_time, s.host_rate_cents, s.host?.rate_cents,
    ).totalCents
    expectedHostCostCents += hostCostCents
    if (isRealized) realizedHostCostCents += hostCostCents

    // Moderator cost — flat per-moderator hourly rate. Only when assigned.
    const modRate = s.moderator?.rate_cents ?? 0
    if (s.moderator_id && modRate > 0) {
      const modCostCents = Math.round((modRate * durationMinutes) / 60)
      expectedModeratorCostCents += modCostCents
      if (isRealized) realizedModeratorCostCents += modCostCents
    }

    const hostName = s.host?.name ?? 'Unknown'
    const hostId = s.host_id!
    const prev = hostMap.get(hostId) ?? { name: hostName, minutes: 0, shifts: 0 }
    prev.minutes += durationMinutes
    prev.shifts += 1
    hostMap.set(hostId, prev)

    return {
      id: s.id,
      hostId,
      hostName,
      startISO: s.start_time,
      endISO: s.end_time,
      durationMinutes,
      isPast,
    }
  })

  const hostBreakdown: HostBreakdown[] = Array.from(hostMap.entries())
    .map(([hostId, h]) => ({
      hostId,
      hostName: h.name,
      hours: h.minutes / 60,
      shifts: h.shifts,
    }))
    .sort((a, b) => b.hours - a.hours)

  const bookedHours = bookedMinutes / 60
  const clientRateCents = brand.client_rate_cents ?? null
  const expectedRevenueCents = clientRateCents != null
    ? Math.round((clientRateCents * bookedMinutes) / 60)
    : 0
  const realizedRevenueCents = clientRateCents != null
    ? Math.round((clientRateCents * completedMinutes) / 60)
    : 0

  // Profit = revenue − host cost − moderator cost. May be negative when
  // costs exceed the client rate — surface that honestly.
  const expectedProfitCents = expectedRevenueCents - expectedHostCostCents - expectedModeratorCostCents
  const realizedProfitCents = realizedRevenueCents - realizedHostCostCents - realizedModeratorCostCents

  const data: BrandDetailData = {
    brandId: brand.id,
    brandName: brand.name,
    brandLogoPath: brand.logo_path,
    bookedHours,
    completedHours: completedMinutes / 60,
    shiftCount: shiftDetails.length,
    uniqueHosts: hostMap.size,
    avgShiftMinutes: shiftDetails.length > 0 ? bookedMinutes / shiftDetails.length : 0,
    fillRate: effectiveIsAdmin ? computeFillRate(bookedHours, brand.contracted_hours_per_month) : null,
    clientRateCents,
    expectedRevenueCents,
    realizedRevenueCents,
    expectedHostCostCents,
    realizedHostCostCents,
    expectedModeratorCostCents,
    realizedModeratorCostCents,
    expectedProfitCents,
    realizedProfitCents,
    hosts: hostBreakdown,
    shifts: shiftDetails,
  }

  // Privacy: strip every money field for non-admins (producers). `showRevenue`
  // only hides these in the UI; the raw values must never reach the client
  // payload (CLAUDE.md rules 25/26). The schedule itself — host names, shift
  // times, per-host hours — stays so producers can oversee scheduling.
  const safeData: BrandDetailData = effectiveIsAdmin
    ? data
    : {
        ...data,
        clientRateCents: null,
        expectedRevenueCents: 0,
        realizedRevenueCents: 0,
        expectedHostCostCents: 0,
        realizedHostCostCents: 0,
        expectedModeratorCostCents: 0,
        realizedModeratorCostCents: 0,
        expectedProfitCents: 0,
        realizedProfitCents: 0,
      }

  return (
    <div className="p-6">
      <BrandDashboardView monthKey={monthKey} data={safeData} showRevenue={showRevenue} />
    </div>
  )
}
