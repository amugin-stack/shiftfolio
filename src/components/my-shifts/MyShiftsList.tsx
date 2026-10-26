'use client'

import { payFilterOptions, filterPayTotals, type PayTotal } from '@/lib/myShiftTotals'
export type { PayTotal } from '@/lib/myShiftTotals'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Building2, Mic, Clock, DollarSign, FileText, CheckCircle2, Megaphone, Filter, List as ListIcon, CalendarDays, Download } from 'lucide-react'
import Link from 'next/link'
import { formatCents, formatPT, nowPtAsUtc, utcToPt } from '@/lib/utils'
import { buildIcs, icsFilename } from '@/lib/icsExport'
import { HostEarningsBreakdown } from './HostEarningsBreakdown'
import { SessionGmvInput } from './SessionGmvInput'

// This page opens on the LIST view, and most people never switch away from it —
// yet a static import meant every visit downloaded and parsed all of
// FullCalendar (plus its day-grid and time-grid plugins) to render a component
// that was not on screen. Loading it on demand means the calendar toggle costs
// a brief spinner the first time it is used, and the default view gets faster
// for everyone.
//
// ssr:false because FullCalendar measures the DOM to lay out its grid.
const MyShiftsCalendar = dynamic(
  () => import('./MyShiftsCalendar').then(m => m.MyShiftsCalendar),
  {
    ssr: false,
    loading: () => (
      <div className="h-[70vh] animate-pulse rounded-lg bg-secondary" />
    ),
  },
)

export interface ShiftRow {
  id: string
  brandId: string
  brandName: string
  producerName: string | null
  startISO: string
  endISO: string
  rateCents: number
  totalCents: number
  isPast: boolean
  notes: string | null
  /** Which role they're filling on this shift. Determines the badge and how
   *  the totals were computed (per-date for host, flat × hours for moderator). */
  role: 'host' | 'moderator'
  /** First moderator of the (brand, day), PRE-cutoff only: +30 min of setup
   *  pay is already included in totalCents; drives the "+30m setup" tag. */
  setupBonus?: boolean
  /** New-rule prep pay (post-cutoff sessions, src/lib/prepTime.ts) attached
   *  to this session's anchor shift. Already included in totalCents; drives
   *  the "+30m prep" tag and the monthly Prep pay subtotal. */
  prepCents?: number
  /** Length of this session's prep block. Varies by session date — see
   *  PREP_DURATION_CUTOFF_ISO. Only set when prepCents is set. */
  prepMinutes?: number
  /** True once the WHOLE session has ended — prep realizes on session end,
   *  not on this anchor row's own end (which comes earlier in a multi-row
   *  session). Only set when prepCents is set. */
  prepRealized?: boolean
}

/** A session (run of touching shifts in one brand, for one host) for GMV
 *  reporting. Named "Host" for historical reasons -- since migration 074 a
 *  moderator on the session can report its GMV too. */
export interface HostSession {
  anchorId: string
  brandId: string
  brandName: string
  startISO: string
  endISO: string
  hours: number
  gmvCents: number | null
  ended: boolean
  /** Who last saved this session's GMV, and when (migration 074). Null when
   *  nobody has set it yet, or it predates the audit columns. */
  lastSavedByName?: string | null
  lastSavedAtISO?: string | null
  /** True when the caller is on this session as MODERATOR only. */
  viaModerator?: boolean
  /** Whether this user may CHANGE the figure. Moderators can; a host only when
   *  flagged self-moderating (migration 075). False renders it read-only —
   *  losing the ability to edit must not mean losing sight of the number. */
  canEdit?: boolean
}

/** The three read-only numbers on a host's own dashboard card (Section 5 of the
 *  Performance Tab checklist). Undefined for moderator-only users — this is the
 *  host's own revenue performance. Any figure may be null, meaning "no basis
 *  yet"; null renders as an em dash, never as $0.00. */
export interface HostGmvCards {
  allTimePerHourCents: number | null
  thisMonthPerHourCents: number | null
  goalPerHourCents: number | null
}

