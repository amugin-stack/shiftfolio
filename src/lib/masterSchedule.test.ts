import { describe, expect, it } from 'vitest'
import {
  resolveScheduleRange,
  shiftScheduleDate,
  unionDayWindow,
  buildMasterEvents,
  buildBrandColorMap,
  computeOverlapBands,
  markOverlappingEventIds,
  concurrentEvents,
  maxConcurrentByEventId,
} from './masterSchedule'
import type { MasterEvent } from './masterSchedule'
import { BRAND_COLORS, getBrandColor } from './utils'
import type { StreamWithRelations } from './supabase/types'

// PT-naive convention: a stream's UTC fields ARE its PT wall-clock.
// resolveScheduleRange produces ISO bounds whose UTC fields are PT calendar
// dates, and event start/end pass stored timestamps through unchanged.

describe('resolveScheduleRange', () => {
  it('day → that single calendar day', () => {
    const r = resolveScheduleRange('day', '2026-06-17')
    expect(r.fromISO).toBe('2026-06-17T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2026-06-18T00:00:00.000Z')
    expect(r.fromKey).toBe('2026-06-17')
    expect(r.toKey).toBe('2026-06-17')
  })

  it('week → normalizes a mid-week date to the containing Mon–Sun week', () => {
    // 2026-06-17 is a Wednesday → Monday 2026-06-15.
    const r = resolveScheduleRange('week', '2026-06-17')
    expect(r.fromISO).toBe('2026-06-15T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2026-06-22T00:00:00.000Z')
    expect(r.fromKey).toBe('2026-06-15')
    expect(r.toKey).toBe('2026-06-21') // inclusive Sunday
  })

  it('week → handles a Monday input as itself', () => {
    const r = resolveScheduleRange('week', '2026-06-15')
    expect(r.fromKey).toBe('2026-06-15')
    expect(r.toKey).toBe('2026-06-21')
  })

  it('week → handles a Sunday input (normalizes back to its Monday)', () => {
    // 2026-06-21 is a Sunday → Monday 2026-06-15.
    const r = resolveScheduleRange('week', '2026-06-21')
    expect(r.fromKey).toBe('2026-06-15')
    expect(r.toKey).toBe('2026-06-21')
  })

  it('week → spans a month boundary cleanly', () => {
    // 2026-07-01 is a Wednesday → Monday 2026-06-29 … Sunday 2026-07-05.
    const r = resolveScheduleRange('week', '2026-07-01')
    expect(r.fromKey).toBe('2026-06-29')
    expect(r.toKey).toBe('2026-07-05')
    expect(r.toExclusiveISO).toBe('2026-07-06T00:00:00.000Z')
  })

  it('week → spans a Dec → Jan year boundary cleanly', () => {
    // 2026-12-31 is a Thursday → Monday 2026-12-28 … Sunday 2027-01-03.
    const r = resolveScheduleRange('week', '2026-12-31')
    expect(r.fromISO).toBe('2026-12-28T00:00:00.000Z')
    expect(r.fromKey).toBe('2026-12-28')
    expect(r.toKey).toBe('2027-01-03')
    expect(r.toExclusiveISO).toBe('2027-01-04T00:00:00.000Z')
  })

  it('throws RangeError on malformed dateKey', () => {
    expect(() => resolveScheduleRange('day', 'bad')).toThrow(RangeError)
    expect(() => resolveScheduleRange('week', '2026-06')).toThrow(RangeError)
  })
})

describe('shiftScheduleDate', () => {
  it('day → shifts by delta days', () => {
    expect(shiftScheduleDate('day', '2026-06-17', 1)).toBe('2026-06-18')
    expect(shiftScheduleDate('day', '2026-06-17', -1)).toBe('2026-06-16')
  })

  it('day → rolls over a month boundary', () => {
    expect(shiftScheduleDate('day', '2026-06-30', 1)).toBe('2026-07-01')
    expect(shiftScheduleDate('day', '2026-07-01', -1)).toBe('2026-06-30')
  })

  it('week → shifts by 7*delta days', () => {
    expect(shiftScheduleDate('week', '2026-06-15', 1)).toBe('2026-06-22')
    expect(shiftScheduleDate('week', '2026-06-15', -1)).toBe('2026-06-08')
  })

  it('week → rolls over a year boundary (+1 week)', () => {
    expect(shiftScheduleDate('week', '2026-12-28', 1)).toBe('2027-01-04')
  })
})

