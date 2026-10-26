import { describe, it, expect } from 'vitest'
import {
  PAY_PERIOD_DAYS,
  PAY_PERIOD_ANCHOR_KEY,
  currentPayPeriodStartKey,
  formatPayPeriodLabel,
  normalizePayPeriodKey,
  payPeriodStartKeyForDay,
  payPeriodStartKeyForShift,
  ptDayKey,
  resolvePayPeriod,
  shiftPayPeriodKey,
} from './payPeriod'

const DAY_MS = 86_400_000

/** A PT-naive instant, the way nowPtAsUtc() produces one. */
function pt(y: number, m: number, d: number, h = 12): Date {
  return new Date(Date.UTC(y, m - 1, d, h))
}

describe('the anchor', () => {
  // This is the business fact the whole module hangs off. Alex confirmed on
  // 2026-08-31 that the period being worked was Aug 24 -> Sep 6. If someone
  // edits the anchor constant, this fails first and loudly, because moving it
  // re-dates every period on every worker's page AND in the payroll CSV.
  it('puts Aug 24 – Sep 6 2026 in one period', () => {
    const p = resolvePayPeriod(payPeriodStartKeyForDay('2026-08-31'))
    expect(p.startKey).toBe('2026-08-24')
    expect(p.endKey).toBe('2026-09-06')
  })

  it('is itself a period start', () => {
    expect(payPeriodStartKeyForDay(PAY_PERIOD_ANCHOR_KEY)).toBe(PAY_PERIOD_ANCHOR_KEY)
  })
})

describe('payPeriodStartKeyForDay', () => {
  it('maps every day of a period to that period', () => {
    for (let i = 0; i < PAY_PERIOD_DAYS; i++) {
      const day = new Date(Date.UTC(2026, 7, 24) + i * DAY_MS).toISOString().slice(0, 10)
      expect(payPeriodStartKeyForDay(day)).toBe('2026-08-24')
    }
  })

  it('rolls to the next period on the day after it ends', () => {
    expect(payPeriodStartKeyForDay('2026-09-06')).toBe('2026-08-24')
    expect(payPeriodStartKeyForDay('2026-09-07')).toBe('2026-09-07')
  })

  // Every worker's history predates the anchor, so this is the COMMON path.
  // Truncating toward zero instead of flooring would collapse the two periods
  // either side of the anchor into one 28-day period.
  it('counts backwards correctly before the anchor', () => {
    expect(payPeriodStartKeyForDay('2026-08-23')).toBe('2026-08-10')
    expect(payPeriodStartKeyForDay('2026-08-10')).toBe('2026-08-10')
    expect(payPeriodStartKeyForDay('2026-08-09')).toBe('2026-07-27')
  })

  it('does not fold the periods either side of the anchor together', () => {
    expect(payPeriodStartKeyForDay('2026-08-23')).not.toBe(
      payPeriodStartKeyForDay('2026-08-24'),
    )
  })

  it('handles a date years before the anchor', () => {
    const key = payPeriodStartKeyForDay('2024-01-15')
    const p = resolvePayPeriod(key)
    expect(new Date(p.fromISO).getTime()).toBeLessThanOrEqual(Date.UTC(2024, 0, 15))
    expect(new Date(p.toExclusiveISO).getTime()).toBeGreaterThan(Date.UTC(2024, 0, 15))
  })
})

describe('periods tile the timeline', () => {
  // The property that makes the export safe: no day belongs to two periods
  // (double pay) and no day belongs to none (never paid). This is the exact
  // failure the rolling "past 2 weeks" window had.
  it('consecutive periods abut with no gap and no overlap', () => {
    let key = payPeriodStartKeyForDay('2026-01-01')
    for (let i = 0; i < 60; i++) {
      const a = resolvePayPeriod(key)
      const next = shiftPayPeriodKey(key, 1)
      const b = resolvePayPeriod(next)
      expect(a.toExclusiveISO).toBe(b.fromISO)
      key = next
    }
  })

  it('every day in a two-year sweep lands in exactly one period', () => {
    for (let i = 0; i < 730; i++) {
      const ms = Date.UTC(2026, 0, 1) + i * DAY_MS
      const day = new Date(ms).toISOString().slice(0, 10)
      const p = resolvePayPeriod(payPeriodStartKeyForDay(day))
      expect(new Date(p.fromISO).getTime()).toBeLessThanOrEqual(ms)
      expect(new Date(p.toExclusiveISO).getTime()).toBeGreaterThan(ms)
    }
  })
})

describe('resolvePayPeriod', () => {
  it('spans exactly 14 days, inclusive end on day 13', () => {
    const p = resolvePayPeriod('2026-08-24')
    expect(p.fromISO).toBe('2026-08-24T00:00:00.000Z')
    expect(p.toExclusiveISO).toBe('2026-09-07T00:00:00.000Z')
    expect(p.endKey).toBe('2026-09-06')
    expect(new Date(p.toExclusiveISO).getTime() - new Date(p.fromISO).getTime()).toBe(
      PAY_PERIOD_DAYS * DAY_MS,
    )
  })
})

