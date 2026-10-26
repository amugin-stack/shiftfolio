// Decides when the brand calendar must fetch a new date window from the server.
//
// The page loads a bounded window of shifts (see windowedStreams.ts). Fetching
// only the visible week meant every later week click fell outside the loaded
// data and showed the blocking "Loading schedule…" overlay again. Instead we
// fetch the visible range padded on both sides, and refresh in the background
// two weeks before the user reaches the edge (production renders take ~2-3s,
// and one week of runway was outrun at a brisk click pace). Plain
// UTC-millisecond math: stream times are PT wall-clock encoded as UTC, so no
// DST adjustment applies here.

const DAY_MS = 86_400_000
export const WINDOW_PAD_DAYS = 21
export const PREFETCH_EDGE_DAYS = 14
// Mirrors calendarRange() and get_stream_window_ids (migration 087).
const MAX_WINDOW_MS = 100 * DAY_MS

export type CalendarWindowPlan = { kind: 'blocking' | 'prefetch'; from: string; to: string } | null

export function planCalendarWindow(
  activeStart: Date,
  activeEnd: Date,
  loadedFrom: string | undefined,
  loadedTo: string | undefined,
): CalendarWindowPlan {
  if (!loadedFrom || !loadedTo) return null
  const start = activeStart.getTime()
  const end = activeEnd.getTime()
  const lf = Date.parse(loadedFrom)
  const lt = Date.parse(loadedTo)
  if (![start, end, lf, lt].every(Number.isFinite) || end <= start) return null

  let kind: 'blocking' | 'prefetch'
  if (start < lf || end > lt) kind = 'blocking'
  else if (start - lf < PREFETCH_EDGE_DAYS * DAY_MS || lt - end < PREFETCH_EDGE_DAYS * DAY_MS) kind = 'prefetch'
  else return null

  const pad = Math.max(0, Math.min(WINDOW_PAD_DAYS * DAY_MS, Math.floor((MAX_WINDOW_MS - (end - start)) / 2)))
  const from = new Date(start - pad).toISOString()
  const to = new Date(end + pad).toISOString()
  // Already the loaded window (e.g. near the edge of all time): navigating to
  // the same URL would never re-render, leaving the overlay stuck.
  if (Date.parse(from) === lf && Date.parse(to) === lt) return null
  return { kind, from, to }
}
