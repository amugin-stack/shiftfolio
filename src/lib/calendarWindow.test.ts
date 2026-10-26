import { expect, it } from 'vitest'
import { planCalendarWindow, PREFETCH_EDGE_DAYS, WINDOW_PAD_DAYS } from './calendarWindow'

const DAY = 86_400_000
const d = (iso: string) => new Date(iso)
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY
// Default page window for Sep 2026: Aug 25 → Oct 8.
const LF = '2026-08-25T00:00:00.000Z'
const LT = '2026-10-08T00:00:00.000Z'

it('does nothing for a week comfortably inside the loaded window', () => {
  expect(planCalendarWindow(d('2026-09-13T00:00:00Z'), d('2026-09-20T00:00:00Z'), LF, LT)).toBeNull()
})

it('does nothing without a loaded range', () => {
  expect(planCalendarWindow(d('2026-09-13T00:00:00Z'), d('2026-09-20T00:00:00Z'), undefined, undefined)).toBeNull()
})

it('prefetches in the background when the visible week nears either edge', () => {
  const late = planCalendarWindow(d('2026-09-27T00:00:00Z'), d('2026-10-04T00:00:00Z'), LF, LT)
  expect(late?.kind).toBe('prefetch')
  expect(late).toEqual({ kind: 'prefetch', from: '2026-09-06T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' })
  const early = planCalendarWindow(d('2026-08-30T00:00:00Z'), d('2026-09-06T00:00:00Z'), LF, LT)
  expect(early?.kind).toBe('prefetch')
})

it('blocks only when the visible week is outside the loaded data, and pads the new window', () => {
  const plan = planCalendarWindow(d('2026-10-04T00:00:00Z'), d('2026-10-11T00:00:00Z'), LF, LT)
  expect(plan?.kind).toBe('blocking')
  expect(days(plan!.from, '2026-10-04T00:00:00Z')).toBe(WINDOW_PAD_DAYS)
  expect(days('2026-10-11T00:00:00Z', plan!.to)).toBe(WINDOW_PAD_DAYS)
})

it('after a padded load, the next two week clicks in either direction need no overlay', () => {
  const plan = planCalendarWindow(d('2026-10-04T00:00:00Z'), d('2026-10-11T00:00:00Z'), LF, LT)!
  for (const step of [-2, -1, 1, 2]) {
    const s = new Date(Date.parse('2026-10-04T00:00:00Z') + step * 7 * DAY)
    const e = new Date(s.getTime() + 7 * DAY)
    expect(planCalendarWindow(s, e, plan.from, plan.to)?.kind).not.toBe('blocking')
  }
  // Weeks well inside the fresh window trigger nothing at all.
  expect(planCalendarWindow(d('2026-10-04T00:00:00Z'), d('2026-10-11T00:00:00Z'), plan.from, plan.to)).toBeNull()
  expect(PREFETCH_EDGE_DAYS).toBeLessThan(WINDOW_PAD_DAYS)
})

it('keeps a month view (42 days) within the 100-day server cap', () => {
  const plan = planCalendarWindow(d('2026-12-27T00:00:00Z'), d('2027-02-07T00:00:00Z'), LF, LT)!
  expect(plan.kind).toBe('blocking')
  expect(days(plan.from, plan.to)).toBeLessThanOrEqual(100)
})

it('shrinks padding for an oversized view instead of exceeding the cap', () => {
  const plan = planCalendarWindow(d('2027-01-01T00:00:00Z'), d('2027-03-31T00:00:00Z'), LF, LT)!
  expect(days(plan.from, plan.to)).toBeLessThanOrEqual(100)
})

it('crosses the DST boundary (Nov 1, 2026) with whole-day UTC arithmetic', () => {
  const plan = planCalendarWindow(d('2026-11-01T00:00:00Z'), d('2026-11-08T00:00:00Z'), LF, LT)!
  expect(plan.from).toBe('2026-10-11T00:00:00.000Z')
  expect(plan.to).toBe('2026-11-29T00:00:00.000Z')
})

it('returns null instead of re-requesting the window that is already loaded', () => {
  // A 90-day view gets only 5 days of padding, which sits inside the 7-day
  // prefetch edge; without the guard it would re-request the same URL forever.
  const plan = planCalendarWindow(d('2027-01-01T00:00:00Z'), d('2027-04-01T00:00:00Z'), LF, LT)!
  expect(planCalendarWindow(d('2027-01-01T00:00:00Z'), d('2027-04-01T00:00:00Z'), plan.from, plan.to)).toBeNull()
})
