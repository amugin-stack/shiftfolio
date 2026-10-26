import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc, parseMonth } from '@/lib/utils'
import {
  buildSessions, buildSessionsByPair, aggregateGmv,
  type GmvStreamInput, type PairedGmvStreamInput, type Session,
} from '@/lib/gmv'
import { ptDayOfWeek, timeBlock, type TimeBlock } from '@/lib/performanceStats'
import { HostPerformanceView, type HostPerfRow, type PerfTab } from '@/components/admin/HostPerformanceView'

interface PageProps {
  searchParams: Promise<{
    month?: string
    from?: string
    to?: string
    tab?: string
    dow?: string
    block?: string
  }>
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/**
 * Resolve the reporting window. A custom `?from=&to=` range wins; otherwise the
 * `?month=` behaviour is unchanged, so every existing deep link still works.
 * `to` is INCLUSIVE in the URL and exclusive internally, matching how the
 * payroll export's custom range reads to a human.
 */
function resolveWindow(sp: { month?: string; from?: string; to?: string }) {
  if (sp.from && sp.to && YMD.test(sp.from) && YMD.test(sp.to) && sp.from <= sp.to) {
    const [fy, fm, fd] = sp.from.split('-').map(Number)
    const [ty, tm, td] = sp.to.split('-').map(Number)
    return {
      start: new Date(Date.UTC(fy, fm - 1, fd)),
      end: new Date(Date.UTC(ty, tm - 1, td + 1)),
      monthKey: parseMonth(undefined).key,
      fromKey: sp.from,
      toKey: sp.to,
      isCustom: true as const,
    }
  }
  const { year, month, key } = parseMonth(sp.month)
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
    monthKey: key,
    fromKey: undefined,
    toKey: undefined,
    isCustom: false as const,
  }
}

type StreamRow = {
  id: string
  brand_id: string
  host_id: string | null
  moderator_id: string | null
  start_time: string
  end_time: string
  gmv_cents: number | null
  host: { id: string; name: string } | { id: string; name: string }[] | null
  moderator: { id: string; name: string } | { id: string; name: string }[] | null
}

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v)

// gmv_cents is locked from raw reads (migration 055) — sourced from
// admin_stream_pay and merged in by stream id via the gmvById map below.
const STREAM_SELECT =
  'id, brand_id, host_id, moderator_id, start_time, end_time, host:hosts(id, name), moderator:moderators(id, name)'

/** Group host-assigned streams by host id → normalized GMV inputs. */
function groupByHost(
  data: unknown,
  gmvById: Map<string, number | null>,
): Map<string, { name: string; streams: GmvStreamInput[] }> {
  const rows = ((data ?? []) as unknown as StreamRow[])
    .map(s => ({ ...s, host: Array.isArray(s.host) ? s.host[0] ?? null : s.host }))
    .filter(s => s.host_id)
  const byHost = new Map<string, { name: string; streams: GmvStreamInput[] }>()
  for (const s of rows) {
    const hostId = s.host_id as string
    const acc = byHost.get(hostId) ?? { name: s.host?.name ?? 'Unknown', streams: [] }
    acc.streams.push({
      id: s.id,
      brand_id: s.brand_id,
      start_time: s.start_time,
      end_time: s.end_time,
      gmv_cents: gmvById.get(s.id) ?? null,
    })
    byHost.set(hostId, acc)
  }
  return byHost
}

/** Sessions that START inside [fromISO, ...). See the lookback note below. */
function sessionsInWindow(streams: GmvStreamInput[], fromISO: string) {
  const fromMs = new Date(fromISO).getTime()
  // Compare parsed instants, never raw ISO strings: PostgREST renders
  // "...+00:00" while our bounds are ".000Z" -- lexicographically different at
  // an identical instant, which would misclassify a session starting exactly on
  // the window's first midnight.
  return buildSessions(streams).filter(s => new Date(s.startISO).getTime() >= fromMs)
}

function sumWeekGmv(streams: GmvStreamInput[], fromISO: string): number {
  return sessionsInWindow(streams, fromISO).reduce((sum, s) => sum + (s.gmvCents ?? 0), 0)
}

