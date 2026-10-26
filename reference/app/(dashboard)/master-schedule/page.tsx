import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { resolveRole } from '@/lib/role'
import { formatPT, nowPtAsUtc, minutesToTimeString, colorFromHex } from '@/lib/utils'
import {
  resolveScheduleRange,
  shiftScheduleDate,
  unionDayWindow,
  buildMasterEvents,
  buildBrandColorMap,
  type ScheduleView,
  type BrandColor,
} from '@/lib/masterSchedule'
import { MasterScheduleView } from '@/components/calendar/MasterScheduleView'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { type StreamWithRelations } from '@/lib/supabase/types'

interface MasterSchedulePageProps {
  searchParams: Promise<{ view?: string; date?: string }>
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Same joined select shape the per-brand calendar uses. */
const STREAM_SELECT =
  'id, title, brand_id, host_id, producer_id, moderator_id, start_time, end_time, notes, created_by, created_at, host:hosts(id,name), brand:brands(id,name), producer:producers(id,name), moderator:moderators(id,name)'

export default async function MasterSchedulePage({ searchParams }: MasterSchedulePageProps) {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)

  // Cross-brand master schedule is a company-wide, admin-only overview.
  if (!effectiveIsAdmin) redirect('/calendar')

  const { view: viewParam, date: dateParam } = await searchParams
  const view: ScheduleView = viewParam === 'day' ? 'day' : 'week'
  const todayKey = formatPT(nowPtAsUtc(), 'yyyy-MM-dd')
  const dateKey = dateParam && YMD.test(dateParam) ? dateParam : todayKey

  const range = resolveScheduleRange(view, dateKey)

  // Only the visible range, across every brand — keeps the query bounded no
  // matter how many brands/lives accrue.
  const [{ data: streamsData }, { data: brandsData }] = await Promise.all([
    supabase
      .from('streams')
      .select(STREAM_SELECT)
      .gte('start_time', range.fromISO)
      .lt('start_time', range.toExclusiveISO)
      .order('start_time'),
    // Explicit columns (incl. color) — kept off BRAND_PUBLIC_COLUMNS so the
    // sidebar/layout queries don't depend on the color migration.
    supabase.from('brands').select('id, day_start_minutes, day_end_minutes, color').order('name'),
  ])

  const streams = (streamsData as unknown as StreamWithRelations[] | null) ?? []
  const brands = (brandsData as unknown as { id: string; color: string | null; day_start_minutes: number; day_end_minutes: number }[] | null) ?? []

  // Color per brand: the admin-chosen color when set, else the index palette
  // (brands come ordered by name) so adjacent brands don't collide on hues.
  const fallbackColors = buildBrandColorMap(brands.map(b => b.id))
  const colorMap: Map<string, BrandColor> = new Map(
    brands.map(b => [b.id, b.color ? colorFromHex(b.color) : fallbackColors.get(b.id)!] as const),
  )
  const events = buildMasterEvents(streams, colorMap)
  const { startMinutes, endMinutes } = unionDayWindow(brands)
  const slotMinTime = minutesToTimeString(startMinutes)
  const slotMaxTime = minutesToTimeString(endMinutes)

  // Server-param navigation — every control is a link that swaps view/date.
  const href = (v: ScheduleView, d: string) => `/master-schedule?view=${v}&date=${d}`
  const prevHref = href(view, shiftScheduleDate(view, dateKey, -1))
  const nextHref = href(view, shiftScheduleDate(view, dateKey, 1))
  const todayHref = href(view, todayKey)

  const rangeLabel = view === 'day'
    ? formatPT(range.fromISO, 'EEEE, MMM d, yyyy')
    : `${formatPT(range.fromISO, 'MMM d')} – ${formatPT(range.toKey, 'MMM d, yyyy')}`

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Master Schedule</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Every brand&apos;s lives, {view === 'day' ? 'this day' : 'this week'}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Day / Week toggle */}
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <Link
              href={href('day', dateKey)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                view === 'day'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-secondary',
              )}
            >
              Day
            </Link>
            <Link
              href={href('week', dateKey)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors border-l border-border',
                view === 'week'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-secondary',
              )}
            >
              Week
            </Link>
          </div>

          <Button asChild variant="outline" size="sm">
            <Link href={todayHref}>Today</Link>
          </Button>
          <Button asChild variant="outline" size="icon" aria-label={view === 'day' ? 'Previous day' : 'Previous week'}>
            <Link href={prevHref}><ChevronLeft className="w-4 h-4" /></Link>
          </Button>
          <div className="px-4 py-2 min-w-[200px] text-center font-semibold text-foreground bg-card border border-border rounded-md">
            {rangeLabel}
          </div>
          <Button asChild variant="outline" size="icon" aria-label={view === 'day' ? 'Next day' : 'Next week'}>
            <Link href={nextHref}><ChevronRight className="w-4 h-4" /></Link>
          </Button>
        </div>
      </div>

      {/* Calendar */}
      <div className="flex-1 min-h-0">
        <MasterScheduleView
          view={view}
          dateKey={dateKey}
          events={events}
          slotMinTime={slotMinTime}
          slotMaxTime={slotMaxTime}
        />
      </div>
    </div>
  )
}
