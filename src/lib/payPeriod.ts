// The company's biweekly pay period calendar. Pure logic, no I/O — this is a
// money file (see CLAUDE.md rule 18): every change ships with vitest cases.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// People are PAID every two weeks but could only SEE their earnings by calendar
// month, so a worker's own page and their paycheck were describing different
// spans of time. That is a guaranteed source of "this number is wrong" messages
// that are not actually wrong.
//
// Underneath the display problem sat a real one: there was no pay period in the
// system at all. The admin export's "Past 2 weeks" meant "the 14 days ending
// yesterday", measured from whatever day the button happened to be clicked. Two
// consequences:
//
//   * Nothing could TELL a worker when their period starts, because nothing
//     defined it.
//   * Exporting 16 days after the previous export left two days inside no
//     window at all. Not late — never paid by any run, because the next window
//     also starts 14 days back from ITS click date.
//
// This module pins the calendar instead: one anchor date, and every period
// counted off it in exact 14-day steps, forwards and backwards, forever. The
// worker's page and the payroll CSV both read from here, so they cannot drift.
//
// ---------------------------------------------------------------------------
// THE ANCHOR
// ---------------------------------------------------------------------------
//
// Confirmed by Alex on 2026-08-31: the period being worked right now is
// Mon Aug 24 2026 through Sun Sep 6 2026 inclusive. Periods therefore run
// Monday -> Sunday, two weeks, and every other period boundary lands on a
// Monday counted off 2026-08-24.
//
// CHANGING THIS CONSTANT RE-DATES EVERY PERIOD IN THE APP, past and future,
// on both the worker-facing pages and the payroll CSV. It is not a display
// preference. If the company ever shifts its pay calendar, that is a migration
// with a cutover date, not an edit to this line.
//
// ---------------------------------------------------------------------------
// TIME SCHEME
// ---------------------------------------------------------------------------
//
// PT-naive, like everything else here: PT wall-clock encoded in UTC fields
// (src/lib/utils.ts). All arithmetic below is whole-calendar-day arithmetic in
// UTC, which is DST-immune by construction — a UTC day is always exactly
// 86,400,000 ms, so the 14-day step never gains or loses the hour that PT does
// in March and November. A period spanning a DST transition is still exactly
// 14 days, and its boundaries still land on PT midnight. Covered by tests.

/** Days in one pay period. Two weeks. */
export const PAY_PERIOD_DAYS = 14

/**
 * Start of a real, known pay period, as a PT calendar date. Every other period
 * boundary is this date ± a multiple of PAY_PERIOD_DAYS. See the warning above
 * before touching it.
 */
export const PAY_PERIOD_ANCHOR_KEY = '2026-08-24'

const DAY_MS = 86_400_000
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/** A resolved pay period. Bounds are PT wall-clock encoded as UTC ISO. */
export interface PayPeriod {
  /** PT calendar date the period starts, YYYY-MM-DD. Also its stable id. */
  startKey: string
  /** PT calendar date the period ends, INCLUSIVE, YYYY-MM-DD. */
  endKey: string
  /** Inclusive start, start-of-day, ISO. */
  fromISO: string
  /** EXCLUSIVE end — midnight of the day AFTER endKey, ISO. */
  toExclusiveISO: string
}

function ymdToUtcMs(key: string): number {
  const m = YMD.exec(key)
  if (!m) return NaN
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // Rejects impossible dates that still match the shape, e.g. 2026-02-31,
  // which Date.UTC would silently roll forward into March.
  return ymdFromUtcMs(ms) === key ? ms : NaN
}

function ymdFromUtcMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

const ANCHOR_MS = ymdToUtcMs(PAY_PERIOD_ANCHOR_KEY)

/**
 * The PT calendar date of a PT-naive instant. `d` MUST be a Date whose UTC
 * fields encode PT wall-clock — i.e. nowPtAsUtc(), or a value parsed from a
 * `start_time` / `end_time` column.
 */
