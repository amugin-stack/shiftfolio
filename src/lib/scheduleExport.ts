// Pure logic for the admin "schedule by brand" CSV export. No I/O — the route
// handler (src/app/(dashboard)/admin/dashboard/schedule-export/route.ts) does
// the Supabase query and feeds normalized rows in here. Kept pure so it is
// unit-testable (see scheduleExport.test.ts) and so the date/time formatting
// stays in one place.
//
// Unlike the payroll export, this emits ONE ROW PER BOOKED SHIFT and includes
// every shift in the range — past and future (no completion gate).

import { formatPT } from '@/lib/utils'
import { csvEscape, resolveCustomRange, type DateRange } from '@/lib/payrollExport'

// Re-export so the route can import range helpers from a single module.
export { resolveCustomRange, type DateRange }

const YM = /^\d{4}-\d{2}$/
const YMD = /^\d{4}-\d{2}-\d{2}$/

function ymdFromUtcMs(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Whole PT month from a `YYYY-MM` key. Bounds are PT-wall-clock encoded as
 *  UTC ISO (the app's PT-naive scheme). */
export function resolveMonthRange(monthKey: string): DateRange {
  if (!YM.test(monthKey)) throw new RangeError('month must be YYYY-MM')
  const [y, m] = monthKey.split('-').map(Number)
  if (m < 1 || m > 12) throw new RangeError('month out of range')
  const fromMs = Date.UTC(y, m - 1, 1)
  const toExclusiveMs = Date.UTC(y, m, 1)
  return {
    fromISO: new Date(fromMs).toISOString(),
    toExclusiveISO: new Date(toExclusiveMs).toISOString(),
    fromKey: ymdFromUtcMs(fromMs),
    toKey: ymdFromUtcMs(toExclusiveMs - 86_400_000), // inclusive last day
  }
}

/** A single Mon–Sun week from its start date (`YYYY-MM-DD`). Any calendar date
 *  is accepted as the start; the UI always passes a Monday. */
export function resolveWeekRange(startKey: string): DateRange {
  if (!YMD.test(startKey)) throw new RangeError('week start must be YYYY-MM-DD')
  const [y, m, d] = startKey.split('-').map(Number)
  const fromMs = Date.UTC(y, m - 1, d)
  const toExclusiveMs = Date.UTC(y, m - 1, d + 7)
  return {
    fromISO: new Date(fromMs).toISOString(),
    toExclusiveISO: new Date(toExclusiveMs).toISOString(),
    fromKey: ymdFromUtcMs(fromMs),
    toKey: ymdFromUtcMs(toExclusiveMs - 86_400_000), // inclusive last day (Sun)
  }
}

/** Normalized booked shift (the route flattens the Supabase join arrays). */
export interface ScheduleStreamInput {
  start_time: string
  end_time: string
  host: { name: string } | null
  moderator: { name: string } | null
}

export interface ScheduleRow {
  dateKey: string // 'YYYY-MM-DD' (PT)
  weekday: string // 'Wednesday'
  start: string // '12:00 PM'
  end: string // '2:00 PM'
  durationHours: string // '2.00'
  host: string // '' when unassigned
  moderator: string
}

/** One display-ready row per shift, sorted chronologically by start time. */
export function buildScheduleRows(streams: ScheduleStreamInput[]): ScheduleRow[] {
  return [...streams]
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    .map(s => {
      const durationHours = (
        (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 3_600_000
      ).toFixed(2)
      return {
        dateKey: formatPT(s.start_time, 'yyyy-MM-dd'),
        weekday: formatPT(s.start_time, 'EEEE'),
        start: formatPT(s.start_time, 'h:mm a'),
        end: formatPT(s.end_time, 'h:mm a'),
        durationHours,
        host: s.host?.name ?? '',
        moderator: s.moderator?.name ?? '',
      }
    })
}

const CSV_HEADER = 'Date,Weekday,Start,End,Duration (hrs),Host,Moderator'

/** Serialize rows to a CSV string (no trailing newline). Header always present. */
export function scheduleRowsToCsv(rows: ScheduleRow[]): string {
  const lines = rows.map(r =>
    [
      r.dateKey,
      r.weekday,
      r.start,
      r.end,
      r.durationHours,
      csvEscape(r.host),
      csvEscape(r.moderator),
    ].join(','),
  )
  return [CSV_HEADER, ...lines].join('\n')
}
