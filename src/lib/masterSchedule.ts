// Pure logic for the admin "master schedule" view (all brands at once). No I/O —
// the page/route does the Supabase query and feeds joined rows in here. Kept
// pure so it is unit-testable (see masterSchedule.test.ts) and so the
// date-range and brand-color math stays in one place.
//
// Follows the app's PT-naive convention: a stream's stored UTC fields ARE its
// PT wall-clock. Range bounds are built with Date.UTC(...) and read back with
// getUTC* — never applying a timezone offset.

import { BRAND_COLORS, getBrandColor } from '@/lib/utils'
import type { StreamWithRelations } from '@/lib/supabase/types'

const YMD = /^\d{4}-\d{2}-\d{2}$/

export type ScheduleView = 'day' | 'week'

export interface ScheduleRange {
  fromISO: string // inclusive start, PT-naive UTC ISO (e.g. '2026-06-15T00:00:00.000Z')
  toExclusiveISO: string // exclusive end
  fromKey: string // 'YYYY-MM-DD'
  toKey: string // inclusive last day 'YYYY-MM-DD'
}

function ymdFromUtcMs(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Resolve the visible window for the master schedule.
 *   day  → that single calendar day.
 *   week → the Mon–Sun week CONTAINING dateKey (normalized to the Monday
 *          on-or-before dateKey).
 * `dateKey` is 'YYYY-MM-DD'. Throws RangeError on malformed input.
 */
export function resolveScheduleRange(view: ScheduleView, dateKey: string): ScheduleRange {
  if (!YMD.test(dateKey)) throw new RangeError('dateKey must be YYYY-MM-DD')
  const [y, m, d] = dateKey.split('-').map(Number)

  let fromMs: number
  let span: number // days in the window
  if (view === 'week') {
    // UTC getUTCDay(): 0=Sun..6=Sat. Days back to the Monday on-or-before.
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    const backToMonday = dow === 0 ? 6 : dow - 1
    fromMs = Date.UTC(y, m - 1, d - backToMonday)
    span = 7
  } else {
    fromMs = Date.UTC(y, m - 1, d)
    span = 1
  }
  const toExclusiveMs = fromMs + span * 86_400_000
  return {
    fromISO: new Date(fromMs).toISOString(),
    toExclusiveISO: new Date(toExclusiveMs).toISOString(),
    fromKey: ymdFromUtcMs(fromMs),
    toKey: ymdFromUtcMs(toExclusiveMs - 86_400_000), // inclusive last day
  }
}

/**
 * Shift the anchor date.
 *   day  → by `delta` days.
 *   week → by `delta` weeks (7*delta days). The resolver re-normalizes to
 *          Monday, so shifting the given dateKey by 7*delta days is fine.
 * Returns a new 'YYYY-MM-DD'. Throws RangeError on malformed input.
 */
export function shiftScheduleDate(view: ScheduleView, dateKey: string, delta: number): string {
  if (!YMD.test(dateKey)) throw new RangeError('dateKey must be YYYY-MM-DD')
  const [y, m, d] = dateKey.split('-').map(Number)
  const stepDays = view === 'week' ? 7 * delta : delta
  return ymdFromUtcMs(Date.UTC(y, m - 1, d + stepDays))
}

/**
 * Union of every brand's day window: min day_start_minutes and max
 * day_end_minutes. An empty array means "show the full day" (never clip).
 */
export function unionDayWindow(
  brands: { day_start_minutes: number; day_end_minutes: number }[],
): { startMinutes: number; endMinutes: number } {
  if (brands.length === 0) return { startMinutes: 0, endMinutes: 1440 }
  let startMinutes = Infinity
  let endMinutes = -Infinity
  for (const b of brands) {
    if (b.day_start_minutes < startMinutes) startMinutes = b.day_start_minutes
    if (b.day_end_minutes > endMinutes) endMinutes = b.day_end_minutes
  }
  return { startMinutes, endMinutes }
}

export interface BrandColor {
  bg: string
  border: string
  text: string
}

/**
 * Assign each brand id a DISTINCT palette color by its index in the given order
 * (cycling BRAND_COLORS). Guarantees the first BRAND_COLORS.length brands get
 * different hues — unlike the hash in getBrandColor, which can collide adjacent
 * hues. `brandIds` should be the full brand list in a stable order (e.g. sorted
 * by name) so a brand keeps its color across renders. If the same id appears
 * twice the first occurrence wins.
 */
export function buildBrandColorMap(brandIds: string[]): Map<string, BrandColor> {
  const map = new Map<string, BrandColor>()
  brandIds.forEach((id, i) => {
    if (!map.has(id)) map.set(id, BRAND_COLORS[i % BRAND_COLORS.length])
  })
  return map
}

export interface MasterEvent {
  id: string
  start: string // ISO (PT-naive UTC) — stream.start_time passed through unchanged
  end: string
  brandId: string
  brandName: string
  hostName: string | null
  bg: string
  border: string
  text: string
}

/**
 * Map joined streams → brand-colored events. Colors come from `colorMap` when
 * provided (see buildBrandColorMap for distinct hues), falling back to
 * getBrandColor(brand_id) so the same brand always renders the same color.
 * Preserves input order (caller pre-sorts by start_time).
 */
export function buildMasterEvents(
  streams: StreamWithRelations[],
  colorMap?: Map<string, BrandColor>,
): MasterEvent[] {
  return streams.map(s => {
    const { bg, border, text } = colorMap?.get(s.brand_id) ?? getBrandColor(s.brand_id)
    return {
      id: s.id,
      start: s.start_time,
      end: s.end_time,
      brandId: s.brand_id,
      brandName: s.brand.name,
      hostName: s.host?.name ?? null,
      bg,
      border,
      text,
    }
  })
}

export interface OverlapBand {
  start: string // ISO (PT-naive UTC)
  end: string // ISO
  count: number // number of concurrent lives in this band; always >= 2
}

/**
 * Sweep-line over events to find every maximal time range where 2+ events run
 * CONCURRENTLY, each tagged with the concurrency count. The count is constant
 * within a band: when concurrency changes (2 live -> 3 live -> 2 live) the
 * output splits into separate bands. Adjacent ranges with the SAME count are
 * merged. Events with end <= start are ignored. "Touching" is NOT overlap
 * (a.end === b.start does not count). Operates on absolute time, so it works
 * across a whole week. Returns bands sorted by start ascending.
 */
export function computeOverlapBands(events: { start: string; end: string }[]): OverlapBand[] {
  // 1. Parse to ms; drop zero/negative-length and unparseable events.
  const spans: { s: number; e: number }[] = []
  for (const ev of events) {
    const s = new Date(ev.start).getTime()
    const e = new Date(ev.end).getTime()
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue
    spans.push({ s, e })
  }

  // 2. Unique, sorted boundary timestamps.
  const boundarySet = new Set<number>()
  for (const sp of spans) {
    boundarySet.add(sp.s)
    boundarySet.add(sp.e)
  }
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)

  // 3. For each consecutive [t0, t1) sub-interval, count covering events.
  const segments: { start: number; end: number; count: number }[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const t0 = boundaries[i]
    const t1 = boundaries[i + 1]
    if (t1 <= t0) continue
    let count = 0
    for (const sp of spans) {
      if (sp.s <= t0 && sp.e >= t1) count++
    }
    if (count >= 2) segments.push({ start: t0, end: t1, count })
  }

  // 4. Merge consecutive same-count segments that abut.
  const merged: { start: number; end: number; count: number }[] = []
  for (const seg of segments) {
    const prev = merged[merged.length - 1]
    if (prev && prev.end === seg.start && prev.count === seg.count) {
      prev.end = seg.end
    } else {
      merged.push({ ...seg })
    }
  }

  // 5. Back to ISO. Already sorted by start ascending (boundaries were sorted).
  return merged.map(seg => ({
    start: new Date(seg.start).toISOString(),
    end: new Date(seg.end).toISOString(),
    count: seg.count,
  }))
}

