import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc, parseMonth } from '@/lib/utils'
import { findSetupBonusStreamIds, setupBonusCents } from '@/lib/setupBonus'
import {
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
} from '@/lib/prepTime'
import {
  extraPayCents,
  extraPayDurationMinutes,
  isExtraPayRealized,
  EXTRA_PAY_ENABLED,
} from '@/lib/extraPay'
import { ModeratorsDashboardView, type ModeratorRow } from '@/components/admin/ModeratorsDashboardView'

interface PageProps {
  searchParams: Promise<{ month?: string }>
}

export default async function ModeratorDashboardListPage({ searchParams }: PageProps) {
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

  // Join moderator row inline — gives us name + rate_cents in one round-trip.
  // Expected counts every assigned shift (the moderator is scheduled to be
  // paid); Realized counts shifts whose end_time has already passed.
  // The query start is padded by 1 day so a session straddling the month
  // boundary is recognized as a continuation for prep detection; lookback
  // rows contribute session context only, never pay (in-window guard below).
  const lookbackStart = new Date(monthStart.getTime() - 86_400_000)
  const monthStartISO = monthStart.toISOString()
  // moderator rate_cents is locked from raw reads (migration 055) — fetched via
  // an admin-only RPC and merged back onto the same objects the pay math reads.
  const [streamsData, modRateRows, modExtraRows] = await Promise.all([
    fetchAllRows(() =>
      supabase
        .from('streams')
        .select('id, brand_id, moderator_id, start_time, end_time, moderator:moderators(id, name)')
        .not('moderator_id', 'is', null)
        .gte('end_time', lookbackStart.toISOString())
        .lt('end_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_moderator_rate_map') as never),
    // Moderator extra pay -- setup / training / office hours (migration 073).
    // Without this the CSV would pay a moderator for training while this page
    // showed nothing, which is exactly the screen-vs-paycheck disagreement
    // fixed on 2026-08-29 for straddling shifts. Queried on the TRUE month
    // window, NOT the padded lookback used for the streams above: the padding
    // exists so a session straddling the boundary is assembled whole, and an
    // extra-pay block has no session to assemble.
    EXTRA_PAY_ENABLED
      ? fetchAllRows(() =>
          supabase
            .from('extra_pay_slots')
            .select('id, moderator_id, rate_cents, status, start_time, end_time, moderator:moderators(id, name)')
            .not('moderator_id', 'is', null)
            .neq('status', 'canceled')
            .gte('end_time', monthStartISO)
            .lt('end_time', monthEnd.toISOString())
            .order('id') as never,
        )
      : Promise.resolve([] as unknown[]),
  ])

  const modRateMap = new Map<string, number>(
    ((modRateRows ?? []) as { moderator_id: string; rate_cents: number }[]).map(r => [r.moderator_id, r.rate_cents]),
  )

  type StreamRow = {
    id: string
    brand_id: string
    moderator_id: string | null
    start_time: string
    end_time: string
    moderator:
      | { id: string; name: string; rate_cents: number }
      | { id: string; name: string; rate_cents: number }[]
      | null
  }
  const streams = ((streamsData ?? []) as unknown as StreamRow[])
    .map(s => ({
      ...s,
      moderator: Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator,
    }))
    .filter(s => s.moderator_id && s.moderator)
  // Restore locked moderator rate onto the same objects the pay math reads.
  for (const s of streams) {
    if (s.moderator) s.moderator.rate_cents = modRateMap.get(s.moderator.id) ?? 0
  }

  const nowMs = nowPtAsUtc().getTime()

  // Old rule (pre-cutoff): first moderator-assigned stream of each (brand,
  // PT day) earns +30 min of paid setup time at the mod's own rate.
  const bonusIds = findSetupBonusStreamIds(streams)
  // New rule (post-cutoff): one flat-rate prep block per contiguous session,
  // windowed to the visible month (session-start attribution).
  const prepBlocks = computePrepBlocks(streams, {
    fromISO: monthStartISO,
    toExclusiveISO: monthEnd.toISOString(),
  })

  type Acc = {
    name: string
    rateCents: number
    bookedMinutes: number
    completedMinutes: number
    shifts: number
    setupShifts: number
    prepBlocks: number
    prepCents: number
    brands: Set<string>
    expectedCents: number
    realizedCents: number
  }
  const byModerator = new Map<string, Acc>()
  const emptyAcc = (name: string, rateCents: number): Acc => ({
    name,
    rateCents,
    bookedMinutes: 0,
    completedMinutes: 0,
    shifts: 0,
    setupShifts: 0,
    prepBlocks: 0,
    prepCents: 0,
    brands: new Set<string>(),
    expectedCents: 0,
    realizedCents: 0,
  })

  for (const s of streams) {
    if (!s.moderator_id || !s.moderator) continue
    if (new Date(s.end_time).getTime() < monthStart.getTime()) continue // lookback row: session context only (instant compare — DB "+00:00" vs ".000Z")
    const moderatorId = s.moderator_id

    const startMs = new Date(s.start_time).getTime()
    const endMs = new Date(s.end_time).getTime()
    const durationMinutes = (endMs - startMs) / 60_000
    const earningsCents = Math.round((s.moderator.rate_cents * durationMinutes) / 60)

    const prev = byModerator.get(moderatorId) ?? emptyAcc(s.moderator.name, s.moderator.rate_cents)
    prev.bookedMinutes += durationMinutes
    prev.shifts += 1
    prev.brands.add(s.brand_id)
    prev.expectedCents += earningsCents
    // Realized = past shifts only.
    if (endMs <= nowMs) {
      prev.completedMinutes += durationMinutes
      prev.realizedCents += earningsCents
    }
    if (bonusIds.has(s.id) && setupBonusApplies(s.start_time)) {
      const bonus = setupBonusCents(s.moderator.rate_cents)
      prev.setupShifts += 1
      prev.bookedMinutes += 30
      prev.expectedCents += bonus
      if (endMs <= nowMs) {
        prev.completedMinutes += 30
        prev.realizedCents += bonus
      }
    }
    byModerator.set(moderatorId, prev)
  }

  // Prep blocks: expected counts every in-month session; realized when the
  // session has ended — same gating shape as the live pay above.
  const modInfoById = new Map<string, { name: string; rate: number }>()
  for (const s of streams) {
    if (s.moderator_id && s.moderator) {
      modInfoById.set(s.moderator_id, { name: s.moderator.name, rate: s.moderator.rate_cents })
    }
  }
  for (const b of prepBlocks) {
    const info = modInfoById.get(b.moderatorId)
    const prev = byModerator.get(b.moderatorId) ?? emptyAcc(info?.name ?? 'Unknown', info?.rate ?? 0)
    const cents = prepBlockCents(info?.rate ?? 0, b.durationMinutes)
    prev.prepBlocks += 1
    prev.prepCents += cents
    prev.bookedMinutes += b.durationMinutes
    prev.expectedCents += cents
    if (new Date(b.sessionEndISO).getTime() <= nowMs) {
      prev.completedMinutes += b.durationMinutes
      prev.realizedCents += cents
    }
    byModerator.set(b.moderatorId, prev)
  }

  // Fold extra pay into the same totals the shifts feed, so Expected and
  // Realized on this page mean what they mean everywhere else (rule 21).
  // Priced from the rate FROZEN on each slot, never the moderator's current
  // hourly rate.
  {
    type ExtraRow = {
      moderator_id: string
      rate_cents: number
      start_time: string
      end_time: string
      moderator: { id: string; name: string } | { id: string; name: string }[] | null
    }
    for (const e of ((modExtraRows ?? []) as unknown as ExtraRow[])) {
      if (!e.moderator_id) continue
      const minutes = extraPayDurationMinutes(e.start_time, e.end_time)
      if (minutes <= 0) continue
      const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
      const mod = Array.isArray(e.moderator) ? e.moderator[0] ?? null : e.moderator
      const prev = byModerator.get(e.moderator_id)
        ?? emptyAcc(mod?.name ?? 'Unknown', modRateMap.get(e.moderator_id) ?? 0)
      prev.bookedMinutes += minutes
      prev.expectedCents += cents
      if (isExtraPayRealized(e.end_time, nowMs)) {
        prev.completedMinutes += minutes
        prev.realizedCents += cents
      }
      byModerator.set(e.moderator_id, prev)
    }
  }

  const rows: ModeratorRow[] = Array.from(byModerator.entries()).map(([moderatorId, m]) => ({
    moderatorId,
    moderatorName: m.name,
    rateCents: m.rateCents,
    bookedHours: m.bookedMinutes / 60,
    completedHours: m.completedMinutes / 60,
    shiftCount: m.shifts,
    setupShifts: m.setupShifts,
    prepBlocks: m.prepBlocks,
    prepCents: m.prepCents,
    brandCount: m.brands.size,
    expectedEarningsCents: m.expectedCents,
    realizedEarningsCents: m.realizedCents,
  }))

  return (
    <div className="p-6">
      <ModeratorsDashboardView monthKey={monthKey} rows={rows} />
    </div>
  )
}