export default async function HostPerformanceListPage({ searchParams }: PageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) redirect('/calendar')

  const sp = await searchParams
  const win = resolveWindow(sp)
  const monthKey = win.monthKey
  const monthStart = win.start
  const monthEnd = win.end

  const tab: PerfTab =
    sp.tab === 'moderators' || sp.tab === 'pairings' ? sp.tab : 'hosts'
  // Filters are applied to SESSIONS, after they are built -- never to the query.
  // Filtering rows out before buildSessions would break contiguous runs apart
  // and orphan the anchor that carries the GMV.
  const dowFilter = sp.dow != null && /^[0-6]$/.test(sp.dow) ? Number(sp.dow) : null
  const blockFilter: TimeBlock | null =
    sp.block === 'morning' || sp.block === 'afternoon' || sp.block === 'evening'
      ? sp.block
      : null
  const passesFilters = (sess: Session) =>
    (dowFilter == null || ptDayOfWeek(sess.startISO) === dowFilter)
    && (blockFilter == null || timeBlock(sess.startISO) === blockFilter)

  // Current PT week (Mon–Sun), independent of the nav month — queried
  // separately so "GMV this week" is correct no matter which month is in view.
  const now = nowPtAsUtc()
  const dow = now.getUTCDay() // 0=Sun..6=Sat (PT-naive)
  const daysFromMonday = dow === 0 ? 6 : dow - 1
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday))
  const weekStartISO = weekStart.toISOString()
  const weekEndISO = new Date(weekStart.getTime() + 7 * 86_400_000).toISOString()

  // Both queries are padded 1 day EARLIER than the range they report on, and
  // the extra rows are dropped again after sessions are built.
  //
  // GMV is stored on a session's ANCHOR (its first stream). A session running
  // Sun 21:00 -> Mon 01:00 has its GMV on the Sunday row, so a week window
  // starting Mon 00:00 fetched only the tail of it -- buildSessions then saw a
  // session whose every member had a null gmv_cents and reported $0. The
  // revenue was recorded correctly; the window was cutting it in half.
  //
  // Padding makes the straddling session whole; filtering by session START
  // afterwards keeps attribution unchanged (a session belongs to the period it
  // began in) and stops the padded rows being counted twice.
  const monthLookbackISO = new Date(monthStart.getTime() - 86_400_000).toISOString()
  const weekLookbackISO = new Date(weekStart.getTime() - 86_400_000).toISOString()

  // The pay map must span EVERY range this page reads, not just the month.
  //
  // The week above is deliberately independent of the nav month ("GMV this
  // week" stays correct whichever month you are viewing), so on any past month
  // the week sits entirely OUTSIDE the month window -- and a pay map windowed
  // to the month alone would return nothing for it, making every week GMV read
  // $0. Cover the union of both ranges.
  //
  // The +1 day on the upper bound closes a second gap: admin_stream_pay filters
  // on end_time (migration 068) while these queries filter on start_time, so a
  // shift starting just inside a range can end just outside it.
  const payFromISO = new Date(
    Math.min(monthStart.getTime(), weekStart.getTime()) - 86_400_000,
  ).toISOString()
  const payToISO = new Date(
    Math.max(monthEnd.getTime(), new Date(weekEndISO).getTime()) + 86_400_000,
  ).toISOString()

  const [monthData, weekData, streamPayRows] = await Promise.all([
    fetchAllRows(() =>
      supabase.from('streams').select(STREAM_SELECT).not('host_id', 'is', null)
        .gte('start_time', monthLookbackISO).lt('start_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    fetchAllRows(() =>
      supabase.from('streams').select(STREAM_SELECT).not('host_id', 'is', null)
        .gte('start_time', weekLookbackISO).lt('start_time', weekEndISO)
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: payFromISO, p_to: payToISO }) as never),
  ])

  // Locked GMV per stream (empty for non-admins) → merged in by stream id.
  const gmvById = new Map<string, number | null>(
    ((streamPayRows ?? []) as { id: string; gmv_cents: number | null }[]).map(r => [r.id, r.gmv_cents]),
  )

  const monthByHost = groupByHost(monthData, gmvById)
  const weekByHost = groupByHost(weekData, gmvById)

  // Names for labelling; the pair rows need both rosters.
  const nameById = new Map<string, string>()
  for (const raw of [monthData, weekData]) {
    for (const r of ((raw ?? []) as unknown as StreamRow[])) {
      const h = one(r.host)
      if (h) nameById.set(h.id, h.name)
      const m = one(r.moderator)
      if (m) nameById.set(m.id, m.name)
    }
  }

  const windowStartMs = monthStart.getTime()

  /** Sessions grouped under an arbitrary key, then aggregated into a row. */
  function rowsFrom(
    sessions: Session[],
    keyOf: (s: Session) => string | null,
    labelOf: (s: Session) => string,
  ): HostPerfRow[] {
    const groups = new Map<string, { label: string; sessions: Session[] }>()
    for (const sess of sessions) {
      if (new Date(sess.startISO).getTime() < windowStartMs) continue
      if (!passesFilters(sess)) continue
      const k = keyOf(sess)
      if (!k) continue
      const g = groups.get(k)
      if (g) g.sessions.push(sess)
      else groups.set(k, { label: labelOf(sess), sessions: [sess] })
    }
    return Array.from(groups.entries())
      .map(([key, g]) => {
        const agg = aggregateGmv(g.sessions)
        return {
          key,
          label: g.label,
          // Only the Hosts tab links onward -- the per-host detail page is the
          // only detail view that exists.
          href: tab === 'hosts' ? `/admin/performance/${key}?month=${monthKey}` : undefined,
          monthGmvCents: agg.totalGmvCents,
          weekGmvCents: 0,
          gmvPerHourCents: agg.gmvPerHourCents,
          sessionsWithGmv: g.sessions.filter(s => s.gmvCents != null).length,
          totalSessions: g.sessions.length,
        }
      })
      .sort((a, b) => b.monthGmvCents - a.monthGmvCents)
  }

  let rows: HostPerfRow[]
  if (tab === 'hosts') {
    // Unchanged from before: hosts keep buildSessionsByHost, so their numbers do
    // not shift. Partitioning a host's sessions by moderator would split them
    // and inflate their session count for a reason that is not about the host.
    rows = Array.from(monthByHost.entries())
      .map(([hostId, h]) => {
        const sessions = sessionsInWindow(h.streams, monthStart.toISOString())
          .filter(passesFilters)
        const agg = aggregateGmv(sessions)
        return {
          key: hostId,
          label: h.name,
          href: `/admin/performance/${hostId}?month=${monthKey}`,
          monthGmvCents: agg.totalGmvCents,
          weekGmvCents: sumWeekGmv(weekByHost.get(hostId)?.streams ?? [], weekStartISO),
          gmvPerHourCents: agg.gmvPerHourCents,
          sessionsWithGmv: sessions.filter(s => s.gmvCents != null).length,
          totalSessions: sessions.length,
        }
      })
      .sort((a, b) => b.monthGmvCents - a.monthGmvCents)
  } else {
    // Moderator and pairing rows BOTH come from pair-partitioned sessions.
    // Grouping by moderator alone would merge two hosts' back-to-back work on
    // one brand into a single session and count that revenue for each host --
    // the mirror image of the double-count buildSessionsByHost prevents.
    const paired: PairedGmvStreamInput[] = ((monthData ?? []) as unknown as StreamRow[])
      .filter(r => r.host_id)
      .map(r => ({
        id: r.id,
        brand_id: r.brand_id,
        host_id: r.host_id,
        moderator_id: r.moderator_id,
        start_time: r.start_time,
        end_time: r.end_time,
        gmv_cents: gmvById.get(r.id) ?? null,
      }))
    const pairSessions = buildSessionsByPair(paired)

    rows = tab === 'moderators'
      ? rowsFrom(
          pairSessions,
          sess => sess.moderatorId ?? null,
          sess => nameById.get(sess.moderatorId ?? '') ?? 'Unknown',
        )
      : rowsFrom(
          pairSessions,
          sess => (sess.moderatorId ? `${sess.hostId}|${sess.moderatorId}` : null),
          sess =>
            `${nameById.get(sess.hostId ?? '') ?? 'Unknown'} · ${nameById.get(sess.moderatorId ?? '') ?? 'Unknown'}`,
        )
  }

  // Headline totals span ALL hosts active in the period (a host live this week
  // but not in the nav month still counts toward the week tile). Deliberately
  // NOT filtered by day/time -- they are the period's totals, and a filtered
  // headline next to filtered rows would leave no way to see the whole.
  const monthTotalCents = Array.from(monthByHost.values()).reduce(
    (sum, h) => sum + aggregateGmv(sessionsInWindow(h.streams, monthStart.toISOString())).totalGmvCents,
    0,
  )
  const weekTotalCents = Array.from(weekByHost.values()).reduce((s, h) => s + sumWeekGmv(h.streams, weekStartISO), 0)

  return (
    <div className="p-6">
      <HostPerformanceView
        monthKey={monthKey}
        tab={tab}
        rows={rows}
        weekTotalCents={weekTotalCents}
        monthTotalCents={monthTotalCents}
        fromKey={win.fromKey}
        toKey={win.toKey}
        isCustomRange={win.isCustom}
        dow={dowFilter}
        block={blockFilter}
      />
    </div>
  )
}