/**
 * Set of event ids that time-overlap at least one OTHER event in the list.
 * Strict overlap: two ranges [s1,e1),[s2,e2) overlap iff `s1 < e2 && s2 < e1`,
 * so touching (a.end === b.start) does NOT count. Events with end <= start are
 * ignored. O(n^2) pairwise scan — fine for a single day/week of events.
 */
export function markOverlappingEventIds(
  events: { id: string; start: string; end: string }[],
): Set<string> {
  const spans = events
    .map(ev => ({ id: ev.id, s: new Date(ev.start).getTime(), e: new Date(ev.end).getTime() }))
    .filter(sp => !Number.isNaN(sp.s) && !Number.isNaN(sp.e) && sp.e > sp.s)

  const overlapping = new Set<string>()
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]
      const b = spans[j]
      if (a.s < b.e && b.s < a.e) {
        overlapping.add(a.id)
        overlapping.add(b.id)
      }
    }
  }
  return overlapping
}

/**
 * Every event whose time range intersects `target`'s range, INCLUDING target
 * itself, sorted by start ascending then brandName ascending. Strict overlap
 * (touching excluded). Use to populate the "who's live right now" detail.
 */
export function concurrentEvents(events: MasterEvent[], target: MasterEvent): MasterEvent[] {
  const ts = new Date(target.start).getTime()
  const te = new Date(target.end).getTime()

  return events
    .filter(ev => {
      const s = new Date(ev.start).getTime()
      const e = new Date(ev.end).getTime()
      if (Number.isNaN(s) || Number.isNaN(e)) return false
      // Strict overlap; target overlaps itself (ts < te && ts < te → always in).
      return s < te && ts < e
    })
    .sort((a, b) => {
      const byStart = new Date(a.start).getTime() - new Date(b.start).getTime()
      return byStart !== 0 ? byStart : a.brandName.localeCompare(b.brandName)
    })
}