// CLAUDE.md rule 23 — anything touching PT-day boundaries carries a DST case.
// The arithmetic here is whole-calendar-day in UTC, so it is DST-immune by
// construction; these lock that in rather than discovering it later from a
// paycheck that was an hour short twice a year.
describe('DST transitions', () => {
  it('a period containing the November fall-back is still exactly 14 days', () => {
    // PT falls back on 2026-11-01.
    const p = resolvePayPeriod(payPeriodStartKeyForDay('2026-11-01'))
    expect(new Date(p.toExclusiveISO).getTime() - new Date(p.fromISO).getTime()).toBe(
      PAY_PERIOD_DAYS * DAY_MS,
    )
    expect(p.fromISO.endsWith('T00:00:00.000Z')).toBe(true)
    expect(p.toExclusiveISO.endsWith('T00:00:00.000Z')).toBe(true)
  })

  it('a period containing the March spring-forward is still exactly 14 days', () => {
    // PT springs forward on 2027-03-14.
    const p = resolvePayPeriod(payPeriodStartKeyForDay('2027-03-14'))
    expect(new Date(p.toExclusiveISO).getTime() - new Date(p.fromISO).getTime()).toBe(
      PAY_PERIOD_DAYS * DAY_MS,
    )
    expect(p.fromISO.endsWith('T00:00:00.000Z')).toBe(true)
  })

  it('periods still abut exactly across a DST transition', () => {
    const before = payPeriodStartKeyForDay('2026-10-20')
    const a = resolvePayPeriod(before)
    const b = resolvePayPeriod(shiftPayPeriodKey(before, 1))
    expect(a.toExclusiveISO).toBe(b.fromISO)
  })
})

describe('payPeriodStartKeyForShift', () => {
  it('buckets by the END of the shift, matching payroll', () => {
    // 23:00 -> 01:00 across the final midnight of a period belongs to the NEXT
    // period, because that is where the paycheck puts it.
    expect(payPeriodStartKeyForShift('2026-09-07T01:00:00.000Z')).toBe('2026-09-07')
    expect(payPeriodStartKeyForShift('2026-09-06T23:00:00.000Z')).toBe('2026-08-24')
  })

  it('handles the +00:00 offset form Postgres returns', () => {
    expect(payPeriodStartKeyForShift('2026-09-06T23:00:00+00:00')).toBe('2026-08-24')
  })

  it('a shift ending exactly at the boundary midnight falls in the next period', () => {
    // Matches the half-open window the export uses: >= from AND < toExclusive.
    const p = resolvePayPeriod('2026-08-24')
    expect(payPeriodStartKeyForShift(p.toExclusiveISO)).toBe('2026-09-07')
  })
})

describe('normalizePayPeriodKey', () => {
  const now = pt(2026, 8, 31)

  it('falls back to the current period when absent or malformed', () => {
    expect(normalizePayPeriodKey(undefined, now)).toBe('2026-08-24')
    expect(normalizePayPeriodKey('', now)).toBe('2026-08-24')
    expect(normalizePayPeriodKey('nonsense', now)).toBe('2026-08-24')
    expect(normalizePayPeriodKey('2026-08', now)).toBe('2026-08-24')
    // Shape-valid but impossible date — Date.UTC would roll this into March.
    expect(normalizePayPeriodKey('2026-02-31', now)).toBe('2026-08-24')
  })

  it('snaps a mid-period date to that period start', () => {
    expect(normalizePayPeriodKey('2026-09-02', now)).toBe('2026-08-24')
  })

  it('passes a real period start through untouched', () => {
    expect(normalizePayPeriodKey('2026-07-27', now)).toBe('2026-07-27')
  })
})

describe('currentPayPeriodStartKey / ptDayKey', () => {
  it('reads the PT calendar day off a PT-naive instant', () => {
    // 2026-09-06 23:30 PT is still inside the Aug 24 period, and must not be
    // read as Sep 7 by a runtime in a different timezone.
    expect(ptDayKey(pt(2026, 9, 6, 23))).toBe('2026-09-06')
    expect(currentPayPeriodStartKey(pt(2026, 9, 6, 23))).toBe('2026-08-24')
    expect(currentPayPeriodStartKey(pt(2026, 9, 7, 0))).toBe('2026-09-07')
  })
})

describe('formatPayPeriodLabel', () => {
  it('prints the year once for a same-year period', () => {
    expect(formatPayPeriodLabel(resolvePayPeriod('2026-08-24'))).toBe('Aug 24 – Sep 6, 2026')
  })

  it('prints both years when the period straddles New Year', () => {
    const key = payPeriodStartKeyForDay('2026-12-31')
    const label = formatPayPeriodLabel(resolvePayPeriod(key))
    expect(label).toMatch(/2026 – .*2027$/)
  })
})