describe('unionDayWindow', () => {
  it('takes the min start and max end across brands', () => {
    expect(
      unionDayWindow([
        { day_start_minutes: 540, day_end_minutes: 1020 }, // 9:00–17:00
        { day_start_minutes: 480, day_end_minutes: 1200 }, // 8:00–20:00
        { day_start_minutes: 600, day_end_minutes: 1080 }, // 10:00–18:00
      ]),
    ).toEqual({ startMinutes: 480, endMinutes: 1200 })
  })

  it('returns a single brand window verbatim', () => {
    expect(
      unionDayWindow([{ day_start_minutes: 600, day_end_minutes: 1080 }]),
    ).toEqual({ startMinutes: 600, endMinutes: 1080 })
  })

  it('returns the full day for an empty array (never clip)', () => {
    expect(unionDayWindow([])).toEqual({ startMinutes: 0, endMinutes: 1440 })
  })
})

describe('buildMasterEvents', () => {
  const stream = (over: Partial<StreamWithRelations>): StreamWithRelations =>
    ({
      id: 's1',
      brand_id: 'brand-a',
      start_time: '2026-06-17T12:00:00.000Z',
      end_time: '2026-06-17T14:00:00.000Z',
      host: { id: 'h1', name: 'Alice' },
      brand: { id: 'brand-a', name: 'Brand A' },
      producer: null,
      moderator: null,
      ...over,
    }) as unknown as StreamWithRelations

  it('carries brandName + hostName and passes start/end through unchanged', () => {
    const [e] = buildMasterEvents([stream({})])
    expect(e.id).toBe('s1')
    expect(e.brandId).toBe('brand-a')
    expect(e.brandName).toBe('Brand A')
    expect(e.hostName).toBe('Alice')
    expect(e.start).toBe('2026-06-17T12:00:00.000Z')
    expect(e.end).toBe('2026-06-17T14:00:00.000Z')
  })

  it('colors come from getBrandColor(brand_id)', () => {
    const expected = getBrandColor('brand-a')
    const [e] = buildMasterEvents([stream({})])
    expect(e.bg).toBe(expected.bg)
    expect(e.border).toBe(expected.border)
    expect(e.text).toBe(expected.text)
  })

  it('same brand_id → identical colors regardless of other fields', () => {
    const [a, b] = buildMasterEvents([
      stream({ id: 's1', brand_id: 'brand-x', brand: { id: 'brand-x', name: 'X' } }),
      stream({ id: 's2', brand_id: 'brand-x', brand: { id: 'brand-x', name: 'X' } }),
    ])
    expect(a.bg).toBe(b.bg)
    expect(a.border).toBe(b.border)
    expect(a.text).toBe(b.text)
  })

  it('null host → hostName null', () => {
    const [e] = buildMasterEvents([stream({ host: null })])
    expect(e.hostName).toBeNull()
  })

  it('preserves input order (caller pre-sorts by start_time)', () => {
    const events = buildMasterEvents([
      stream({ id: 'a', start_time: '2026-06-17T09:00:00.000Z' }),
      stream({ id: 'b', start_time: '2026-06-17T12:00:00.000Z' }),
      stream({ id: 'c', start_time: '2026-06-17T15:00:00.000Z' }),
    ])
    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('a brand in the colorMap uses the map color', () => {
    const colorMap = buildBrandColorMap(['brand-a'])
    const [e] = buildMasterEvents([stream({})], colorMap)
    const mapped = colorMap.get('brand-a')!
    expect(e.bg).toBe(mapped.bg)
    expect(e.border).toBe(mapped.border)
    expect(e.text).toBe(mapped.text)
  })

  it('a brand NOT in the colorMap falls back to getBrandColor', () => {
    // Map only knows brand-a; the event is brand-z → falls back to the hash.
    const colorMap = buildBrandColorMap(['brand-a'])
    const expected = getBrandColor('brand-z')
    const [e] = buildMasterEvents(
      [stream({ brand_id: 'brand-z', brand: { id: 'brand-z', name: 'Z' } })],
      colorMap,
    )
    expect(e.bg).toBe(expected.bg)
    expect(e.border).toBe(expected.border)
    expect(e.text).toBe(expected.text)
  })
})

describe('buildBrandColorMap', () => {
  it('assigns three ids three different palette colors by index', () => {
    const map = buildBrandColorMap(['a', 'b', 'c'])
    expect(map.get('a')).toEqual(BRAND_COLORS[0])
    expect(map.get('b')).toEqual(BRAND_COLORS[1])
    expect(map.get('c')).toEqual(BRAND_COLORS[2])
  })

  it('cycles the palette when there are more ids than colors', () => {
    // Build N+1 unique ids; the one at index = BRAND_COLORS.length wraps to [0].
    const ids = Array.from({ length: BRAND_COLORS.length + 1 }, (_, i) => `id-${i}`)
    const map = buildBrandColorMap(ids)
    expect(map.get(`id-${BRAND_COLORS.length}`)).toEqual(BRAND_COLORS[0])
  })

  it('keeps the first occurrence of a duplicate id', () => {
    // 'dup' appears at index 0 and index 2; it must keep BRAND_COLORS[0].
    const map = buildBrandColorMap(['dup', 'other', 'dup'])
    expect(map.get('dup')).toEqual(BRAND_COLORS[0])
    expect(map.get('other')).toEqual(BRAND_COLORS[1])
  })
})

describe('computeOverlapBands', () => {
  // PT-naive UTC ISO at a whole UTC hour, e.g. at(16) → 4pm.
  const at = (h: number): string => `2026-06-17T${String(h).padStart(2, '0')}:00:00.000Z`
  const ev = (hStart: number, hEnd: number) => ({ start: at(hStart), end: at(hEnd) })

  it('no events → []', () => {
    expect(computeOverlapBands([])).toEqual([])
  })

  it('single event → [] (no concurrency)', () => {
    expect(computeOverlapBands([ev(4, 7)])).toEqual([])
  })

  it('two overlapping (4–7, 5–8) → one band 5–7 count 2', () => {
    expect(computeOverlapBands([ev(4, 7), ev(5, 8)])).toEqual([
      { start: at(5), end: at(7), count: 2 },
    ])
  })

  it('touching only (4–5, 5–6) → [] (touch is not overlap)', () => {
    expect(computeOverlapBands([ev(4, 5), ev(5, 6)])).toEqual([])
  })

  it('nested (4–8 contains 5–6) → one band 5–6 count 2', () => {
    expect(computeOverlapBands([ev(4, 8), ev(5, 6)])).toEqual([
      { start: at(5), end: at(6), count: 2 },
    ])
  })

  it('identical times (5–6, 5–6) → one band 5–6 count 2', () => {
    expect(computeOverlapBands([ev(5, 6), ev(5, 6)])).toEqual([
      { start: at(5), end: at(6), count: 2 },
    ])
  })

  it('three-way varying concurrency (A 4–7, B 5–8, C 6–9)', () => {
    // 5–6: A,B = 2; 6–7: A,B,C = 3; 7–8: B,C = 2; 8–9: C only.
    expect(computeOverlapBands([ev(4, 7), ev(5, 8), ev(6, 9)])).toEqual([
      { start: at(5), end: at(6), count: 2 },
      { start: at(6), end: at(7), count: 3 },
      { start: at(7), end: at(8), count: 2 },
    ])
  })

  it('invalid event (end <= start) is ignored', () => {
    // 5–5 (zero-length) and 6–4 (negative) must not create or affect a band.
    expect(computeOverlapBands([ev(5, 5), ev(6, 4)])).toEqual([])
    // A valid overlap is unaffected by a co-present invalid event.
    expect(computeOverlapBands([ev(4, 7), ev(5, 8), ev(6, 6)])).toEqual([
      { start: at(5), end: at(7), count: 2 },
    ])
  })

  it('returns bands sorted by start ascending', () => {
    // Events supplied out of order; bands must still be sorted.
    const bands = computeOverlapBands([ev(6, 9), ev(4, 7), ev(5, 8)])
    const starts = bands.map(b => b.start)
    expect(starts).toEqual([...starts].sort())
    expect(starts).toEqual([at(5), at(6), at(7)])
  })
})

// PT-naive UTC ISO at a whole UTC hour, e.g. at(16) → 4pm.
const at = (h: number): string => `2026-06-17T${String(h).padStart(2, '0')}:00:00.000Z`

describe('markOverlappingEventIds', () => {
  const idEv = (id: string, hStart: number, hEnd: number) => ({
    id,
    start: at(hStart),
    end: at(hEnd),
  })

  it('two overlapping → both ids in the set', () => {
    const set = markOverlappingEventIds([idEv('a', 4, 7), idEv('b', 5, 8)])
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('two touching (4–5, 5–6) → empty (touch is not overlap)', () => {
    const set = markOverlappingEventIds([idEv('a', 4, 5), idEv('b', 5, 6)])
    expect(set).toEqual(new Set())
  })

  it('A&B overlap but C is separate → {A,B} only', () => {
    const set = markOverlappingEventIds([
      idEv('a', 4, 7),
      idEv('b', 5, 8),
      idEv('c', 10, 12),
    ])
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('nested (A 4–8 contains B 5–6) → both', () => {
    const set = markOverlappingEventIds([idEv('a', 4, 8), idEv('b', 5, 6)])
    expect(set).toEqual(new Set(['a', 'b']))
  })

  it('ignores an event with end <= start', () => {
    // 'bad' is zero-length (6–6) and must never be marked, even amid a real overlap.
    const set = markOverlappingEventIds([
      idEv('a', 4, 7),
      idEv('b', 5, 8),
      idEv('bad', 6, 6),
    ])
    expect(set).toEqual(new Set(['a', 'b']))
  })
})

describe('concurrentEvents', () => {
  // Minimal MasterEvent fixture; color fields are arbitrary strings.
  const mev = (id: string, brandName: string, hStart: number, hEnd: number): MasterEvent => ({
    id,
    start: at(hStart),
    end: at(hEnd),
    brandId: `brand-${id}`,
    brandName,
    hostName: null,
    bg: '#000',
    border: '#111',
    text: '#fff',
  })

  it('clicking an event in a 2-way overlap returns both, sorted by start then brandName', () => {
    const a = mev('a', 'Beta', 5, 8) // later start, name Beta
    const b = mev('b', 'Alpha', 4, 7) // earlier start
    const result = concurrentEvents([a, b], a)
    expect(result.map(e => e.id)).toEqual(['b', 'a']) // sorted by start ascending
  })

  it('ties on start are broken by brandName ascending', () => {
    const a = mev('a', 'Zeta', 4, 7)
    const b = mev('b', 'Alpha', 4, 7)
    const result = concurrentEvents([a, b], a)
    expect(result.map(e => e.brandName)).toEqual(['Alpha', 'Zeta'])
  })

  it('a solo event returns just itself', () => {
    const a = mev('a', 'Alpha', 4, 7)
    const far = mev('b', 'Beta', 10, 12)
    expect(concurrentEvents([a, far], a)).toEqual([a])
  })

  it('a touching neighbor is excluded (touch is not overlap)', () => {
    const a = mev('a', 'Alpha', 4, 5)
    const b = mev('b', 'Beta', 5, 6) // touches a at 5
    expect(concurrentEvents([a, b], a)).toEqual([a])
  })
})

describe('maxConcurrentByEventId', () => {
  const idEv = (id: string, hStart: number, hEnd: number) => ({
    id,
    start: at(hStart),
    end: at(hEnd),
  })

  it('a solo event → 1', () => {
    expect(maxConcurrentByEventId([idEv('a', 4, 7)])).toEqual(new Map([['a', 1]]))
  })

  it('two overlapping (4–7, 5–8) → both 2', () => {
    const m = maxConcurrentByEventId([idEv('a', 4, 7), idEv('b', 5, 8)])
    expect(m.get('a')).toBe(2)
    expect(m.get('b')).toBe(2)
  })

  it('three truly simultaneous (5–6 ×3) → each 3', () => {
    const m = maxConcurrentByEventId([idEv('a', 5, 6), idEv('b', 5, 6), idEv('c', 5, 6)])
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual([3, 3, 3])
  })

  it('a long live overlapping two NON-simultaneous shifts reads 2, not 3', () => {
    // A 8–11 spans B 8–9 and C 10–11, but B and C never coincide → max 2.
    const m = maxConcurrentByEventId([idEv('A', 8, 11), idEv('B', 8, 9), idEv('C', 10, 11)])
    expect(m.get('A')).toBe(2)
    expect(m.get('B')).toBe(2)
    expect(m.get('C')).toBe(2)
  })

  it('varying concurrency (A 4–7, B 5–8, C 6–9) → A 3, B 3, C 3 (all touch the 6–7 triple)', () => {
    // 6–7 has A,B,C simultaneously; each event's span includes that instant.
    const m = maxConcurrentByEventId([idEv('A', 4, 7), idEv('B', 5, 8), idEv('C', 6, 9)])
    expect([m.get('A'), m.get('B'), m.get('C')]).toEqual([3, 3, 3])
  })

  it('touching neighbors (4–5, 5–6) → each 1', () => {
    const m = maxConcurrentByEventId([idEv('a', 4, 5), idEv('b', 5, 6)])
    expect([m.get('a'), m.get('b')]).toEqual([1, 1])
  })

  it('ignores an event with end <= start (absent from the map)', () => {
    const m = maxConcurrentByEventId([idEv('a', 4, 7), idEv('bad', 6, 6)])
    expect(m.has('bad')).toBe(false)
    expect(m.get('a')).toBe(1)
  })
})
