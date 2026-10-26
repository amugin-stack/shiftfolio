import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole } from '@/lib/role'
import { nowPtAsUtc, parseMonth } from '@/lib/utils'
import { buildSessions, aggregateGmv, gmvPerHourCents, type GmvStreamInput } from '@/lib/gmv'
import {
  HostPerformanceDetailView,
  type HostPerformanceDetail,
  type PerfSessionRow,
} from '@/components/admin/HostPerformanceDetailView'

interface PageProps {
  params: Promise<{ hostId: string }>
  searchParams: Promise<{ month?: string }>
}

/** Sessions that START inside [fromISO, ...). Queries are padded one day
 *  earlier so a session straddling the window start is assembled whole; this
 *  drops the padded ones again so nothing is counted twice and attribution
 *  stays "a session belongs to the period it began in". Instants, not ISO
 *  strings: PostgREST renders "...+00:00" while our bounds are ".000Z". */
function sessionsInWindow(streams: GmvStreamInput[], fromISO: string) {
  const fromMs = new Date(fromISO).getTime()
  return buildSessions(streams).filter(s => new Date(s.startISO).getTime() >= fromMs)
}

export default async function HostPerformanceDetailPage({ params, searchParams }: PageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  if (!effectiveIsAdmin) redirect('/calendar')

  const { hostId } = await params
  const { year, month, key: monthKey } = parseMonth((await searchParams).month)
  const monthStart = new Date(Date.UTC(year, month, 1))
  const monthEnd = new Date(Date.UTC(year, month + 1, 1))

  const { data: hostData } = await supabase
    .from('hosts').select('id, name').eq('id', hostId).single()
  const host = hostData as { id: string; name: string } | null
  if (!host) notFound()

  // Current PT week (Mon–Sun), queried separately from the nav month so the
  // week total is correct regardless of which month is in view.
  const now = nowPtAsUtc()
  const dow = now.getUTCDay()
  const daysFromMonday = dow === 0 ? 6 : dow - 1
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday))
  const weekStartISO = weekStart.toISOString()
  const weekEndISO = new Date(weekStart.getTime() + 7 * 86_400_000).toISOString()

  // gmv_cents is locked from raw reads (migration 055) — sourced from
  // admin_stream_pay and merged in by stream id via the gmvById map below.
  const HOST_SELECT = 'id, brand_id, start_time, end_time, brand:brands(id, name)'
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
  // Padded 1 day earlier, then filtered by session START after building --
  // same fix the list page got. GMV lives on a session's ANCHOR, so a session
  // running Sun 21:00 -> Mon 01:00 has its revenue on the Sunday row; an
  // unpadded week window fetched only the tail and reported $0 while still
  // counting the session, understating GMV/hour.
  const monthLookbackISO = new Date(monthStart.getTime() - 86_400_000).toISOString()
  const weekLookbackISO = new Date(weekStart.getTime() - 86_400_000).toISOString()

  const payFromISO = new Date(Math.min(monthStart.getTime(), weekStart.getTime()) - 86_400_000).toISOString()
  const payToISO = new Date(
    Math.max(monthEnd.getTime(), new Date(weekEndISO).getTime()) + 86_400_000,
  ).toISOString()

  const [streamsData, weekStreamsData, streamPayRows] = await Promise.all([
    fetchAllRows(() =>
      supabase.from('streams').select(HOST_SELECT).eq('host_id', hostId)
        .gte('start_time', monthLookbackISO).lt('start_time', monthEnd.toISOString())
        .order('id') as never,
    ),
    fetchAllRows(() =>
      supabase.from('streams').select(HOST_SELECT).eq('host_id', hostId)
        .gte('start_time', weekLookbackISO).lt('start_time', weekEndISO)
        .order('id') as never,
    ),
    fetchAllRows(() => supabase.rpc('admin_stream_pay', { p_from: payFromISO, p_to: payToISO }) as never),
  ])

  const gmvById = new Map<string, number | null>(
    ((streamPayRows ?? []) as { id: string; gmv_cents: number | null }[]).map(r => [r.id, r.gmv_cents]),
  )

  type Row = {
    id: string
    brand_id: string
    start_time: string
    end_time: string
    gmv_cents: number | null
    brand: { id: string; name: string } | { id: string; name: string }[] | null
  }
  const streams = ((streamsData ?? []) as unknown as Row[]).map(s => ({
    ...s,
    brand: Array.isArray(s.brand) ? s.brand[0] ?? null : s.brand,
  }))
  const brandNameById = new Map(streams.map(s => [s.brand_id, s.brand?.name ?? 'Brand']))

  const gmvStreams: GmvStreamInput[] = streams.map(s => ({
    id: s.id,
    brand_id: s.brand_id,
    start_time: s.start_time,
    end_time: s.end_time,
    gmv_cents: gmvById.get(s.id) ?? null,
  }))
  const sessions = sessionsInWindow(gmvStreams, monthStart.toISOString())
  const agg = aggregateGmv(sessions)

  // Week total from the dedicated current-week query (independent of nav month).
  const weekGmvCents = sessionsInWindow(
    ((weekStreamsData ?? []) as unknown as Row[]).map(s => ({
      id: s.id,
      brand_id: s.brand_id,
      start_time: s.start_time,
      end_time: s.end_time,
      gmv_cents: gmvById.get(s.id) ?? null,
    })),
    weekStartISO,
  ).reduce((sum, s) => sum + (s.gmvCents ?? 0), 0)

  const sessionRows: PerfSessionRow[] = sessions
    .slice()
    .sort((a, b) => b.startISO.localeCompare(a.startISO))
    .map(s => ({
      anchorId: s.anchorId,
      startISO: s.startISO,
      endISO: s.endISO,
      brandName: brandNameById.get(s.brandId) ?? 'Brand',
      hours: s.hours,
      gmvCents: s.gmvCents,
      gmvPerHourCents: s.gmvCents == null ? null : gmvPerHourCents(s.gmvCents, s.hours),
    }))

  const data: HostPerformanceDetail = {
    hostName: host.name,
    weekGmvCents,
    monthGmvCents: agg.totalGmvCents,
    monthGmvPerHourCents: agg.gmvPerHourCents,
    sessions: sessionRows,
  }

  return (
    <div className="p-6">
      <HostPerformanceDetailView hostId={hostId} monthKey={monthKey} data={data} />
    </div>
  )
}
