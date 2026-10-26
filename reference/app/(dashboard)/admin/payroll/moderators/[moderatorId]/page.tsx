import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import {
  extraPayCents,
  extraPayDurationMinutes,
  isExtraPayRealized,
  EXTRA_PAY_ENABLED,
} from '@/lib/extraPay'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc, parseMonth } from '@/lib/utils'
import { findSetupBonusStreamIds, setupBonusCents, type SetupBonusStream } from '@/lib/setupBonus'
import {
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
} from '@/lib/prepTime'
import {
  ModeratorDashboardView,
  type ModeratorDetailData,
  type ModeratorBrandBreakdown,
  type ModeratorShiftDetail,
} from '@/components/admin/ModeratorDashboardView'

interface PageProps {
  params: Promise<{ moderatorId: string }>
  searchParams: Promise<{ month?: string }>
}

export default async function ModeratorDashboardDetailPage({ params, searchParams }: PageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) redirect('/calendar')

  const { moderatorId } = await params
  const { month: monthParam } = await searchParams
  const { year, month, key: monthKey } = parseMonth(monthParam)

  const monthStart = new Date(Date.UTC(year, month, 1))
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))

  // rate_cents is locked from raw reads (migration 055) — fetched via an
  // admin-only RPC and merged onto the moderator object below.
  const { data: moderatorData } = await supabase
    .from('moderators')
    .select('id, name')
    .eq('id', moderatorId)
    .single()

  const moderator = moderatorData as unknown as { id: string; name: string; rate_cents: number } | null
  if (!moderator) notFound()

  // Pull every assigned stream. Expected counts every assigned shift;
  // Realized counts shifts whose end_time has already passed.
  // The second query spans ALL moderators' streams this month — the
  // first-of-day setup bonus depends on whether someone ELSE's stream
  // started earlier on the same (brand, day), which this moderator-scoped
  // query can't see.
  // First query start is padded by 1 day so a session straddling the month
  // boundary is a continuation for prep detection; lookback rows contribute
  // session context only, never pay (in-window guard below).
  const lookbackStart = new Date(monthStart.getTime() - 86_400_000)
  const monthStartISO = monthStart.toISOString()
  const [streamsData, allModStreamsData, modRateRows] = await Promise.all([
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, start_time, end_time, brand:brands(id, name, logo_path), host:hosts(id, name)')
        .eq('moderator_id', moderatorId)
        .gte('end_time', lookbackStart.toISOString())
        .lt('end_time', monthEnd.toISOString())
        .order('start_time')
        .order('id') as never,
    ),
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, moderator_id, start_time')
        .not('moderator_id', 'is', null)
        .gte('end_time', monthStart.toISOString())
        .lt('end_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_moderator_rate_map') as never),
  ])

  // Restore the locked flat rate onto the moderator object the pay math reads.
  const modRateMap = new Map<string, number>(
    ((modRateRows ?? []) as { moderator_id: string; rate_cents: number }[]).map(r => [r.moderator_id, r.rate_cents]),
  )
  moderator.rate_cents = modRateMap.get(moderatorId) ?? 0

  const bonusIds = findSetupBonusStreamIds(
    ((allModStreamsData ?? []) as unknown as SetupBonusStream[]),
  )

  type StreamRow = {
    id: string
    brand_id: string
    start_time: string
    end_time: string
    brand:
      | { id: string; name: string; logo_path: string | null }
      | { id: string; name: string; logo_path: string | null }[]
      | null
    host: { id: string; name: string } | { id: string; name: string }[] | null
  }
  const streams = ((streamsData ?? []) as unknown as StreamRow[])
    .map(s => ({
      ...s,
      brand: Array.isArray(s.brand) ? s.brand[0] ?? null : s.brand,
      host: Array.isArray(s.host) ? s.host[0] ?? null : s.host,
    }))
    .filter(s => s.brand)

  const nowMs = nowPtAsUtc().getTime()

  // New-rule prep: one flat-rate block per contiguous session of THIS
  // moderator, windowed to the visible month (session-start attribution).
  const prepBlocks = computePrepBlocks(
    streams.map(s => ({
      id: s.id,
      brand_id: s.brand_id,
      moderator_id: moderatorId,
      start_time: s.start_time,
      end_time: s.end_time,
    })),
    { fromISO: monthStartISO, toExclusiveISO: monthEnd.toISOString() },
  )
  const prepByAnchor = new Map(prepBlocks.map(b => [b.anchorId, b]))

  let bookedMinutes = 0
  let completedMinutes = 0
  let expectedCents = 0
  let realizedCents = 0
  let prepCentsTotal = 0
  let prepBlocksRealized = 0

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
  const shiftDetails: ModeratorShiftDetail[] = []

  for (const s of streams) {
    if (!s.brand) continue
    if (new Date(s.end_time).getTime() < monthStart.getTime()) continue // lookback row: session context only (instant compare — DB "+00:00" vs ".000Z")
    const startMs = new Date(s.start_time).getTime()
    const endMs = new Date(s.end_time).getTime()
    const durationMinutes = (endMs - startMs) / 60_000
    const isPast = endMs <= nowMs
    // Realized = past shifts only.
    const isRealized = isPast

    // Pre-cutoff first-of-day setup pay: +30 paid minutes at the mod's own
    // rate. Post-cutoff, one flat-rate prep block per session lands on the
    // session's anchor shift instead. The shift detail keeps its real
    // wall-clock duration; only pay + paid-hours move.
    const isSetup = bonusIds.has(s.id) && setupBonusApplies(s.start_time)
    const bonusCents = isSetup ? setupBonusCents(moderator.rate_cents) : 0
    const prepBlock = prepByAnchor.get(s.id)
    const prepCents = prepBlock ? prepBlockCents(moderator.rate_cents, prepBlock.durationMinutes) : 0
    const prepMinutes = prepBlock ? prepBlock.durationMinutes : 0
    // Prep realized-gating keys off the SESSION end, not this row's end.
    const prepRealized = prepBlock
      ? new Date(prepBlock.sessionEndISO).getTime() <= nowMs
      : false
    const payMinutes = durationMinutes + (isSetup ? 30 : 0) + prepMinutes
    const earningsCents = Math.round((moderator.rate_cents * durationMinutes) / 60) + bonusCents + prepCents

    // Live + old bonus realize on THIS row's end; prep realizes on the
    // SESSION's end (a multi-row session's anchor can end before the run does).
    const rowMinutes = durationMinutes + (isSetup ? 30 : 0)
    const rowCents = earningsCents - prepCents

    bookedMinutes += payMinutes
    expectedCents += earningsCents
    if (isRealized) {
      completedMinutes += rowMinutes
      realizedCents += rowCents
    }
    if (prepRealized) {
      completedMinutes += prepMinutes
      realizedCents += prepCents
      prepBlocksRealized += 1
    }
    if (prepBlock) prepCentsTotal += prepCents

    const prev = brandMap.get(s.brand_id) ?? {
      name: s.brand.name,
      logoPath: s.brand.logo_path,
      minutes: 0,
      completedMinutes: 0,
      shifts: 0,
      expectedCents: 0,
      realizedCents: 0,
    }
    prev.minutes += payMinutes
    prev.shifts += 1
    prev.expectedCents += earningsCents
    if (isRealized) {
      prev.completedMinutes += rowMinutes
      prev.realizedCents += rowCents
    }
    if (prepRealized) {
      prev.completedMinutes += prepMinutes
      prev.realizedCents += prepCents
    }
    brandMap.set(s.brand_id, prev)

    shiftDetails.push({
      id: s.id,
      brandId: s.brand_id,
      brandName: s.brand.name,
      brandLogoPath: s.brand.logo_path,
      hostName: s.host?.name ?? null,
      startISO: s.start_time,
      endISO: s.end_time,
      durationMinutes,
      earningsCents,
      isPast,
    })
  }

  // Moderator extra pay -- setup / training / office hours (migration 073).
  // Folded into the same top-line totals the shifts feed, so Expected and
  // Realized here mean what they mean in the CSV and on the list page
  // (rule 21). Not added to the per-brand breakdown: these blocks are usually
  // company overhead with no brand attached, and inventing a brand row for
  // them would misreport per-brand cost.
  //
  // Priced from the rate FROZEN on each slot, never the moderator's current
  // hourly rate. TRUE month window, not the padded one -- an extra-pay block
  // is standalone and has no session to assemble across the boundary.
  if (EXTRA_PAY_ENABLED) {
    type ExtraRow = {
      id: string; rate_cents: number
      status: string; start_time: string; end_time: string
    }
    const { data: extraData, error: extraError } = await supabase
      .from('extra_pay_slots')
      .select('id, rate_cents, status, start_time, end_time')
      .eq('moderator_id', moderatorId)
      .neq('status', 'canceled')
      .gte('end_time', monthStartISO)
      .lt('end_time', monthEnd.toISOString())
      .order('id')

    if (extraError) {
      // Non-fatal, matching the export route: an optional bonus category must
      // not blank the whole page. Loud in the logs, not silent in the numbers.
      console.error(
        '[payroll/moderators/detail] extra-pay query failed; showing shifts only:',
        extraError.message,
      )
    } else {
      for (const e of ((extraData ?? []) as unknown as ExtraRow[])) {
        const minutes = extraPayDurationMinutes(e.start_time, e.end_time)
        if (minutes <= 0) continue
        const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
        bookedMinutes += minutes
        expectedCents += cents
        if (isExtraPayRealized(e.end_time, nowMs)) {
          completedMinutes += minutes
          realizedCents += cents
        }
      }
    }
  }

  const brands: ModeratorBrandBreakdown[] = Array.from(brandMap.entries())
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

  const data: ModeratorDetailData = {
    moderatorId: moderator.id,
    moderatorName: moderator.name,
    rateCents: moderator.rate_cents,
    bookedHours: bookedMinutes / 60,
    completedHours: completedMinutes / 60,
    shiftCount: shiftDetails.length,
    brandCount: brandMap.size,
    avgShiftMinutes: shiftDetails.length > 0 ? bookedMinutes / shiftDetails.length : 0,
    expectedEarningsCents: expectedCents,
    realizedEarningsCents: realizedCents,
    prepBlocks: prepBlocks.length,
    prepBlocksRealized,
    prepCents: prepCentsTotal,
    brands,
    shifts: shiftDetails,
  }

  return (
    <div className="p-6">
      <ModeratorDashboardView monthKey={monthKey} data={data} />
    </div>
  )
}
