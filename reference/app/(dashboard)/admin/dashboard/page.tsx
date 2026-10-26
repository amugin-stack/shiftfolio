import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole } from '@/lib/role'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { nowPtAsUtc, parseMonth, utcToPt } from '@/lib/utils'
import { computeHostShiftPayoutCents } from '@/lib/payout'
import { extraPayCents, isExtraPayRealized, EXTRA_PAY_ENABLED } from '@/lib/extraPay'
import { findSetupBonusStreamIds, setupBonusCents } from '@/lib/setupBonus'
import {
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
} from '@/lib/prepTime'
import { computeFillRate } from '@/lib/fill'
import { DashboardView, DashboardGrowthChart, type BrandRow, type TrendPoint } from '@/components/admin/DashboardView'
import { BRAND_PUBLIC_COLUMNS, type Brand } from '@/lib/supabase/types'

interface DashboardPageProps {
  searchParams: Promise<{ month?: string }>
}

export default async function AdminDashboardPage({ searchParams }: DashboardPageProps) {
  const supabase = await createClient()

  // Shared with the dashboard layout for this request (src/lib/auth/session.ts).
  // This page previously re-ran the ENTIRE identity block the layout had just
  // finished: another auth round trip, another profiles fetch, and another
  // three role queries -- five redundant round trips across three sequential
  // steps, before any dashboard data was requested. The cache() helpers existed
  // but this page was never wired to them.
  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const roles = await getSessionRoles(user.id, effectiveIsAdmin)

  // Admins always see the dashboard. Producers see it too — all brands,
  // read-only (the support team 2026-07-21 access model) — but every revenue/pay/pricing/
  // profit figure is STRIPPED from the payload below, not merely hidden in the
  // UI. Anyone else bounces.
  if (!effectiveIsAdmin && !roles.isProducer) redirect('/calendar')

  const showRevenue = effectiveIsAdmin

  const { month: monthParam } = await searchParams
  const { year, month, key: monthKey } = parseMonth(monthParam)

  // PT-naive month bounds: stored UTC fields ARE the PT wall-clock
  const monthStart = new Date(Date.UTC(year, month, 1))
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))

  // Producers and admins both see every brand's operational metrics. Money
  // columns are stripped for non-admins after the rows are built (see below).
  const brandsQuery = supabase.from('brands').select(BRAND_PUBLIC_COLUMNS).order('name')

  // Pull all host-assigned streams in the month. Expected counts every
  // booked shift; Realized counts shifts whose end_time is in the past.
  // Pay/pricing columns (host/moderator rate_cents, host_rate_cents,
  // client_rate_cents, contracted_hours_per_month) are locked from raw reads
  // (migration 055) — fetched via admin-only RPCs below and merged back onto
  // the same objects so downstream aggregation is unchanged. The RPC maps are
  // fetched for this month; historical trends load independently below.
  // +1 day on the upper bound: this page's streams queries window on
  // start_time, while admin_stream_pay windows on end_time (migration 068). A
  // shift starting just before month end can finish after it, so without the
  // pad it appears in the stream list but NOT in the pay map -- and a missing
  // pay-map entry silently re-prices it at the host's current rate.
  const payToISO = new Date(monthEnd.getTime() + 86_400_000).toISOString()

  const [
    { data: brandsData },
    streamsData,
    modStreamsData,
    hostRateRows,
    modRateRows,
    streamPayRows,
    brandPricingRows,
  ] = await Promise.all([
    brandsQuery,
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, host_id, moderator_id, start_time, end_time, host:hosts(id), moderator:moderators(id)')
        .not('host_id', 'is', null)
        .gte('start_time', monthStart.toISOString())
        .lt('start_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    // ALL moderator-assigned streams (host or not) — the first-of-day setup
    // bonus is decided across the full set, matching the payroll pages.
    // Padded by 1 day of lookback so a prep session straddling the month
    // boundary reads as a continuation (context only, never pay).
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

  // Locked pay/pricing values → lookup maps (empty for non-admins/producers,
  // so the merged values fall back to 0/null — money is stripped for them
  // anyway via safeRows below).
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
  const brandPricingMap = new Map<string, { client_rate_cents: number | null; contracted_hours_per_month: number | null }>(
    ((brandPricingRows ?? []) as { brand_id: string; client_rate_cents: number | null; contracted_hours_per_month: number | null }[])
      .map(r => [r.brand_id, { client_rate_cents: r.client_rate_cents, contracted_hours_per_month: r.contracted_hours_per_month }]),
  )

  const brands = (brandsData as unknown as Brand[] | null) ?? []
  // Restore locked pricing onto the same brand objects the aggregation reads.
  for (const b of brands) {
    const p = brandPricingMap.get(b.id)
    b.client_rate_cents = p?.client_rate_cents ?? null
    b.contracted_hours_per_month = p?.contracted_hours_per_month ?? null
  }

  const streams = ((streamsData ?? []) as unknown as StreamAggRow[])
    .map(s => ({
      ...s,
      host: Array.isArray(s.host) ? s.host[0] ?? null : s.host,
      moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
    }))
  // Restore locked pay onto the same stream objects the aggregation reads.
  for (const s of streams) {
    if (s.host) s.host.rate_cents = hostRateMap.get(s.host.id) ?? 0
    if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
    s.host_rate_cents = streamPayMap.get(s.id)?.host_rate_cents ?? null
  }

  const nowMs = nowPtAsUtc().getTime()

  // First-of-day setup pay (+30 min at the moderator's flat rate) per brand.
  const modStreams = ((modStreamsData ?? []) as unknown as ModStreamRow[])
    .map(s => ({
      ...s,
      moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
    }))
  // Restore locked moderator rate onto the same objects the setup/prep math reads.
  for (const s of modStreams) {
    if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
  }
  // Extra moderator pay per brand: pre-cutoff first-of-day setup bonus (own
  // rate) + post-cutoff per-session flat-rate prep blocks. Both land in
  // moderator cost, hence profit — mirroring the payroll pages exactly.
  const setupBonusIds = findSetupBonusStreamIds(modStreams)
  const setupByBrand = new Map<string, { expected: number; realized: number }>()
  for (const s of modStreams) {
    if (!setupBonusIds.has(s.id) || !s.moderator) continue
    if (new Date(s.start_time).getTime() < monthStart.getTime()) continue // lookback row (instant compare — DB "+00:00" vs ".000Z")
    if (!setupBonusApplies(s.start_time)) continue // post-cutoff → prep rule instead
    const bonus = setupBonusCents(s.moderator.rate_cents)
    const acc = setupByBrand.get(s.brand_id) ?? { expected: 0, realized: 0 }
    acc.expected += bonus
    if (new Date(s.end_time).getTime() <= nowMs) acc.realized += bonus
    setupByBrand.set(s.brand_id, acc)
  }
  const modRateById = new Map<string, number>()
  for (const s of modStreams) {
    if (s.moderator_id && s.moderator) modRateById.set(s.moderator_id, s.moderator.rate_cents)
  }
  for (const b of computePrepBlocks(modStreams, {
    fromISO: monthStart.toISOString(),
    toExclusiveISO: monthEnd.toISOString(),
  })) {
    const cents = prepBlockCents(modRateById.get(b.moderatorId) ?? 0, b.durationMinutes)
    const acc = setupByBrand.get(b.brandId) ?? { expected: 0, realized: 0 }
    acc.expected += cents
    if (new Date(b.sessionEndISO).getTime() <= nowMs) acc.realized += cents
    setupByBrand.set(b.brandId, acc)
  }

  // Aggregate per brand
  const rows: BrandRow[] = brands.map(b => {
    let bookedMinutes = 0
    let completedMinutes = 0
    let shiftCount = 0
    const hostSet = new Set<string>()
    const clientRateCents: number | null = b.client_rate_cents ?? null

    // Cost buckets. Expected counts every booked shift; Realized counts
    // shifts whose end_time has already passed. Same gates as revenue so
    // profit math stays internally consistent (profit = revenue − cost in
    // each bucket).
    let expectedHostCostCents = 0
    let realizedHostCostCents = 0
    let expectedModeratorCostCents = 0
    let realizedModeratorCostCents = 0

    for (const s of streams) {
      if (s.brand_id !== b.id) continue
      if (!s.host_id) continue
      const start = new Date(s.start_time).getTime()
      const end = new Date(s.end_time).getTime()
      const durationMinutes = (end - start) / 60_000
      const isRealized = end <= nowMs

      bookedMinutes += durationMinutes
      shiftCount += 1
      hostSet.add(s.host_id)
      if (isRealized) completedMinutes += durationMinutes

      // Host cost via payout.ts — frozen pre-migration rate when present,
      // else the host's flat rate. Same math as the host payroll pages.
      const hostCostCents = computeHostShiftPayoutCents(
        s.start_time, s.end_time, s.host_rate_cents, s.host?.rate_cents,
      ).totalCents
      expectedHostCostCents += hostCostCents
      if (isRealized) realizedHostCostCents += hostCostCents

      // Moderator cost — flat per-moderator hourly rate from the moderators
      // row. Only counts when a moderator is actually assigned. Uses the
      // moderator's CURRENT rate (matches the moderator payroll page).
      const modRate = s.moderator?.rate_cents ?? 0
      if (s.moderator_id && modRate > 0) {
        const modCostCents = Math.round((modRate * durationMinutes) / 60)
        expectedModeratorCostCents += modCostCents
        if (isRealized) realizedModeratorCostCents += modCostCents
      }
    }

    // First-of-day setup pay lands in moderator cost (and therefore profit).
    const setup = setupByBrand.get(b.id)
    if (setup) {
      expectedModeratorCostCents += setup.expected
      realizedModeratorCostCents += setup.realized
    }

    const bookedHours = bookedMinutes / 60
    const completedHours = completedMinutes / 60
    // Fill % = booked hours against the brand's contracted hours for the month.
    // Admin-only: producers never receive the ratio (it would leak the
    // admin-only contracted figure). Null/0 contracted → null → "—".
    const fillRate = effectiveIsAdmin
      ? computeFillRate(bookedHours, b.contracted_hours_per_month)
      : null

    const expectedRevenueCents = clientRateCents != null
      ? Math.round((clientRateCents * bookedMinutes) / 60)
      : 0
    const realizedRevenueCents = clientRateCents != null
      ? Math.round((clientRateCents * completedMinutes) / 60)
      : 0

    // Profit = revenue − host cost − moderator cost. May be negative when
    // the brand's client rate is below our cost structure — surface that
    // honestly rather than clamping.
    const expectedProfitCents = expectedRevenueCents - expectedHostCostCents - expectedModeratorCostCents
    const realizedProfitCents = realizedRevenueCents - realizedHostCostCents - realizedModeratorCostCents

    return {
      brandId: b.id,
      brandName: b.name,
      brandLogoPath: b.logo_path,
      bookedHours,
      completedHours,
      shiftCount,
      uniqueHosts: hostSet.size,
      avgShiftMinutes: shiftCount > 0 ? bookedMinutes / shiftCount : 0,
      fillRate,
      clientRateCents,
      expectedRevenueCents,
      realizedRevenueCents,
      expectedHostCostCents,
      realizedHostCostCents,
      expectedModeratorCostCents,
      realizedModeratorCostCents,
      expectedProfitCents,
      realizedProfitCents,
    }
  })

  // Setup / training / office-hour cost for this month. COMPANY OVERHEAD
  // (the support team, 2026-08-25): these slots carry no brand, so the cost is subtracted
  // from the company totals and never from a per-brand row — charging it to a
  // brand would misstate that brand's profitability. Without it, profit read
  // high by the full amount of every paid session.
  // Admin-only: producers must never receive money figures (rules 25/26).
  let extraPayExpectedCents = 0
  let extraPayRealizedCents = 0
  if (effectiveIsAdmin && EXTRA_PAY_ENABLED) {
    const extraData = await fetchAllRows<{ rate_cents: number; start_time: string; end_time: string }>(() => supabase
      .from('extra_pay_slots')
      .select('rate_cents, status, start_time, end_time')
      .neq('status', 'canceled')
      .gte('start_time', monthStart.toISOString())
      .lt('start_time', monthEnd.toISOString())
      .order('id') as never)
    // A failed/incomplete overhead read must not present an inflated profit.
    for (const e of extraData) {
      const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
      extraPayExpectedCents += cents
      if (isExtraPayRealized(e.end_time, nowMs)) extraPayRealizedCents += cents
    }
  }

  // Privacy: strip every money field for non-admins (producers). `showRevenue`
  // only hides these in the UI; the raw values must never reach the client
  // payload (CLAUDE.md rules 25/26). Operational columns — hours, shift count,
  // unique hosts — stay so producers can still oversee scheduling.
  const safeRows: BrandRow[] = effectiveIsAdmin
    ? rows
    : rows.map(r => ({
        ...r,
        clientRateCents: null,
        expectedRevenueCents: 0,
        realizedRevenueCents: 0,
        expectedHostCostCents: 0,
        realizedHostCostCents: 0,
        expectedModeratorCostCents: 0,
        realizedModeratorCostCents: 0,
        expectedProfitCents: 0,
        realizedProfitCents: 0,
      }))

  return (
    <div className="p-6">
      <DashboardView
        monthKey={monthKey}
        rows={safeRows}
        showRevenue={showRevenue}
        brands={brands.map(b => ({ id: b.id, name: b.name }))}
        extraPayExpectedCents={extraPayExpectedCents}
        extraPayRealizedCents={extraPayRealizedCents}
      >
        {effectiveIsAdmin && brands.length > 0 && (
          <Suspense key={monthKey} fallback={<p role="status" className="p-6 text-muted-foreground">Loading historical trends…</p>}>
            <DashboardTrends year={year} month={month} brands={brands} hostRateMap={hostRateMap} modRateMap={modRateMap} />
          </Suspense>
        )}
      </DashboardView>
    </div>
  )
}

  type StreamAggRow = {
    id: string
    brand_id: string
    host_id: string | null
    moderator_id: string | null
    host_rate_cents: number | null
    start_time: string
    end_time: string
    host: { id: string; rate_cents: number } | { id: string; rate_cents: number }[] | null
    moderator: { id: string; rate_cents: number } | { id: string; rate_cents: number }[] | null
  }
  type ModStreamRow = {
    id: string
    brand_id: string
    moderator_id: string | null
    start_time: string
    end_time: string
    moderator: { id: string; rate_cents: number } | { id: string; rate_cents: number }[] | null
  }

async function DashboardTrends({ year, month, brands, hostRateMap, modRateMap }: {
  year: number; month: number; brands: Brand[]
  hostRateMap: Map<string, number>; modRateMap: Map<string, number>
}) {
  // This server-only child runs under Suspense; history never blocks the month summary.
  const user = await getSessionUser()
  if (!user) return null
  const profile = await getSessionProfile(user.id)
  if (!(await resolveRole(profile)).effectiveIsAdmin) return null
  const supabase = await createClient()
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))
  const nowMs = nowPtAsUtc().getTime()
  try {
  // Growth trend chart (admin only). Pre-computes two parallel series —
  // weekly and monthly buckets — covering 24 PT months ending at the END of
  // the current month (current period INCLUDED). The current bucket shows
  // only shifts that have already happened to-date, so it grows through the
  // week/month rather than appearing flat.
  const MAX_TREND_MONTHS = 24
  let weeklyTrend: TrendPoint[] = []
  let monthlyTrend: TrendPoint[] = []
  {
    const trendStart = new Date(Date.UTC(year, month - (MAX_TREND_MONTHS - 1), 1))
    const trendEnd = monthEnd

    // No .in('brand_id', brandIds) here any more. brandIds is EVERY brand
    // (line ~161) and this whole block is admin-only, so the filter matched
    // everything -- but Postgres still evaluated a ~30-UUID IN list per row,
    // and streams.brand_id is NOT NULL with an FK, so no row could be excluded
    // by it anyway. Dropping it also removes this block's only dependency on
    // the brands fetch.
    //
    // PAGED. This is the largest read in the app — TWENTY-FOUR MONTHS of
    // streams across EVERY brand — so it blew past PostgREST's 1000-row cap
    // long ago. Truncated, the growth chart was drawing an arbitrary ~1000-row
    // sample smeared across 24 buckets: every revenue and profit point read
    // low, and the SHAPE of the curve was an artifact of physical row order
    // rather than of the business. It rendered perfectly cleanly while doing
    // it, which is why nobody caught it.
    const [trendStreamsRows, trendModStreamsRows, trendPayRows] = await Promise.all([
      fetchAllRows(() =>
          supabase
            .from('streams')
            .select('id, brand_id, host_id, moderator_id, start_time, end_time, host:hosts(id), moderator:moderators(id)')
            .not('host_id', 'is', null)
            .gte('start_time', trendStart.toISOString())
            .lt('start_time', trendEnd.toISOString())
            .order('id') as never as never,
        ),
      // Setup-bonus/prep determination needs ALL moderator-assigned streams
      // in the window (host or not), same rule as the month table above.
      // Padded by 1 day of lookback for prep session continuity.
      fetchAllRows(() =>
          supabase
            .from('streams')
            .select('id, brand_id, moderator_id, start_time, end_time, moderator:moderators(id)')
            .not('moderator_id', 'is', null)
            .gte('start_time', new Date(trendStart.getTime() - 86_400_000).toISOString())
            .lt('start_time', trendEnd.toISOString())
            .order('id') as never as never,
        ),
      fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: trendStart.toISOString(), p_to: new Date(trendEnd.getTime() + 86_400_000).toISOString() }) as never),
    ])
    const streamPayMap = new Map((trendPayRows as { id: string; host_rate_cents: number | null }[]).map(r => [r.id, r]))

    const trendStreams = (trendStreamsRows as unknown as StreamAggRow[])
      .map(s => ({
        ...s,
        host: Array.isArray(s.host) ? s.host[0] ?? null : s.host,
        moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
      }))
    const trendModStreams = (trendModStreamsRows as unknown as ModStreamRow[])
      .map(s => ({
        ...s,
        moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
      }))
    // Restore locked pay from this independently loaded historical window.
    for (const s of trendStreams) {
      if (s.host) s.host.rate_cents = hostRateMap.get(s.host.id) ?? 0
      if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
      s.host_rate_cents = streamPayMap.get(s.id)?.host_rate_cents ?? null
    }
    for (const s of trendModStreams) {
      if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
    }
    const trendSetupBonusIds = findSetupBonusStreamIds(trendModStreams)

    const brandById = new Map(brands.map(b => [b.id, b]))

    type Bucket = { revenueCents: number; profitCents: number }
    const monthBuckets = new Map<string, Bucket>()
    const weekBuckets = new Map<string, Bucket>()
    const pad = (n: number) => String(n).padStart(2, '0')

    // Seed monthly buckets — MAX_TREND_MONTHS entries ending at the current
    // month inclusive (offset shifts by 1 from the old "completed months
    // only" window).
    for (let i = 0; i < MAX_TREND_MONTHS; i++) {
      const dt = new Date(Date.UTC(year, month - (MAX_TREND_MONTHS - 1) + i, 1))
      const key = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`
      monthBuckets.set(key, { revenueCents: 0, profitCents: 0 })
    }

    // Seed weekly buckets — every Monday between trendStart and trendEnd
    // (PT-naive UTC scheme: treat UTC fields as PT wall-clock). Find first
    // Monday at or after trendStart, then step by 7 days.
    const cursor = new Date(trendStart)
    const cursorDow = cursor.getUTCDay() // 0=Sun..6=Sat
    const daysToMonday = cursorDow === 1 ? 0 : (8 - cursorDow) % 7
    cursor.setUTCDate(cursor.getUTCDate() + daysToMonday)
    while (cursor < trendEnd) {
      const k = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`
      weekBuckets.set(k, { revenueCents: 0, profitCents: 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 7)
    }

    for (const s of trendStreams) {
      if (!s.host_id) continue
      const brand = brandById.get(s.brand_id)
      if (!brand) continue
      const clientRate = brand.client_rate_cents
      if (clientRate == null) continue

      const start = new Date(s.start_time)
      const endMs = new Date(s.end_time).getTime()
      // Realized = past shifts only.
      if (endMs > nowMs) continue

      const durationMinutes = (endMs - start.getTime()) / 60_000
      const revenueCents = Math.round((clientRate * durationMinutes) / 60)

      const hostCostCents = computeHostShiftPayoutCents(
        s.start_time, s.end_time, s.host_rate_cents, s.host?.rate_cents,
      ).totalCents
      const modRate = s.moderator?.rate_cents ?? 0
      const modCostCents = s.moderator_id && modRate > 0
        ? Math.round((modRate * durationMinutes) / 60)
        : 0
      const profitCents = revenueCents - hostCostCents - modCostCents

      // PT-naive UTC: utcToPt's getFullYear/getMonth/getDate give the PT
      // wall-clock fields directly.
      const ptStart = utcToPt(start)
      // Month bucket
      const mKey = `${ptStart.getFullYear()}-${pad(ptStart.getMonth() + 1)}`
      const mBucket = monthBuckets.get(mKey)
      if (mBucket) {
        mBucket.revenueCents += revenueCents
        mBucket.profitCents += profitCents
      }
      // Week bucket — Monday of the PT week containing ptStart.
      const dow = ptStart.getDay() // 0=Sun..6=Sat
      const daysFromMonday = dow === 0 ? 6 : dow - 1
      const wd = new Date(ptStart)
      wd.setHours(0, 0, 0, 0)
      wd.setDate(wd.getDate() - daysFromMonday)
      const wKey = `${wd.getFullYear()}-${pad(wd.getMonth() + 1)}-${pad(wd.getDate())}`
      const wBucket = weekBuckets.get(wKey)
      if (wBucket) {
        wBucket.revenueCents += revenueCents
        wBucket.profitCents += profitCents
      }
    }

    // Second pass: realized extra moderator pay reduces the bucket profit
    // (cost only — revenue untouched). Buckets follow the same PT month/week
    // keying as the main loop. Bucketing helper shared by both rules below.
    const subtractFromBuckets = (attributionISO: string, cents: number) => {
      const ptStart = utcToPt(new Date(attributionISO))
      const mKey = `${ptStart.getFullYear()}-${pad(ptStart.getMonth() + 1)}`
      const mBucket = monthBuckets.get(mKey)
      if (mBucket) mBucket.profitCents -= cents

      const dow = ptStart.getDay()
      const daysFromMonday = dow === 0 ? 6 : dow - 1
      const wd = new Date(ptStart)
      wd.setHours(0, 0, 0, 0)
      wd.setDate(wd.getDate() - daysFromMonday)
      const wKey = `${wd.getFullYear()}-${pad(wd.getMonth() + 1)}-${pad(wd.getDate())}`
      const wBucket = weekBuckets.get(wKey)
      if (wBucket) wBucket.profitCents -= cents
    }

    // Pre-cutoff first-of-day setup bonus (own rate).
    for (const s of trendModStreams) {
      if (!trendSetupBonusIds.has(s.id) || !s.moderator) continue
      if (new Date(s.start_time).getTime() < trendStart.getTime()) continue // lookback row: session context only (mirrors the month-table + payroll guards)
      if (!setupBonusApplies(s.start_time)) continue // post-cutoff → prep rule
      const endMs = new Date(s.end_time).getTime()
      if (endMs > nowMs) continue // realized only, like the rest of the trend
      subtractFromBuckets(s.start_time, setupBonusCents(s.moderator.rate_cents))
    }

    // Post-cutoff per-session prep blocks at the mod's own rate, attributed
    // to the session start (its PT day/week/month), realized on session end.
    const trendModRateById = new Map<string, number>()
    for (const s of trendModStreams) {
      if (s.moderator_id && s.moderator) trendModRateById.set(s.moderator_id, s.moderator.rate_cents)
    }
    for (const b of computePrepBlocks(trendModStreams, {
      fromISO: trendStart.toISOString(),
      toExclusiveISO: trendEnd.toISOString(),
    })) {
      if (new Date(b.sessionEndISO).getTime() > nowMs) continue
      subtractFromBuckets(b.sessionStartISO, prepBlockCents(trendModRateById.get(b.moderatorId) ?? 0, b.durationMinutes))
    }

    monthlyTrend = Array.from(monthBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => {
        const [y, m] = key.split('-').map(Number)
        const dt = new Date(Date.UTC(y, m - 1, 1))
        return {
          bucketKey: key,
          // "May '25" — short label
          label: dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
          revenueCents: b.revenueCents,
          profitCents: b.profitCents,
        }
      })

    weeklyTrend = Array.from(weekBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => {
        const [y, m, d] = key.split('-').map(Number)
        const dt = new Date(Date.UTC(y, m - 1, d))
        return {
          bucketKey: key,
          // "May 5" — week-start date, fits a tight mobile x-axis tick
          label: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
          revenueCents: b.revenueCents,
          profitCents: b.profitCents,
        }
      })
  }


    return <DashboardGrowthChart weeklyTrend={weeklyTrend} monthlyTrend={monthlyTrend} />
  } catch {
    return <p role="alert" className="p-6 text-destructive">Historical trends could not be loaded completely. Refresh to try again.</p>
  }
}
