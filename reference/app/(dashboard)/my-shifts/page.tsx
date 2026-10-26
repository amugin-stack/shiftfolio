import { redirect } from 'next/navigation'
import { ClipboardList } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { readIdChunks, windowStreamIds } from '@/lib/supabase/windowedStreams'
import { MyShiftsList, type ShiftRow, type HostSession, type HostGmvCards, type PayTotal } from '@/components/my-shifts/MyShiftsList'
import { nowPtAsUtc } from '@/lib/utils'
import { computeHostShiftPayoutCents } from '@/lib/payout'
import { setupBonusCents } from '@/lib/setupBonus'
import {
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
} from '@/lib/prepTime'
import { buildSessionsByHost } from '@/lib/gmv'

import {
  currentPayPeriodStartKey,
  normalizePayPeriodKey,
  resolvePayPeriod,
} from '@/lib/payPeriod'
import {
  extraPayCents,
  isExtraPayRealized,
  EXTRA_PAY_ENABLED,
  EXTRA_PAY_LABELS,
  type ExtraPayKind,
} from '@/lib/extraPay'

type StreamRow = {
  id: string
  start_time: string
  end_time: string
  brand_id: string
  notes: string | null
  /** Needed on BOTH queries since migration 074: GMV sessions are partitioned
   *  by host, and a moderator's shifts can span more than one host. */
  host_id: string | null
  /** Frozen pre-migration host rate (only selected on the host query). */
  host_rate_cents?: number | null
  /** Host-reported session GMV (anchor stream only; host query). */
  gmv_cents?: number | null
  brand:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null
  producer: { id: string; name: string } | { id: string; name: string }[] | null
}

function unwrap<T>(v: T | T[] | null): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v
}

interface MyShiftsPageProps {
  searchParams: Promise<{ period?: string }>
}