/**
 * For every event, the MAX number of lives simultaneously active at any instant
 * WITHIN that event's own span (counting itself). A solo event → 1. This is the
 * number to badge a tile with: a long live overlapping two shifts that never
 * coincide reads 2, not 3 — unlike a naive "how many do I touch" count. Strict
 * overlap; touching excluded; events with end <= start are ignored (absent from
 * the map). Sweep-line: O(boundaries × events).
 */
export function maxConcurrentByEventId(
  events: { id: string; start: string; end: string }[],
): Map<string, number> {
  const spans = events
    .map(ev => ({ id: ev.id, s: new Date(ev.start).getTime(), e: new Date(ev.end).getTime() }))
    .filter(sp => !Number.isNaN(sp.s) && !Number.isNaN(sp.e) && sp.e > sp.s)

  const boundarySet = new Set<number>()
  for (const sp of spans) {
    boundarySet.add(sp.s)
    boundarySet.add(sp.e)
  }
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)

  // Per minimal sub-interval [t0,t1): how many spans cover it.
  const sub: { t0: number; t1: number; count: number }[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const t0 = boundaries[i]
    const t1 = boundaries[i + 1]
    if (t1 <= t0) continue
    let count = 0
    for (const sp of spans) {
      if (sp.s <= t0 && sp.e >= t1) count++
    }
    sub.push({ t0, t1, count })
  }

  // Each event's badge count = the busiest instant inside its own span.
  const result = new Map<string, number>()
  for (const sp of spans) {
    let max = 1
    for (const iv of sub) {
      if (iv.t0 >= sp.s && iv.t1 <= sp.e && iv.count > max) max = iv.count
    }
    result.set(sp.id, max)
  }
  return result
}
