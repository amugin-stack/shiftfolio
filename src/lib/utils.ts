import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ============================================================
// "Pacific Time" via UTC-naive timestamps
// ============================================================
// Stream timestamps are stored naively — the UTC hour/minute IS the PT
// wall-clock. We never apply a timezone offset, so the same row reads as
// the same wall-clock for every viewer. Operationally this is "UTC" for
// the calendar's purposes; the "PT" label is conventional.
export const APP_TIMEZONE = 'UTC'

/** Format a stream timestamp using its UTC fields, displayed as the PT
 *  wall-clock time. */
export function formatPT(date: Date | string, fmt: string): string {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, APP_TIMEZONE, fmt)
}

/** Identity in this scheme: "PT wall-clock" already lives in the UTC fields. */
export function ptWallClockToUtc(localDate: Date): Date {
  return fromZonedTime(localDate, APP_TIMEZONE)
}

/** Identity in this scheme: extracting "PT" fields IS getting UTC fields. */
export function utcToPt(date: Date | string): Date {
  return toZonedTime(typeof date === 'string' ? new Date(date) : date, APP_TIMEZONE)
}

/** Parse `YYYY-MM` into a PT-naive month start; fall back to current PT month
 *  on missing or malformed input. Returned `key` is canonical `YYYY-MM`. */
export function parseMonth(input: string | undefined): { year: number; month: number; key: string } {
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const [y, m] = input.split('-').map(Number)
    if (m >= 1 && m <= 12) return { year: y, month: m - 1, key: input }
  }
  const now = nowPtAsUtc()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return { year: y, month: m, key: `${y}-${String(m + 1).padStart(2, '0')}` }
}

/** Cached formatter for nowPtAsUtc.
 *
 *  Constructing an Intl.DateTimeFormat is expensive, and nowPtAsUtc used to
 *  build a fresh one on every call. The calendar calls it once per event AND
 *  once per background grid cell, so a single repaint of a week view was
 *  building ~340 formatters. That was the single largest cost of clicking
 *  anything on the calendar.
 *
 *  Hoisting it is behaviour-identical: a DateTimeFormat instance is immutable
 *  and stateless with respect to the date handed to formatToParts — its
 *  locale/timeZone slots are fixed at construction and never mutated, so
 *  formatToParts(d) is a pure function of (construction options, d). DST is
 *  unaffected for the same reason: the Los Angeles offset is resolved per
 *  FORMATTED date, not at construction, so a formatter built in July still
 *  returns PST fields for a January date.
 *
 *  Note `new Date()` deliberately stays INSIDE the function below — only the
 *  formatter is cached, so "now" still advances in real time. */
const PT_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

/** "Now" expressed in our naive scheme: take the real PT wall-clock and
 *  encode its components as UTC fields. Use this anywhere you need to
 *  compare a stored stream timestamp against the current moment. */
export function nowPtAsUtc(): Date {
  const real = new Date()
  const parts = PT_PARTS_FORMATTER.formatToParts(real)
  const part = (t: string) => Number(parts.find(p => p.type === t)!.value)
  return new Date(Date.UTC(
    part('year'), part('month') - 1, part('day'),
    part('hour') === 24 ? 0 : part('hour'),
    part('minute'), part('second')
  ))
}

/** True when `candidateStart` falls on a PT calendar day strictly before
 *  today's PT day. `candidateStart` must be a stream timestamp in the
 *  PT-naive scheme (its UTC fields are the PT wall-clock — i.e. the output of
 *  `ptWallClockToUtc`). "Today" counts as current, so same-day slots return
 *  false even if their wall-clock time has already passed. Used to skip
 *  already-elapsed days when bulk-booking a weekday across the month. */
export function isPastPtDay(candidateStart: Date, now: Date = nowPtAsUtc()): boolean {
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return candidateStart.getTime() < todayStartMs
}

export const BRAND_COLORS = [
  { bg: '#3B82F6', border: '#2563EB', text: '#ffffff' }, // blue
  { bg: '#8B5CF6', border: '#7C3AED', text: '#ffffff' }, // violet
  { bg: '#10B981', border: '#059669', text: '#ffffff' }, // emerald
  { bg: '#F59E0B', border: '#D97706', text: '#ffffff' }, // amber
  { bg: '#EC4899', border: '#DB2777', text: '#ffffff' }, // pink
  { bg: '#06B6D4', border: '#0891B2', text: '#ffffff' }, // cyan
  { bg: '#84CC16', border: '#65A30D', text: '#ffffff' }, // lime
  { bg: '#F97316', border: '#EA580C', text: '#ffffff' }, // orange
]

export function getBrandColor(brandId: string) {
  // Simple hash so the same brand always gets the same color
  let hash = 0
  for (let i = 0; i < brandId.length; i++) {
    hash = (hash * 31 + brandId.charCodeAt(i)) >>> 0
  }
  return BRAND_COLORS[hash % BRAND_COLORS.length]
}

// Convert minutes-since-midnight (0..1440) into "HH:MM:SS" used by FullCalendar
export function minutesToTimeString(mins: number): string {
  const safe = Math.max(0, Math.min(1440, mins))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

// Inverse: "HH:MM" -> minutes since midnight
export function timeStringToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

// "HH:MM" string for <input type="time"> (no seconds, capped at 23:59)
export function minutesToInputTime(mins: number): string {
  const safe = Math.max(0, Math.min(1439, mins === 1440 ? 1439 : mins))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Cell key for the calendar's Group Selection set — (weekday, block index)
export function rateKey(dayOfWeek: number, blockIndex: number): string {
  return `${dayOfWeek}-${blockIndex}`
}

// Format integer cents as USD, e.g. 2000 -> "$20.00", 4500 -> "$45.00"
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

// Format minutes as a friendly label, e.g. 720 -> "12:00 PM"
export function minutesToLabel(mins: number): string {
  if (mins >= 1440) return '12:00 AM'
  const h24 = Math.floor(mins / 60)
  const m = mins % 60
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

/**
 * Turn a user-picked hex color into a master-schedule color triple.
 * Accepts '#rrggbb', 'rrggbb', '#rgb', or 'rgb' (case-insensitive). Invalid
 * input falls back to a neutral grey triple. `border` is the bg darkened ~15%;
 * `text` is '#000000' or '#ffffff' chosen by relative luminance so labels stay
 * legible on any background.
 */
export function colorFromHex(hex: string): { bg: string; border: string; text: string } {
  // Normalize: strip leading '#', lowercase, expand 3-char shorthand.
  let normalized = String(hex).trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(normalized)) {
    normalized = normalized
      .split('')
      .map((c) => c + c)
      .join('')
  }
  // Validate exactly 6 hex chars; otherwise fall back to neutral grey.
  if (!/^[0-9a-f]{6}$/.test(normalized)) {
    normalized = '6b7280'
  }

  const r = parseInt(normalized.slice(0, 2), 16)
  const g = parseInt(normalized.slice(2, 4), 16)
  const b = parseInt(normalized.slice(4, 6), 16)

  const bg = `#${normalized}`

  // Border: each channel darkened to 85%, rounded, clamped, two-digit hex.
  const darken = (channel: number) => {
    const v = Math.max(0, Math.min(255, Math.round(channel * 0.85)))
    return v.toString(16).padStart(2, '0')
  }
  const border = `#${darken(r)}${darken(g)}${darken(b)}`

  // Relative luminance picks a legible text color against the background.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const text = luminance > 0.6 ? '#000000' : '#ffffff'

  return { bg, border, text }
}