export default async function MyShiftsPage({ searchParams }: MyShiftsPageProps) {
  // Earnings are shown per BIWEEKLY PAY PERIOD, not per calendar month: people
  // are paid every two weeks, and showing them a month meant their own page and
  // their paycheck described different spans of time. Same anchored calendar
  // the payroll CSV uses (src/lib/payPeriod.ts), so the two cannot drift.
  const currentPeriodKey = currentPayPeriodStartKey(nowPtAsUtc())
  const periodKey = normalizePayPeriodKey((await searchParams).period, nowPtAsUtc())

  const supabase = await createClient()
  const user = await getSessionUser()
  if (!user) redirect('/login')

  // Look up host + moderator records in parallel — a user can be either,
  // both, or neither.
  const [{ data: myHostRow, error: hostError }, { data: myModeratorRow, error: moderatorError }, { data: payContextData, error: payError }] = await Promise.all([
    // self_moderating decides whether this host may REPORT GMV (migration 075).
    // Readable because 075 grants the column -- a column grant is deny-by-
    // default, so selecting it before that migration is applied would fail the
    // whole query, not return null.
    supabase.from('hosts').select('id, name, self_moderating, monthly_gmv_goal_cents').eq('user_id', user.id).maybeSingle(),
    supabase.from('moderators').select('id, name').eq('user_id', user.id).maybeSingle(),
    // Own pay rates come via a SECURITY DEFINER RPC — the rate columns are
    // locked from raw table reads (migration 055). Returns only the caller's
    // own host/moderator rate.
    supabase.rpc('get_my_pay_context'),
  ])
  if (hostError || moderatorError || payError) throw new Error("We could not load your complete pay information. Please try again.")
  const myHost = myHostRow as
    { id: string; name: string; self_moderating?: boolean; monthly_gmv_goal_cents?: number | null }
    | null
  const myModerator = myModeratorRow as { id: string; name: string } | null
  const payContext = (Array.isArray(payContextData) ? payContextData[0] : payContextData) as
    { host_rate_cents: number | null; moderator_rate_cents: number | null } | null
  const myHostRateCents = payContext?.host_rate_cents ?? undefined
  const myModeratorRateCents = payContext?.moderator_rate_cents ?? 0

  // Not linked to either → empty state
  if (!myHost && !myModerator) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mx-auto">
            <ClipboardList className="w-6 h-6 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-foreground">No shifts linked</h1>
            <p className="text-sm text-muted-foreground">
              Ask an admin to link your account to a host or moderator profile so you can see your shifts here.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const period = resolvePayPeriod(periodKey)
  const nowWindow = nowPtAsUtc()
  const recentFrom = new Date(+nowWindow - 30 * 86400000).toISOString()
  const upcomingTo = new Date(+nowWindow + 60 * 86400000).toISOString()
  const scope = { host: myHost?.id, moderator: myModerator?.id }
  const [windowIds, totals, gmvSummaryRes] = await Promise.all([
    Promise.all([
      windowStreamIds(supabase, period.fromISO, period.toExclusiveISO, scope),
      windowStreamIds(supabase, recentFrom, upcomingTo, scope),
    ]),
    fetchAllRows<PayTotal>(() => supabase.rpc('get_my_pay_totals').order('brand_id').order('brand_name') as never), supabase.rpc('get_my_gmv_summary'),
  ])
  const ids = [...new Set(windowIds.flat())]
  if (gmvSummaryRes.error) throw new Error('We could not load complete pay totals. Please try again.')
  const gmvSummary = gmvSummaryRes.data?.[0]

  // Fetch streams for both roles in parallel (only the relevant queries fire).
  // host_rate_cents (frozen pre-migration rate) only matters for the host
  // query — it's the user's own pay, fine to select on their own shifts.
  const hostStreamSelect = 'id, host_id, start_time, end_time, brand_id, notes, brand:brands(id, name), producer:producers(id, name)'
  const moderatorStreamSelect = 'id, host_id, start_time, end_time, brand_id, notes, brand:brands(id, name), producer:producers(id, name)'

  // Either of the caller's worker ids, for the extra-pay query below. Empty
  // when they are neither, in which case the query is skipped entirely.
  const extraOwnerFilter = [
    myHost ? `host_id.eq.${myHost.id}` : null,
    myModerator ? `moderator_id.eq.${myModerator.id}` : null,
  ].filter(Boolean).join(',')

  const [
    hostStreamsData,
    moderatorStreamsData,
    payRows,
    bonusRes,
    extraRes,
    sessionGmvRows,
  ] = await Promise.all([
    myHost
      ? readIdChunks<StreamRow>(ids, chunk =>
          supabase
            .from('streams')
            .select(hostStreamSelect)
            .eq('host_id', myHost.id).in('id', chunk)
            // id breaks ties so paging is deterministic.
            .order('start_time')
            .order('id') as never,
        )
      : Promise.resolve([] as StreamRow[]),
    myModerator
      ? readIdChunks<StreamRow>(ids, chunk =>
          supabase
            .from('streams')
            .select(moderatorStreamSelect)
            .eq('moderator_id', myModerator.id).in('id', chunk)
            .order('start_time')
            .order('id') as never,
        )
      : Promise.resolve([] as StreamRow[]),
    myHost
      ? readIdChunks(ids, chunk => supabase.rpc('get_my_window_pay', { p_ids: chunk }) as never)
      : Promise.resolve([] as unknown[]),
    myModerator
      ? readIdChunks<string>(ids, chunk => supabase.rpc('get_my_window_setup_ids', { p_ids: chunk }) as never).then(data => ({ data }))
      : Promise.resolve({ data: null }),
    // Non-livestream paid work the person did. Since migration 073 a slot can
    // belong to a moderator as well as a host, and a user can be both, so this
    // asks for either of their ids. RLS would scope it to their own rows
    // anyway ("host reads own" / "moderator reads own"), but naming the ids
    // keeps the query on its index and keeps the intent readable.
    EXTRA_PAY_ENABLED && extraOwnerFilter
      ? fetchAllRows(() => supabase
          .from('extra_pay_slots')
          .select('id, host_id, moderator_id, kind, rate_cents, status, start_time, end_time, notes, brand:brands(id, name)')
          .or(extraOwnerFilter)
          .neq('status', 'canceled')
          .or(`and(end_time.gte.${period.fromISO},end_time.lt.${period.toExclusiveISO}),and(end_time.gte.${recentFrom},start_time.lt.${upcomingTo})`)
          .order('start_time').order('id') as never).then(data => ({ data, error: null }))
      : Promise.resolve({ data: null, error: null }),
    // Session GMV + who last set it, for hosts AND moderators (migration 074).
    // Deliberately a separate accessor from get_my_stream_pay: that one returns
    // host_rate_cents, so reusing it for moderators would hand them the host's
    // pay rate. Paged for the same reason as the queries above -- PostgREST
    // truncates at 1000 rows and a long-tenured worker crosses that in about a
    // year.
    myHost || myModerator
      ? readIdChunks(ids, chunk => supabase.rpc('get_my_window_gmv', { p_ids: chunk }) as never)
      : Promise.resolve([] as unknown[]),
  ])

  // Keyed by stream id. One map for both roles, so a session a user hosted and
  // one they moderated resolve through identical code.
  const sessionGmvById = new Map<
    string,
    { gmvCents: number | null; updatedByName: string | null; updatedAt: string | null }
  >()
  for (const r of ((sessionGmvRows ?? []) as {
    stream_id: string
    gmv_cents: number | null
    updated_by_name: string | null
    updated_at: string | null
  }[])) {
    sessionGmvById.set(r.stream_id, {
      gmvCents: r.gmv_cents,
      updatedByName: r.updated_by_name,
      updatedAt: r.updated_at,
    })
  }

  // Frozen per-shift host pay + session GMV come via a SECURITY DEFINER RPC
  // (columns locked in migration 055); key by stream id to merge into the
  // caller's own shifts. Moderator streams never carry these — the map simply
  // has no entry for them.
  const streamPayById = new Map<string, { host_rate_cents: number | null; gmv_cents: number | null }>()
  if (myHost) {
    // Paged, like the streams query above it. This RPC covers the SAME row set
    // — every stream the caller has ever hosted — so the "a regular worker
    // reaches 1000 rows in about a year" note above applies here verbatim. It
    // was left unpaged, which meant exactly the workers the paging fix was for
    // also had a truncated pay map: their older shifts lost the frozen rate and
    // were silently re-priced at their CURRENT rate on their own earnings page,
    // while the admin CSV (truncated differently) showed something else again.
    for (const r of ((payRows ?? []) as { stream_id: string; host_rate_cents: number | null; gmv_cents: number | null }[])) {
      streamPayById.set(r.stream_id, { host_rate_cents: r.host_rate_cents, gmv_cents: r.gmv_cents })
    }
  }

  // Normalize join shape for both lists.
  function normalize(raw: StreamRow[] | null) {
    return ((raw ?? []) as StreamRow[]).map(s => ({
      id: s.id,
      start_time: s.start_time,
      end_time: s.end_time,
      brand_id: s.brand_id,
      notes: s.notes,
      host_id: s.host_id ?? null,
      host_rate_cents: streamPayById.get(s.id)?.host_rate_cents ?? null,
      // GMV comes from get_my_session_gmv (migration 074) where available, so
      // hosts and moderators read one shared figure.
      //
      // The fallback matters since migration 075: that accessor now returns only
      // sessions the caller may REPORT on, so an ordinary (non-self-moderating)
      // host gets nothing from it. Without falling back to their own pay RPC --
      // which still returns gmv_cents for their own shifts -- losing the ability
      // to EDIT their GMV would also have silently blanked their ability to SEE
      // it. They keep the number, they just can no longer change it.
      gmv_cents:
        sessionGmvById.get(s.id)?.gmvCents
        ?? streamPayById.get(s.id)?.gmv_cents
        ?? null,
      brand: unwrap(s.brand),
      producer: unwrap(s.producer),
    })).filter(s => s.brand)
  }
  const hostStreams = normalize(hostStreamsData as StreamRow[] | null)
  const moderatorStreams = normalize(moderatorStreamsData as StreamRow[] | null)

  const now = nowPtAsUtc().getTime()

  // Host shifts → frozen pre-migration rate when present, else the host's
  // flat rate (hosts.rate_cents).
  const hostShifts: ShiftRow[] = hostStreams.map(s => {
    const { rateCents, totalCents } = computeHostShiftPayoutCents(
      s.start_time, s.end_time, s.host_rate_cents, myHostRateCents,
    )
    return {
      id: s.id,
      brandId: s.brand!.id,
      brandName: s.brand!.name,
      producerName: s.producer?.name ?? null,
      startISO: s.start_time,
      endISO: s.end_time,
      rateCents,
      totalCents,
      isPast: new Date(s.end_time).getTime() <= now,
      notes: s.notes,
      role: 'host',
    }
  })

  // Moderator shifts → flat rate × hours, plus:
  //   pre-cutoff:  the first-of-(brand, PT-day) setup bonus (+30 min at the
  //                mod's own rate) via the SECURITY DEFINER RPC — RLS hides
  //                other moderators' streams, so the page can't tell on its own.
  //   post-cutoff: one flat-rate prep block per contiguous session
  //                (src/lib/prepTime.ts), attached to the session's anchor
  //                shift. Own-streams-only input is sufficient: the new rule
  //                never looks at other moderators.
  const moderatorRate = myModeratorRateCents
  let setupBonusIdSet = new Set<string>()
  if (myModerator && moderatorStreams.length > 0) {
    const bonusData = (bonusRes as { data: string[] | null }).data
    setupBonusIdSet = new Set(bonusData ?? [])
  }
  const prepByAnchor = new Map(
    computePrepBlocks(
      moderatorStreams.map(s => ({
        id: s.id,
        brand_id: s.brand_id,
        moderator_id: myModerator?.id ?? null,
        start_time: s.start_time,
        end_time: s.end_time,
      })),
    ).map(b => [b.anchorId, b]),
  )
  const moderatorShifts: ShiftRow[] = moderatorStreams.map(s => {
    const brand = s.brand!
    const durationMinutes = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60_000
    const isSetup = setupBonusIdSet.has(s.id) && setupBonusApplies(s.start_time)
    const prepBlock = prepByAnchor.get(s.id)
    const prepCents = prepBlock ? prepBlockCents(moderatorRate, prepBlock.durationMinutes) : 0
    // Prep realizes when the SESSION ends — the anchor row of a multi-row
    // session ends earlier, so its own isPast must not realize the prep
    // (keeps My Shifts consistent with the admin payroll pages).
    const prepRealized = prepBlock
      ? new Date(prepBlock.sessionEndISO).getTime() <= now
      : false
    const totalCents = Math.round((moderatorRate * durationMinutes) / 60)
      + (isSetup ? setupBonusCents(moderatorRate) : 0)
      + prepCents
    return {
      id: s.id,
      brandId: brand.id,
      brandName: brand.name,
      producerName: s.producer?.name ?? null,
      startISO: s.start_time,
      endISO: s.end_time,
      rateCents: moderatorRate,
      totalCents,
      isPast: new Date(s.end_time).getTime() <= now,
      notes: s.notes,
      role: 'moderator',
      setupBonus: isSetup,
      // Keyed on the prep BLOCK existing, not the amount — a moderator whose
      // rate is still $0 (pay unset) has a real prep block worth $0; the tag
      // must still show so the calendar / My Shifts / payroll all agree the
      // prep exists (they'd otherwise diverge — the calendar shows the tile
      // regardless of rate).
      prepCents: prepBlock ? prepCents : undefined,
      prepRealized: prepBlock ? prepRealized : undefined,
      // Carried so the moderator can see the HOURS, not just the money.
      // Read off the block, never a constant -- the length changed on
      // PREP_DURATION_CUTOFF_ISO and older sessions keep their 30 minutes.
      prepMinutes: prepBlock ? prepBlock.durationMinutes : undefined,
    }
  })

  // Same stream can be both your host shift AND your moderator shift if the
  // admin assigned you to both slots — that's a weird edge case but let's
  // dedup by (id, role) just in case.
  // Non-livestream paid work the host did (setup / training / office hours,
  // mig 057). Without this the worker cannot see money their own paycheck
  // includes — the payroll CSV counts it, and My Shifts is the ONLY surface
  // they have (the admin Extra Pay page is admin-only). Reading their own slots
  // is already permitted by the "extra_pay: host reads own" policy.
  let extraShifts: ShiftRow[] = []
  if (EXTRA_PAY_ENABLED && extraOwnerFilter) {
    const { data: extraData, error: extraError } =
      extraRes as { data: unknown[] | null; error: { message: string } | null }

    if (extraError) {
      throw new Error('We could not load complete pay. Please try again.')
    } else {
      type ExtraRow = {
        id: string
        host_id: string | null
        moderator_id: string | null
        kind: ExtraPayKind
        rate_cents: number
        start_time: string
        end_time: string
        notes: string | null
        brand: { id: string; name: string } | { id: string; name: string }[] | null
      }
      extraShifts = ((extraData ?? []) as unknown as ExtraRow[]).map(e => {
        const brand = unwrap(e.brand)
        return {
          id: e.id,
          // Extra-pay slots are usually company-wide (brand_id is optional and
          // the admin UI leaves it null), so they group under their own label
          // rather than a brand. The synthetic id keeps the brand filter sane.
          brandId: brand?.id ?? `extra:${e.kind}`,
          brandName: brand?.name ?? EXTRA_PAY_LABELS[e.kind],
          producerName: null,
          startISO: e.start_time,
          endISO: e.end_time,
          rateCents: e.rate_cents,
          totalCents: extraPayCents(e.start_time, e.end_time, e.rate_cents),
          isPast: isExtraPayRealized(e.end_time, now),
          notes: e.notes,
          // The real role, so the badge matches the roster the block was
          // booked against. Pay is the slot's own frozen rate either way —
          // nothing downstream derives an amount from this field.
          role: e.host_id ? 'host' : 'moderator',
        }
      })
    }
  }

  const shifts: ShiftRow[] = [...hostShifts, ...moderatorShifts, ...extraShifts]

  // Header subtitle prefers the host name if both exist (host is the more
  // public-facing role); falls back to the moderator name.
  const displayName = myHost?.name ?? myModerator?.name ?? 'You'

  // Host sessions in the selected pay period, for GMV reporting.
  //
  // Sessions are assembled with complete touching boundary context and then
  // filtered, rather than windowing the streams first. A session is a run of
  // contiguous shifts, so cutting the input at the period boundary would split
  // a session that runs across it into two half-sessions — one in each period,
  // each reporting its own GMV. That is the same defect shape as the moderator
  // prep blocks double-paying at every boundary (fixed 2026-08-29): assemble
  // whole, then decide which period the whole thing belongs to.
  //
  // Filtered on the session's END, matching how payroll buckets everything
  // else, so a session appears in exactly one period — the one it finishes in.
  //
  // Compare parsed instants, not raw ISO strings — the DB returns "…+00:00"
  // and our bounds are ".000Z", which are lexicographically unequal at the same
  // instant and would misfile a session landing exactly on a boundary midnight.
  const periodFromMs = new Date(period.fromISO).getTime()
  const periodToExclusiveMs = new Date(period.toExclusiveISO).getTime()

  // GMV-eligible streams = everything the caller HOSTED or MODERATED. Moderators
  // can report GMV since migration 074, and a user can be both roles on the same
  // stream, so the two lists are merged through a Map keyed by stream id -- a
  // stream in both would otherwise be built into two identical sessions and the
  // worker would see the same session listed twice.
  const gmvStreamById = new Map<string, {
    id: string; brand_id: string; host_id: string | null
    start_time: string; end_time: string; gmv_cents: number | null
  }>()
  for (const s of [...hostStreams, ...moderatorStreams]) {
    gmvStreamById.set(s.id, {
      id: s.id,
      brand_id: s.brand_id,
      host_id: s.host_id ?? null,
      start_time: s.start_time,
      end_time: s.end_time,
      gmv_cents: s.gmv_cents ?? null,
    })
  }
  // Who the caller is on each session, which decides both the label and whether
  // they may edit. Computed from BOTH id sets rather than inferring one from the
  // other: a user can be the host AND the moderator of the same session, and
  // treating "is a host on it" as "is not the moderator" would wrongly deny them.
  const hostStreamIds = new Set(hostStreams.map(s => s.id))
  const moderatorStreamIds = new Set(moderatorStreams.map(s => s.id))
  // Migration 075: moderators report GMV; a host may only do so when flagged
  // self-moderating. This mirrors set_session_gmv -- and it is only the UI half.
  // The database is the real gate (CLAUDE.md rule 26); this exists so nobody is
  // shown a box whose save would be rejected.
  const hostMayReport = Boolean(myHost?.self_moderating)

  const brandNameById = new Map(
    [...hostStreams, ...moderatorStreams].map(s => [s.brand_id, s.brand!.name]),
  )

  // buildSessionsByHost, NOT buildSessions: a moderator can cover two different
  // hosts back to back on one brand, and buildSessions groups by brand + time
  // contiguity ALONE. Merging those would produce one session whose GMV the
  // org-wide Performance totals count once for each host -- the same revenue,
  // twice. Partitioning by host first makes that impossible. Rows with no host
  // are dropped there, matching the write RPC, which rejects them.
  const allSessions = buildSessionsByHost(Array.from(gmvStreamById.values()))

  const sessions: HostSession[] = allSessions.filter(sess => {
    const endMs = new Date(sess.endISO).getTime()
    return endMs >= periodFromMs && endMs < periodToExclusiveMs
  }).map(sess => ({
    anchorId: sess.anchorId,
    brandId: sess.brandId,
    brandName: brandNameById.get(sess.brandId) ?? 'Brand',
    startISO: sess.startISO,
    endISO: sess.endISO,
    hours: sess.hours,
    gmvCents: sess.gmvCents,
    ended: new Date(sess.endISO).getTime() <= now,
    // Audit trail (migration 074). Two people can now write one session's GMV,
    // so showing who last set it turns a silent overwrite into a visible
    // disagreement. Read off the ANCHOR -- that is the row the value lives on.
    lastSavedByName: sessionGmvById.get(sess.anchorId)?.updatedByName ?? null,
    lastSavedAtISO: sessionGmvById.get(sess.anchorId)?.updatedAt ?? null,
    // True when the caller is only the MODERATOR on this session.
    viaModerator:
      sess.streamIds.some(id => moderatorStreamIds.has(id))
      && !sess.streamIds.some(id => hostStreamIds.has(id)),
    // Editable when they moderate it, or they host it AND are self-moderating.
    canEdit:
      sess.streamIds.some(id => moderatorStreamIds.has(id))
      || (hostMayReport && sess.streamIds.some(id => hostStreamIds.has(id))),
  }))

  // Section 5 of the Performance Tab checklist: three numbers, for HOSTS only.
  // Complete database aggregates are independent of the visible shift window.
  // The monthly goal remains a calendar-month figure, not a pay-period figure.
  //
  // Only sessions the caller actually HOSTED count. A moderator-only user gets
  // nothing here: this is the host's own revenue performance, and their
  // moderated sessions belong to the host who ran them.
  //
  // "No extra data exposed" -- no pairing data, no comparisons, no trends.
  let hostGmv: HostGmvCards | undefined
  if (myHost) {
    hostGmv = {
      allTimePerHourCents: gmvSummary?.all_time_per_hour_cents ?? null,
      thisMonthPerHourCents: gmvSummary?.this_month_per_hour_cents ?? null,
      goalPerHourCents: myHost.monthly_gmv_goal_cents ?? null,
    }
  }

  return (
    <div className="h-full overflow-auto">
      <MyShiftsList
        hostName={displayName}
        shifts={shifts}
        totals={totals}
        periodKey={periodKey}
        currentPeriodKey={currentPeriodKey}
        sessions={sessions}
        hostGmv={hostGmv}
      />
    </div>
  )
}
