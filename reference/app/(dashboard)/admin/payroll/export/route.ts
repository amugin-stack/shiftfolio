import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc } from '@/lib/utils'
import {
  resolvePresetRange,
  resolvePayPeriodRange,
  resolveCustomRange,
  buildHostRows,
  buildModeratorRows,
  sortPayrollRows,
  rowsToCsv,
  type DateRange,
  type PayBasis,
  type HostStreamInput,
  type ModeratorStreamInput,
  type PayrollRow,
  type ExtraPaySlotRow,
} from '@/lib/payrollExport'
import { EXTRA_PAY_ENABLED } from '@/lib/extraPay'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import type { Profile } from '@/lib/supabase/types'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // --- Auth: signed-in admin only (mirrors the payroll pages) ---
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('unauthorized', { status: 401 })

  const { data: profileData } = await supabase
    .from('profiles').select('*').eq('id', user.id).single()
  const profile = profileData as Profile | null
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) return new NextResponse('forbidden', { status: 403 })

  // --- Parse params ---
  const sp = request.nextUrl.searchParams
  const roleParam = (sp.get('roles') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const wantHosts = roleParam.includes('hosts')
  const wantModerators = roleParam.includes('moderators')
  if (!wantHosts && !wantModerators) {
    return new NextResponse('select at least one role', { status: 400 })
  }

  let range: DateRange
  // Marks an export of the CURRENT, still-running pay period so it cannot be
  // mistaken for the file you pay from. Shifts that have not ended yet are
  // excluded by buildHostRows, so the totals in that file are incomplete by
  // design and will grow before the period closes.
  let inProgress = false
  try {
    const preset = sp.get('preset')
    if (preset === 'current' || preset === 'previous') {
      // The anchored biweekly pay period — the same calendar every worker's My
      // Shifts page shows, so the number they see and the number you pay cover
      // the same fourteen days. Replaced the old rolling '2weeks' preset, which
      // measured 14 days back from whatever day you clicked and could therefore
      // leave days inside no window at all. '2weeks' is no longer accepted: a
      // stale bookmark must fail loudly rather than quietly produce a window
      // that disagrees with everyone's page.
      range = resolvePayPeriodRange(preset, nowPtAsUtc())
      inProgress = preset === 'current'
    } else if (preset === 'month') {
      range = resolvePresetRange(preset, nowPtAsUtc())
    } else {
      const from = sp.get('from')
      const to = sp.get('to')
      if (!from || !to) return new NextResponse('missing date range', { status: 400 })
      range = resolveCustomRange(from, to)
    }
  } catch {
    return new NextResponse('invalid date range', { status: 400 })
  }

  const nowMs = nowPtAsUtc().getTime()

  // WHICH HOURS TO PAY (the support team, 2026-09-04). Payroll is run a couple of days
  // BEFORE the period closes, so a completed-only file drops every shift still
  // to come and people are paid short, then topped up by hand.
  //
  // Defaults to 'completed' when the parameter is ABSENT, so an old bookmark
  // keeps its previous meaning. The dialog always sends it explicitly and
  // defaults to scheduled there -- the two defaults differ on purpose.
  const basis: PayBasis = sp.get('basis') === 'scheduled' ? 'expected' : 'realized'
  const scheduled = basis === 'expected'

  // Shifts with a cancellation already REQUESTED are excluded from a scheduled
  // export. This is the one overpayment that is both likely and already
  // knowable: a pending request does not touch the stream row at all (it is a
  // UI disable flag), so without this we would pay, in full, a shift everyone
  // involved knows is being cancelled.
  //
  // Only needed when paying ahead. Under the completed basis the shift has
  // already happened, and an approved cancellation DELETES the row outright
  // (there is no cancelled state on streams), so there is nothing to exclude.
  const cancelPendingIds = new Set<string>()
  if (scheduled) {
    const { data: pendingRows, error: pendingError } = await supabase
      .from('shift_cancellation_requests')
      .select('stream_id')
      .eq('status', 'pending')
    if (pendingError) {
      // FATAL, unlike the optional extra-pay queries. Degrading here would mean
      // silently paying for shifts we were told are being cancelled -- money
      // out of the door on the strength of a failed query.
      console.error('[payroll/export] pending-cancellation lookup failed:', pendingError.message)
      return new NextResponse('query failed', { status: 500 })
    }
    for (const r of ((pendingRows ?? []) as { stream_id: string }[])) {
      cancelPendingIds.add(r.stream_id)
    }
  }

  const allRows: PayrollRow[] = []

  // --- Hosts ---
  if (wantHosts) {
    // host.rate_cents (flat) + host_rate_cents (frozen per-shift) are locked
    // from raw reads (migration 055) — fetched via admin-only RPCs and merged
    // back onto the same objects buildHostRows reads.
    // Every one of these is PAGED, and every one THROWS on failure rather than
    // degrading to an empty list. Both properties are load-bearing:
    //
    //  * Paged, because PostgREST truncates at 1000 rows silently. The streams
    //    query is only bounded by the export window, and a custom range can be
    //    arbitrarily wide; admin_stream_pay() is not bounded at all. Dropped
    //    stream rows are simply ABSENT from the CSV, so a contractor is paid
    //    short by however many of their shifts landed past the cap — with the
    //    file looking perfectly well-formed. Dropped pay rows are worse than
    //    absent: a missing entry reads as "no frozen rate", which re-prices a
    //    historical shift at the host's current rate (see migration 064).
    //
    //  * Fatal, because the previous code discarded the RPC errors entirely and
    //    fell back to `?? 0`. If admin_host_rate_map failed transiently, every
    //    host resolved to a 0 rate and the CSV downloaded cleanly with $0.00 in
    //    every Amount Owed cell. An admin paying from that file pays nobody,
    //    and nothing anywhere says a query failed. A 500 is the correct answer.
    let streamsData: unknown[]
    let hostRateRows: unknown[]
    let streamPayRows: unknown[]
    try {
      ;[streamsData, hostRateRows, streamPayRows] = await Promise.all([
        fetchAllRows(() =>
          supabase
            .from('streams')
            .select('id, host_id, start_time, end_time, host:hosts(id, name)')
            .not('host_id', 'is', null)
            .gte('end_time', range.fromISO)
            .lt('end_time', range.toExclusiveISO)
            .order('id') as never,
        ),
        fetchAllRows(() => supabase.rpc('admin_host_rate_map') as never),
        fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: range.fromISO, p_to: range.toExclusiveISO }) as never),
      ])
    } catch {
      return new NextResponse('query failed', { status: 500 })
    }

    const hostRateMap = new Map<string, number>(
      ((hostRateRows ?? []) as { host_id: string; rate_cents: number }[]).map(r => [r.host_id, r.rate_cents]),
    )
    const streamPayMap = new Map<string, { host_rate_cents: number | null }>(
      ((streamPayRows ?? []) as { id: string; host_rate_cents: number | null }[]).map(r => [r.id, { host_rate_cents: r.host_rate_cents }]),
    )

    type Row = {
      id: string; host_id: string | null
      start_time: string; end_time: string
      host:
        | { id: string; name: string; rate_cents: number }
        | { id: string; name: string; rate_cents: number }[]
        | null
    }
    const streams = (((streamsData ?? []) as unknown as Row[])
      .map(s => {
        const host = Array.isArray(s.host) ? s.host[0] ?? null : s.host
        if (host) host.rate_cents = hostRateMap.get(s.host_id ?? '') ?? 0
        return { ...s, host, host_rate_cents: streamPayMap.get(s.id)?.host_rate_cents ?? null }
      })
      .filter(s => Boolean(s.host_id))
      // Empty unless paying ahead — see the note where it is built.
      .filter(s => !cancelPendingIds.has(s.id))) as unknown as HostStreamInput[]

    // Non-livestream paid work (setup / training / office hours, mig 057).
    // Only queried when the feature is on, so the CSV keeps its exact prior
    // shape — and its prior CONTENTS — while the switch is off.
    let extraSlots: ExtraPaySlotRow[] = []
    if (EXTRA_PAY_ENABLED) {
      // Paged like the rest — but the failure stays NON-FATAL by design, so it
      // catches rather than propagating. This used to `return 500`, which meant
      // a problem with an optional bonus category (e.g. migration 057 not yet
      // applied, returning 42P01) killed the ENTIRE payroll export — hosts AND
      // moderators — on payroll day, with a message that explained nothing.
      // Degrade to livestream-only pay instead, and make the omission loud in
      // the logs rather than silent in the numbers.
      type ExtraRow = Omit<ExtraPaySlotRow, 'host'> & {
        host: { name: string } | { name: string }[] | null
      }
      try {
        const extraData = await fetchAllRows<ExtraRow>(() =>
          supabase
            .from('extra_pay_slots')
            .select('id, host_id, kind, rate_cents, status, start_time, end_time, host:hosts(name)')
            // Explicit since migration 073 — the table now also holds moderator
            // slots. buildHostRows skips them anyway, but fetching them here
            // and moderator rows again below would double the work and make the
            // two blocks look like they overlap when they must not.
            .not('host_id', 'is', null)
            .neq('status', 'canceled')
            .gte('end_time', range.fromISO)
            .lt('end_time', range.toExclusiveISO)
            .order('id') as never,
        )
        extraSlots = extraData.map(e => ({
          ...e,
          host: Array.isArray(e.host) ? e.host[0] ?? null : e.host,
        }))
      } catch (err) {
        console.error(
          '[payroll/export] extra-pay query failed; exporting WITHOUT extra pay:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    allRows.push(...buildHostRows(streams, nowMs, extraSlots, basis))
  }

  // --- Moderators ---
  if (wantModerators) {
    // Pad the lower bound by 1 day so a shift that ENDED just before this
    // window is still visible as session context — that is what lets the
    // builder recognise a shift at the window's start as a continuation rather
    // than the start of a fresh session. Those padded rows contribute context
    // only, never pay: the builder drops anything ending before the true range.
    // (Windows are end-based, so a session's pay AND its prep both land in the
    // period it finishes in.)
    const lookbackISO = new Date(
      new Date(range.fromISO).getTime() - 86_400_000,
    ).toISOString()
    // Padded on BOTH sides so a session straddling either boundary is
    // assembled identically in both periods -- otherwise its prep block is
    // paid once in each. buildModeratorRows gates both ends back to the true
    // range, so the padding contributes session context only, never pay.
    const lookaheadISO = new Date(
      new Date(range.toExclusiveISO).getTime() + 86_400_000,
    ).toISOString()
    // moderator.rate_cents is locked from raw reads (migration 055) — fetched
    // via an admin-only RPC and merged onto the same objects the builder reads.
    // Paged + fatal-on-error, for the same reasons as the host block above.
    let streamsData: unknown[]
    let modRateRows: unknown[]
    try {
      ;[streamsData, modRateRows] = await Promise.all([
        fetchAllRows(() =>
          supabase
            .from('streams')
            .select('id, brand_id, moderator_id, start_time, end_time, moderator:moderators(id, name)')
            .not('moderator_id', 'is', null)
            .gte('end_time', lookbackISO)
            .lt('end_time', lookaheadISO)
            .order('id') as never,
        ),
        fetchAllRows(() => supabase.rpc('admin_moderator_rate_map') as never),
      ])
    } catch {
      return new NextResponse('query failed', { status: 500 })
    }

    const modRateMap = new Map<string, number>(
      (modRateRows as { moderator_id: string; rate_cents: number }[]).map(r => [r.moderator_id, r.rate_cents]),
    )

    type Row = {
      id: string; brand_id: string
      moderator_id: string | null; start_time: string; end_time: string
      moderator:
        | { id: string; name: string; rate_cents: number }
        | { id: string; name: string; rate_cents: number }[]
        | null
    }
    const streams = (((streamsData ?? []) as unknown as Row[])
      .map(s => {
        const moderator = Array.isArray(s.moderator) ? s.moderator[0] ?? null : s.moderator
        if (moderator) moderator.rate_cents = modRateMap.get(s.moderator_id ?? '') ?? 0
        return { ...s, moderator }
      })
      .filter(s => Boolean(s.moderator_id && s.moderator))
      .filter(s => !cancelPendingIds.has(s.id))) as unknown as ModeratorStreamInput[]

    // Moderator extra pay (setup / training / office hours, migration 073).
    //
    // Queried on the TRUE range, NOT the padded lookback/lookahead used for the
    // streams above. The padding exists so a session straddling a boundary is
    // assembled whole; an extra-pay block is standalone and has no session to
    // assemble, so padding it would just pull in blocks from the neighbouring
    // periods. buildModeratorRows deliberately does not re-gate these rows, so
    // this window is the only thing bounding them — keep it the true one.
    //
    // Non-fatal on failure, exactly like the host block above and for the same
    // reason: a problem with an optional bonus category must not kill the whole
    // payroll export on payroll day. Degrade to livestream-only pay and make
    // the omission loud in the logs rather than silent in the numbers.
    let modExtraSlots: ExtraPaySlotRow[] = []
    if (EXTRA_PAY_ENABLED) {
      type ModExtraRow = Omit<ExtraPaySlotRow, 'moderator'> & {
        moderator: { name: string } | { name: string }[] | null
      }
      try {
        const rows = await fetchAllRows<ModExtraRow>(() =>
          supabase
            .from('extra_pay_slots')
            .select('id, host_id, moderator_id, kind, rate_cents, status, start_time, end_time, moderator:moderators(name)')
            .not('moderator_id', 'is', null)
            .neq('status', 'canceled')
            .gte('end_time', range.fromISO)
            .lt('end_time', range.toExclusiveISO)
            .order('id') as never,
        )
        modExtraSlots = rows.map(e => ({
          ...e,
          host: null,
          moderator: Array.isArray(e.moderator) ? e.moderator[0] ?? null : e.moderator,
        }))
      } catch (err) {
        console.error(
          '[payroll/export] moderator extra-pay query failed; exporting WITHOUT it:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    allRows.push(...buildModeratorRows(streams, nowMs, {
      fromISO: range.fromISO,
      toExclusiveISO: range.toExclusiveISO,
    }, modExtraSlots, basis))
  }

  // The Unworked Hours column appears only on a scheduled export, so a
  // completed-basis file keeps byte-for-byte the shape it has always had.
  const csv = rowsToCsv(sortPayrollRows(allRows), undefined, undefined, scheduled)

  // Both markers can apply. SCHEDULED says "this includes work not yet done";
  // IN-PROGRESS says "this period has not closed". A file paid from in advance
  // must never be mistaken for a settled one.
  const marks = [scheduled ? 'SCHEDULED' : null, inProgress ? 'IN-PROGRESS' : null]
    .filter(Boolean)
    .join('_')
  const filename = marks
    ? `payroll_${marks}_${range.fromKey}_to_${range.toKey}.csv`
    : `payroll_${range.fromKey}_to_${range.toKey}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