interface MyShiftsListProps {
  totals: PayTotal[]
  hostName: string
  shifts: ShiftRow[]
  /** Start date (YYYY-MM-DD) of the pay period driving the breakdown below.
   *  Resolved from the `?period=` searchParam on the server. */
  periodKey: string
  /** Start date of the pay period happening right now, for the "Current" badge. */
  currentPeriodKey: string
  /** Host sessions (this pay period) for GMV reporting. Empty for moderator-only users. */
  sessions?: HostSession[]
  /** GMV performance numbers for a host. Absent for moderator-only users. */
  hostGmv?: HostGmvCards
}

// All comparisons happen against the PT calendar so a host in any TZ sees
// the same day-bucket as the admin who scheduled the shift.
function ptDateKey(date: Date | string): string {
  return formatPT(date, 'yyyy-MM-dd')
}

function formatDayHeading(dayKey: string, sample: Date): string {
  // nowPtAsUtc(), NOT new Date(): under the PT-naive scheme a raw Date is real
  // UTC now, and formatPT would then render the UTC calendar date. Every
  // evening from 5pm PT (4pm in DST) UTC has already rolled over, so
  // tomorrow's shifts were being labelled "Today" and today's lost their
  // heading — daily, on every machine, regardless of the viewer's timezone.
  const ptNow = utcToPt(nowPtAsUtc())
  const todayKey    = formatPT(nowPtAsUtc(), 'yyyy-MM-dd')
  const tomorrowDate = new Date(ptNow); tomorrowDate.setDate(tomorrowDate.getDate() + 1)
  const tomorrowKey = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`

  if (dayKey === todayKey)    return `Today · ${formatPT(sample, 'EEE, MMM d')}`
  if (dayKey === tomorrowKey) return `Tomorrow · ${formatPT(sample, 'EEE, MMM d')}`

  // "This PT week" check: PT week starts Sunday
  const sundayKey = (() => {
    const d = new Date(ptNow)
    d.setDate(d.getDate() - d.getDay()) // back to Sunday
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const nextSundayKey = (() => {
    const d = new Date(ptNow)
    d.setDate(d.getDate() - d.getDay() + 7)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  if (dayKey >= sundayKey && dayKey < nextSundayKey) {
    return `${formatPT(sample, 'EEEE')} · ${formatPT(sample, 'MMM d')}`
  }
  return formatPT(sample, 'EEEE, MMMM d')
}

function groupByDay(shifts: ShiftRow[]): { dayKey: string; date: Date; items: ShiftRow[] }[] {
  const groups = new Map<string, { date: Date; items: ShiftRow[] }>()
  for (const s of shifts) {
    const d = new Date(s.startISO)
    const dayKey = ptDateKey(d)
    if (!groups.has(dayKey)) groups.set(dayKey, { date: d, items: [] })
    groups.get(dayKey)!.items.push(s)
  }
  return Array.from(groups.entries()).map(([dayKey, v]) => ({ dayKey, ...v }))
}

export function MyShiftsList({
  hostName,
  shifts,
  totals,
  periodKey,
  currentPeriodKey,
  sessions = [],
  hostGmv,
}: MyShiftsListProps) {
  // Distinct brands across the user's shifts — used to populate the filter.
  const brandOptions = useMemo(() => payFilterOptions(totals, shifts), [shifts, totals])

  // 'all' = no filter; otherwise the brandId we're scoping to.
  const [brandFilter, setBrandFilter] = useState<string>('all')
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list')

  const visibleShifts = useMemo(
    () => brandFilter === 'all' ? shifts : shifts.filter(s => s.brandId === brandFilter),
    [shifts, brandFilter],
  )

  const upcoming = visibleShifts.filter(s => !s.isPast).sort((a, b) => a.startISO.localeCompare(b.startISO))
  const past     = visibleShifts.filter(s => s.isPast).sort((a, b) => b.startISO.localeCompare(a.startISO))

  // All-time totals — every past shift the host has worked. Month-scoped
  // metrics now live in <HostEarningsBreakdown>, driven by the URL ?month=
  // searchParam. Prep pay counts as earned only once its SESSION has ended
  // (prepRealized), not when the anchor row alone is past.
  const scopedTotals = filterPayTotals(totals, brandFilter)
  const upcomingTotalCents = scopedTotals.reduce((sum, t) => sum + Number(t.upcoming_cents), 0)
  const allTimeEarnedCents = scopedTotals.reduce((sum, t) => sum + Number(t.earned_cents), 0)
  const allTimeShiftsCount = scopedTotals.reduce((sum, t) => sum + Number(t.completed_count), 0)
  const upcomingCount = scopedTotals.reduce((sum, t) => sum + Number(t.upcoming_count), 0)

  // Ended host sessions available for GMV entry (respect the brand filter).
  const gmvSessions = useMemo(() => {
    const scoped = brandFilter === 'all' ? sessions : sessions.filter(s => s.brandId === brandFilter)
    return scoped.filter(s => s.ended).sort((a, b) => b.startISO.localeCompare(a.startISO))
  }, [sessions, brandFilter])

  // Drives the wording only. Since migration 075 an ordinary host sees these
  // sessions read-only, so calling the section "Report session GMV" and telling
  // them to enter a figure they cannot enter would be actively confusing.
  const anyEditable = useMemo(() => gmvSessions.some(s => s.canEdit), [gmvSessions])

  // Export the visible (brand-filtered) shifts as a .ics file. Generated in
  // the browser from data already on the page — no route, no token, no new
  // exposure. This is a one-time snapshot, NOT a live subscription: a feed
  // would need a secret URL acting as a bearer credential for someone's whole
  // schedule, which was deliberately not built.
  function handleDownloadIcs() {
    const ics = buildIcs(
      visibleShifts.map(s => ({
        id: s.id,
        brandName: s.brandName,
        startISO: s.startISO,
        endISO: s.endISO,
        role: s.role,
        notes: s.notes,
      })),
      { calendarName: `${hostName} — Studio Shifts` },
    )
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = icsFilename(new Date().toISOString())
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground">My Shifts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            All shifts assigned to {hostName}.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* List vs Calendar. Hosts asked for a calendar of their own shifts;
              it shows ONLY their rows — never a coworker's (see
              MyShiftsCalendar). */}
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 transition-colors ${
                viewMode === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <ListIcon className="w-3.5 h-3.5" />
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode('calendar')}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 transition-colors ${
                viewMode === 'calendar'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              Calendar
            </button>
          </div>
          {visibleShifts.length > 0 && (
            <button
              type="button"
              onClick={handleDownloadIcs}
              title="Download your shifts as a calendar file you can open in Apple Calendar or Google Calendar"
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Add to calendar
            </button>
          )}
          {brandOptions.length > 1 && (
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-muted-foreground" />
              <select
                value={brandFilter}
                onChange={e => setBrandFilter(e.target.value)}
                className="text-xs bg-card border border-border rounded-md px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="all">All brands</option>
                {brandOptions.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Calendar view replaces the stats/lists entirely — it is its own way of
          reading the same (brand-filtered) shifts. */}
      {viewMode === 'calendar' && <MyShiftsCalendar shifts={visibleShifts} />}

      {viewMode === 'list' && (
      <>

      {/* All-time totals + upcoming snapshot. Pay-period numbers (realized,
          expected, hours, per-brand breakdown) live in <HostEarningsBreakdown>
          below, where they're driven by the ?period= URL param. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard
          label="All time earned"
          value={formatCents(allTimeEarnedCents)}
          sub={`Across ${allTimeShiftsCount} past ${allTimeShiftsCount === 1 ? 'shift' : 'shifts'}`}
          tone="primary"
        />
        <StatCard
          label="All time shifts worked"
          value={`${allTimeShiftsCount}`}
          sub="Completed shifts to date"
        />
        <StatCard
          label="Upcoming"
          value={`${upcomingCount}`}
          sub={`${formatCents(upcomingTotalCents)} total`}
        />
      </div>

      {/* GMV performance — hosts only, read-only, and deliberately just these
          three numbers: no pairing data, no comparisons, no trend (Section 5's
          "no extra data exposed"). Rendered only once there is something to
          show, so a host who has never had GMV reported sees no empty widget. */}
      {hostGmv && (hostGmv.allTimePerHourCents != null || hostGmv.goalPerHourCents != null) && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-3 pb-2 border-b border-border">
            Your GMV
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              label="All time GMV / hour"
              value={perHourLabel(hostGmv.allTimePerHourCents)}
              sub="Across every session with a reported figure"
              tone="primary"
            />
            <StatCard
              label="This month GMV / hour"
              value={perHourLabel(hostGmv.thisMonthPerHourCents)}
              sub={monthProgressSub(hostGmv)}
            />
            <StatCard
              label="Monthly goal / hour"
              value={perHourLabel(hostGmv.goalPerHourCents)}
              sub={hostGmv.goalPerHourCents == null ? 'No goal set' : 'Set by an admin'}
            />
          </div>
        </section>
      )}

      {/* Per-pay-period breakdown with prev/next picker. Operates on the same
          filtered shift list as the lists below (so brand filter applies). */}
      <HostEarningsBreakdown
        shifts={visibleShifts}
        periodKey={periodKey}
        currentPeriodKey={currentPeriodKey}
      />

      {/* Session GMV reporting — the caller's ended sessions this pay period,
          hosted or moderated (migration 074). */}
      {gmvSessions.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-1 pb-2 border-b border-border">
            {anyEditable ? 'Report session GMV' : 'Session GMV'}
          </h2>
          <p className="text-xs text-muted-foreground my-3">
            {anyEditable ? (
              <>
                Enter the GMV generated for each completed session — one value per session
                (back-to-back shifts count as one). A session has a single figure: if you
                hosted and moderated it with someone else, you are both editing the same
                number, and the most recent save is the one that counts.
              </>
            ) : (
              <>
                Revenue reported for your completed sessions. Your moderator enters these —
                if something looks wrong, tell an admin rather than the moderator, so the
                correction is recorded.
              </>
            )}
          </p>
          <div className="space-y-2">
            {gmvSessions.map(s => (
              <div
                key={s.anchorId}
                className="flex items-center justify-between gap-3 flex-wrap border border-border rounded-lg px-4 py-3 bg-card"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {s.brandName}
                    {s.viaModerator && (
                      <span className="ml-2 text-[11px] font-medium text-muted-foreground">
                        moderated
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatPT(s.startISO, 'EEE, MMM d')} · {formatPT(s.startISO, 'h:mm a')} – {formatPT(s.endISO, 'h:mm a')} · {s.hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hr
                  </p>
                </div>
                {s.canEdit ? (
                  <SessionGmvInput
                    anchorId={s.anchorId}
                    initialGmvCents={s.gmvCents}
                    lastSavedByName={s.lastSavedByName ?? null}
                    lastSavedAtISO={s.lastSavedAtISO ?? null}
                  />
                ) : (
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {s.gmvCents == null ? 'Not reported yet' : formatCents(s.gmvCents)}
                    </span>
                    {s.lastSavedByName && (
                      <span className="text-[11px] text-muted-foreground">
                        Reported by {s.lastSavedByName}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Upcoming */}
      <p className="text-sm text-muted-foreground">Showing the selected pay period and nearby shifts (up to 60 days ahead). Totals include all work. <a className="underline" href="/past-pay">Browse all past work and pay</a>.</p>
      <Section title="Upcoming" emptyText="No upcoming shifts. An admin will assign shifts to you here.">
        {upcoming.length === 0 ? null : (
          <div className="space-y-5">
            {groupByDay(upcoming).map(g => (
              <div key={g.dayKey}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {formatDayHeading(g.dayKey, g.date)}
                </h3>
                <div className="space-y-2">
                  {g.items.map(s => <ShiftCard key={s.id} shift={s} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Past */}
      {past.length > 0 && (
        <div className="mt-8">
          <Section title="Recent past" emptyText="">
            <div className="space-y-5">
              {groupByDay(past).slice(0, 30).map(g => (
                <div key={g.dayKey}>
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {formatDayHeading(g.dayKey, g.date)}
                  </h3>
                  <div className="space-y-2">
                    {g.items.map(s => <ShiftCard key={s.id} shift={s} past />)}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}
      </>
      )}
    </div>
  )
}

function Section({ title, children, emptyText }: { title: string; children: React.ReactNode; emptyText: string }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-3 pb-2 border-b border-border">
        {title}
      </h2>
      {children ?? (emptyText && (
        <p className="text-sm text-muted-foreground italic">{emptyText}</p>
      ))}
      {!children && !emptyText && null}
    </section>
  )
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'primary' }) {
  return (
    <div className="border border-border rounded-lg px-4 py-3 bg-card">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone === 'primary' ? 'text-primary' : 'text-foreground'}`}>{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
    </div>
  )
}