export function ptDayKey(d: Date): string {
  return ymdFromUtcMs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * The start date of the pay period containing `dayKey`.
 *
 * Math.floor, not truncation: dates BEFORE the anchor give a negative day
 * count, and truncating toward zero there would fold the two periods either
 * side of the anchor into one. Every worker's history predates the anchor, so
 * this path is the common one, not an edge case.
 */
export function payPeriodStartKeyForDay(dayKey: string): string {
  const ms = ymdToUtcMs(dayKey)
  if (Number.isNaN(ms)) return payPeriodStartKeyForDay(PAY_PERIOD_ANCHOR_KEY)
  const daysFromAnchor = Math.floor((ms - ANCHOR_MS) / DAY_MS)
  const index = Math.floor(daysFromAnchor / PAY_PERIOD_DAYS)
  return ymdFromUtcMs(ANCHOR_MS + index * PAY_PERIOD_DAYS * DAY_MS)
}

/** The pay period containing `ptNow` (must be nowPtAsUtc()-shaped). */
export function currentPayPeriodStartKey(ptNow: Date): string {
  return payPeriodStartKeyForDay(ptDayKey(ptNow))
}

/** Step `delta` whole periods from `startKey`. Negative goes back. */
export function shiftPayPeriodKey(startKey: string, delta: number): string {
  const ms = ymdToUtcMs(startKey)
  if (Number.isNaN(ms)) return startKey
  return ymdFromUtcMs(ms + delta * PAY_PERIOD_DAYS * DAY_MS)
}

/** Expand a period start date into its full bounds. */
export function resolvePayPeriod(startKey: string): PayPeriod {
  const startMs = ymdToUtcMs(startKey)
  const endMs = startMs + (PAY_PERIOD_DAYS - 1) * DAY_MS
  const toExclusiveMs = startMs + PAY_PERIOD_DAYS * DAY_MS
  return {
    startKey,
    endKey: ymdFromUtcMs(endMs),
    fromISO: new Date(startMs).toISOString(),
    toExclusiveISO: new Date(toExclusiveMs).toISOString(),
  }
}

/**
 * Turn an untrusted `?period=` URL value into a real period start.
 *
 * Forgiving on purpose. A missing or malformed value falls back to the current
 * period rather than throwing or rendering an empty page, and a valid date that
 * ISN'T a period boundary snaps to the start of the period containing it — so a
 * hand-typed or stale deep-link still lands somewhere truthful instead of
 * inventing a 14-day window that the payroll run will never use.
 */
export function normalizePayPeriodKey(raw: string | undefined, ptNow: Date): string {
  if (!raw || Number.isNaN(ymdToUtcMs(raw))) return currentPayPeriodStartKey(ptNow)
  return payPeriodStartKeyForDay(raw)
}

/**
 * The pay period a shift belongs to, keyed off when it ENDS.
 *
 * End, not start, because that is what payroll does everywhere else — the CSV,
 * both admin payroll pages and the per-host page all bucket a shift into the
 * period it FINISHES in. Bucketing a worker's own page by start is exactly the
 * defect fixed on 2026-08-29: a shift running 23:00 -> 01:00 showed in one
 * period on their page and was paid in the next.
 *
 * Slices the ISO string rather than parsing it. Stored times are PT-naive, so
 * the leading YYYY-MM-DD IS the PT calendar date; going through
 * `new Date(iso).getDate()` would re-read the instant in the browser's local
 * timezone and misfile every shift near midnight for anyone west of UTC.
 */
export function payPeriodStartKeyForShift(endISO: string): string {
  return payPeriodStartKeyForDay(endISO.slice(0, 10))
}

const MONTH_DAY = { month: 'short', day: 'numeric', timeZone: 'UTC' } as const

/**
 * Human label for a period, e.g. "Aug 24 – Sep 6, 2026". The year is printed
 * once at the end, or on both halves when the period straddles New Year.
 */
export function formatPayPeriodLabel(period: PayPeriod): string {
  const start = new Date(ymdToUtcMs(period.startKey))
  const end = new Date(ymdToUtcMs(period.endKey))
  const startY = start.getUTCFullYear()
  const endY = end.getUTCFullYear()
  const s = start.toLocaleDateString('en-US', MONTH_DAY)
  const e = end.toLocaleDateString('en-US', MONTH_DAY)
  return startY === endY ? `${s} – ${e}, ${endY}` : `${s}, ${startY} – ${e}, ${endY}`
}