function ShiftCard({ shift, past }: { shift: ShiftRow; past?: boolean }) {
  const start = new Date(shift.startISO)
  const end   = new Date(shift.endISO)
  const isMod = shift.role === 'moderator'
  const hasPrep = shift.prepCents !== undefined
  // A prep block realizes on SESSION end, which can be later than this row's
  // own end (multi-row session). Until then the prep portion isn't earned, so
  // the card shows the shift total minus the pending prep — matching the
  // "All time earned" aggregate exactly instead of briefly overstating it.
  const prepPending = past && hasPrep && shift.prepRealized === false
  const displayCents = prepPending ? shift.totalCents - (shift.prepCents ?? 0) : shift.totalCents
  return (
    <Link
      href={`/calendar/${shift.brandId}`}
      className={`group block border border-border rounded-lg px-4 py-3 transition-colors ${
        past ? 'bg-card/40 hover:bg-card/60' : 'bg-card hover:bg-card/80'
      }`}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">{shift.brandName}</span>
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${
              isMod ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary'
            }`}
          >
            {isMod ? <Megaphone className="w-2.5 h-2.5" /> : null}
            {isMod ? 'Moderator' : 'Host'}
          </span>
          {past && (
            <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatPT(start, 'h:mm a')} – {formatPT(end, 'h:mm a')}
          </span>
          <span className="inline-flex items-center gap-1 text-primary font-medium">
            <DollarSign className="w-3 h-3" />
            {formatCents(displayCents)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
        <span className="inline-flex items-center gap-1">
          <Mic className="w-3 h-3" />
          {shift.producerName ? (
            <span className="text-foreground">{shift.producerName}</span>
          ) : (
            <span className="italic">Producer TBD</span>
          )}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span>{formatCents(shift.rateCents)}/hr</span>
        {shift.setupBonus && (
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
            +30m setup
          </span>
        )}
        {hasPrep && (
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600">
            +30m prep{prepPending ? ' (pending)' : ''}
          </span>
        )}
        {shift.notes && (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="inline-flex items-center gap-1">
              <FileText className="w-3 h-3" />
              <span className="truncate max-w-[20rem]">{shift.notes}</span>
            </span>
          </>
        )}
      </div>
    </Link>
  )
}

/** null means "no basis yet" and renders as a dash — never $0.00, which would
 *  read as "you generated nothing". Same rule as computeFillRate in fill.ts. */
function perHourLabel(cents: number | null): string {
  return cents == null ? '—' : `${formatCents(cents)}/hr`
}

/** Only compares to the goal when BOTH numbers exist. A host with no goal set
 *  must never read as "behind". */
function monthProgressSub(g: HostGmvCards): string {
  if (g.thisMonthPerHourCents == null) return 'Nothing reported yet this month'
  if (g.goalPerHourCents == null) return 'So far this month'
  const diff = g.thisMonthPerHourCents - g.goalPerHourCents
  if (diff === 0) return 'Exactly on goal'
  return diff > 0
    ? `${formatCents(diff)}/hr above goal`
    : `${formatCents(Math.abs(diff))}/hr below goal`
}
