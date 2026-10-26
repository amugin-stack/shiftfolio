import { describe, expect, it } from 'vitest'
import {
  MIN_SESSIONS_FOR_STATS,
  consistencyScore,
  counterpartEffects,
  fatigueCheck,
  hasEnoughData,
  outliers,
  paceToGoal,
  peerRelativeIndex,
  ptDayOfWeek,
  ptHour,
  rampUp,
  summarize,
  timeBlock,
  weeklyTrend,
  type PerfEntry,
} from './performanceStats'

// PT-naive ISO: the UTC fields ARE the PT wall-clock.
const iso = (day: string, hour = 9) => `2026-09-${day}T${String(hour).padStart(2, '0')}:00:00.000Z`

const entry = (over: Partial<PerfEntry> & { id: string }): PerfEntry => ({
  gmvCents: 10_000,
  hours: 2,
  startISO: iso('07'),
  ...over,
})

/** n entries, all identical apart from id and day, so a group clears the gate. */
const manyEntries = (n: number, over: Partial<PerfEntry> = {}): PerfEntry[] =>
  Array.from({ length: n }, (_, i) =>
    entry({ id: `s${i}`, startISO: iso(String(7 + i).padStart(2, '0')), ...over }),
  )

describe('PT time bucketing', () => {
  it('reads the hour off the ISO string, not the runtime timezone', () => {
    expect(ptHour('2026-09-07T09:00:00.000Z')).toBe(9)
    expect(ptHour('2026-09-07T21:30:00.000Z')).toBe(21)
  })

  // the support team's blocks: morning before 2pm, afternoon 2-8, evening 8+.
  it('buckets into morning / afternoon / evening on half-open boundaries', () => {
    expect(timeBlock(iso('07', 0))).toBe('morning')
    expect(timeBlock(iso('07', 13))).toBe('morning')   // 1pm is still morning
    expect(timeBlock(iso('07', 14))).toBe('afternoon') // 2pm exactly
    expect(timeBlock(iso('07', 19))).toBe('afternoon')
    expect(timeBlock(iso('07', 20))).toBe('evening')   // 8pm exactly
    expect(timeBlock(iso('07', 23))).toBe('evening')
  })

  it('leaves no hour unassigned', () => {
    for (let h = 0; h < 24; h++) {
      expect(['morning', 'afternoon', 'evening']).toContain(timeBlock(iso('07', h)))
    }
  })

  it('day of week comes from the date part only', () => {
    // 2026-09-07 is a Monday.
    expect(ptDayOfWeek('2026-09-07T09:00:00.000Z')).toBe(1)
    // Late evening must NOT roll into the next day for a western runtime.
    expect(ptDayOfWeek('2026-09-07T23:59:00.000Z')).toBe(1)
    expect(ptDayOfWeek('2026-09-13T09:00:00.000Z')).toBe(0) // Sunday
  })

  // CLAUDE.md rule 23 — anything touching PT-day boundaries carries a DST case.
  // These are DST-immune by construction: the stored value is already the PT
  // wall-clock the worker experienced, so slicing cannot drift.
  it('is unaffected by both DST transitions', () => {
    // PT falls back 2026-11-01, springs forward 2027-03-14.
    expect(ptHour('2026-11-01T09:00:00.000Z')).toBe(9)
    expect(timeBlock('2026-11-01T09:00:00.000Z')).toBe('morning')
    expect(ptDayOfWeek('2026-11-01T09:00:00.000Z')).toBe(0) // Sunday
    expect(ptHour('2027-03-14T09:00:00.000Z')).toBe(9)
    expect(timeBlock('2027-03-14T21:00:00.000Z')).toBe('evening')
    expect(ptDayOfWeek('2027-03-14T09:00:00.000Z')).toBe(0) // Sunday
  })
})

describe('summarize', () => {
  it('totals and derives GMV per hour', () => {
    const s = summarize([
      entry({ id: 'a', gmvCents: 10_000, hours: 2 }),
      entry({ id: 'b', gmvCents: 20_000, hours: 2 }),
    ])
    expect(s).toEqual({
      sessions: 2, totalGmvCents: 30_000, totalHours: 4, gmvPerHourCents: 7_500,
    })
  })

  // null, never 0 — the fill.ts convention. A zero would read as "scored zero".
  it('returns null per-hour when there are no hours, not 0', () => {
    expect(summarize([]).gmvPerHourCents).toBeNull()
    expect(summarize([entry({ id: 'a', hours: 0 })]).gmvPerHourCents).toBeNull()
  })
})

// The gate is the whole safety story for this file: with ~87 GMV records
// company-wide, most groups sit below it and MUST report nothing rather than a
// confident-looking number derived from one shift.
describe('the sample-size gate', () => {
  const thin = manyEntries(MIN_SESSIONS_FOR_STATS - 1)

  it('hasEnoughData flips exactly at the threshold', () => {
    expect(hasEnoughData(manyEntries(MIN_SESSIONS_FOR_STATS - 1))).toBe(false)
    expect(hasEnoughData(manyEntries(MIN_SESSIONS_FOR_STATS))).toBe(true)
  })

  it('every gated metric returns null below the threshold', () => {
    expect(consistencyScore(thin)).toBeNull()
    expect(outliers(thin)).toBeNull()
    expect(peerRelativeIndex(thin, thin)).toBeNull()
    expect(rampUp(thin)).toBeNull()
    expect(fatigueCheck(thin)).toBeNull()
    expect(counterpartEffects(new Map([['m1', thin]]))).toBeNull()
  })

  it('the always-honest metrics still report below the threshold', () => {
    expect(summarize(thin).gmvPerHourCents).not.toBeNull()
    expect(paceToGoal(thin, 4_000).currentPerHourCents).not.toBeNull()
  })
})

describe('consistencyScore', () => {
  it('is zero spread for identical sessions', () => {
    const c = consistencyScore(manyEntries(6))!
    expect(c.stdDevCents).toBe(0)
    expect(c.relativeSpread).toBe(0)
    expect(c.bestCents).toBe(c.worstCents)
  })

  it('reports spread, best and worst in per-hour cents', () => {
    const entries = [
      entry({ id: 'a', gmvCents: 10_000, hours: 1, startISO: iso('07') }),
      entry({ id: 'b', gmvCents: 20_000, hours: 1, startISO: iso('08') }),
      entry({ id: 'c', gmvCents: 30_000, hours: 1, startISO: iso('09') }),
      entry({ id: 'd', gmvCents: 40_000, hours: 1, startISO: iso('10') }),
      entry({ id: 'e', gmvCents: 50_000, hours: 1, startISO: iso('11') }),
    ]
    const c = consistencyScore(entries)!
    expect(c.bestCents).toBe(50_000)
    expect(c.worstCents).toBe(10_000)
    expect(c.stdDevCents).toBe(Math.round(Math.sqrt(200_000_000))) // pop. sd
    expect(c.relativeSpread).toBeCloseTo(c.stdDevCents / 30_000, 4)
  })
})

describe('outliers', () => {
  it('flags a session far outside the group’s own range', () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, i) =>
        entry({ id: `n${i}`, gmvCents: 10_000, hours: 1, startISO: iso(String(7 + i).padStart(2, '0')) }),
      ),
      entry({ id: 'spike', gmvCents: 90_000, hours: 1, startISO: iso('20') }),
    ]
    const found = outliers(entries)!
    expect(found.map(o => o.id)).toEqual(['spike'])
    expect(found[0].zScore).toBeGreaterThan(2)
  })

  it('flags nothing when every session is identical', () => {
    expect(outliers(manyEntries(6))).toEqual([])
  })
})

describe('peerRelativeIndex', () => {
  it('is null when the peer buckets are too thin, even if the subject is not', () => {
    // Subject clears the gate, but each day/time bucket has only its own entry.
    const subject = manyEntries(6)
    expect(peerRelativeIndex(subject, subject)).toBeNull()
  })

  it('scores above 1 when the subject beats a well-populated peer bucket', () => {
    const day = iso('07', 9) // one bucket: Monday morning
    const subject = Array.from({ length: 6 }, (_, i) =>
      entry({ id: `me${i}`, gmvCents: 20_000, hours: 1, startISO: day }),
    )
    const peers = Array.from({ length: 8 }, (_, i) =>
      entry({ id: `p${i}`, gmvCents: 10_000, hours: 1, startISO: day }),
    )
    const idx = peerRelativeIndex(subject, [...subject, ...peers])!
    expect(idx).toBeGreaterThan(1)
  })

  // Without excluding self, a group large enough to dominate its own bucket
  // would be measured mostly against itself and drift toward 1.0.
  it('excludes the entry itself from its peer average', () => {
    const day = iso('07', 9)
    const subject = Array.from({ length: 6 }, (_, i) =>
      entry({ id: `me${i}`, gmvCents: 20_000, hours: 1, startISO: day }),
    )
    const peers = Array.from({ length: 8 }, (_, i) =>
      entry({ id: `p${i}`, gmvCents: 10_000, hours: 1, startISO: day }),
    )
    const idx = peerRelativeIndex(subject, [...subject, ...peers])!
    // Peers average is pulled up by the other subject rows but must stay below
    // the subject's own 20000, so the ratio stays meaningfully above 1.
    expect(idx).toBeGreaterThan(1.1)
  })
})

describe('rampUp', () => {
  // Needs firstN early sessions AND a FULL threshold of later ones, so
  // "improvement" can never just be the second shift beating the first.
  it('is null without both an early block and a full steady state', () => {
    expect(rampUp(manyEntries(4), 3)).toBeNull() // 3 early, only 1 steady
    expect(rampUp(manyEntries(7), 3)).toBeNull() // 3 early, 4 steady — still short
    expect(rampUp(manyEntries(8), 3)).not.toBeNull() // 3 early + 5 steady
  })

  it('measures improvement from the first sessions to the rest', () => {
    const entries = [
      entry({ id: 'e1', gmvCents: 10_000, hours: 1, startISO: iso('07') }),
      entry({ id: 'e2', gmvCents: 10_000, hours: 1, startISO: iso('08') }),
      entry({ id: 'e3', gmvCents: 10_000, hours: 1, startISO: iso('09') }),
      ...Array.from({ length: 5 }, (_, i) =>
        entry({ id: `s${i}`, gmvCents: 20_000, hours: 1, startISO: iso(String(10 + i)) }),
      ),
    ]
    const r = rampUp(entries, 3)!
    expect(r.earlyPerHourCents).toBe(10_000)
    expect(r.steadyPerHourCents).toBe(20_000)
    expect(r.deltaCents).toBe(10_000)
  })

  it('orders by start time, not array order', () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        entry({ id: `s${i}`, gmvCents: 20_000, hours: 1, startISO: iso(String(10 + i)) }),
      ),
      entry({ id: 'e1', gmvCents: 10_000, hours: 1, startISO: iso('07') }),
      entry({ id: 'e2', gmvCents: 10_000, hours: 1, startISO: iso('08') }),
      entry({ id: 'e3', gmvCents: 10_000, hours: 1, startISO: iso('09') }),
    ]
    expect(rampUp(entries, 3)!.earlyPerHourCents).toBe(10_000)
  })
})

describe('fatigueCheck', () => {
  it('is null until enough days have a second session', () => {
    // Six sessions but all on different days — nothing to compare within a day.
    expect(fatigueCheck(manyEntries(6))).toBeNull()
  })

  it('compares the first session of a day against the rest, pooled', () => {
    const entries: PerfEntry[] = []
    for (let d = 0; d < 5; d++) {
      const day = String(7 + d).padStart(2, '0')
      entries.push(entry({ id: `f${d}`, gmvCents: 20_000, hours: 1, startISO: iso(day, 9) }))
      entries.push(entry({ id: `l${d}`, gmvCents: 10_000, hours: 1, startISO: iso(day, 15) }))
    }
    const f = fatigueCheck(entries)!
    expect(f.daysCompared).toBe(5)
    expect(f.firstPerHourCents).toBe(20_000)
    expect(f.laterPerHourCents).toBe(10_000)
    expect(f.deltaCents).toBe(-10_000) // negative = drop-off
  })
})

describe('counterpartEffects', () => {
  it('is null when the subject has too little data overall', () => {
    expect(counterpartEffects(new Map([['m1', manyEntries(2)]]))).toBeNull()
  })

  it('drops counterparts below the threshold but keeps qualifying ones', () => {
    const map = new Map<string, PerfEntry[]>([
      ['strong', Array.from({ length: 6 }, (_, i) =>
        entry({ id: `a${i}`, gmvCents: 20_000, hours: 1, startISO: iso(String(7 + i)) }))],
      ['thin', [entry({ id: 'z', gmvCents: 99_000, hours: 1, startISO: iso('20') })]],
    ])
    const effects = counterpartEffects(map)!
    expect(effects.map(e => e.counterpartId)).toEqual(['strong'])
    expect(effects[0].sessions).toBe(6)
  })

  it('reports lift against the subject’s own overall rate, best first', () => {
    const map = new Map<string, PerfEntry[]>([
      ['low', Array.from({ length: 5 }, (_, i) =>
        entry({ id: `l${i}`, gmvCents: 10_000, hours: 1, startISO: iso(String(7 + i)) }))],
      ['high', Array.from({ length: 5 }, (_, i) =>
        entry({ id: `h${i}`, gmvCents: 30_000, hours: 1, startISO: iso(String(12 + i)) }))],
    ])
    const effects = counterpartEffects(map)!
    expect(effects[0].counterpartId).toBe('high')
    expect(effects[0].liftCents).toBe(10_000)  // 30000 vs 20000 overall
    expect(effects[1].liftCents).toBe(-10_000)
  })
})

describe('paceToGoal', () => {
  it('reports the gap to the goal and whether they are on track', () => {
    const entries = [entry({ id: 'a', gmvCents: 10_000, hours: 2 })] // 5000/hr
    const p = paceToGoal(entries, 4_000)
    expect(p.currentPerHourCents).toBe(5_000)
    expect(p.varianceCents).toBe(1_000)
    expect(p.onTrack).toBe(true)
  })

  it('is behind when under the goal', () => {
    const p = paceToGoal([entry({ id: 'a', gmvCents: 6_000, hours: 2 })], 4_000)
    expect(p.varianceCents).toBe(-1_000)
    expect(p.onTrack).toBe(false)
  })

  // A host with no goal set must not read as "failing" — the column is nullable
  // precisely so "no goal" stays distinct from "a goal of zero".
  it('returns nulls, not a verdict, when no goal is set', () => {
    const p = paceToGoal([entry({ id: 'a' })], null)
    expect(p.goalPerHourCents).toBeNull()
    expect(p.varianceCents).toBeNull()
    expect(p.onTrack).toBeNull()
  })
})

describe('weeklyTrend', () => {
  const NOW = new Date(Date.UTC(2026, 8, 16, 12)) // Wed 2026-09-16

  it('returns one bucket per week, oldest first, ending this week', () => {
    const t = weeklyTrend([], 4, NOW)
    expect(t).toHaveLength(4)
    expect(t.map(p => p.weekStartKey)).toEqual([
      '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14',
    ])
  })

  it('buckets sessions into their PT week and reports each week’s count', () => {
    const t = weeklyTrend(
      [
        entry({ id: 'a', gmvCents: 10_000, hours: 1, startISO: '2026-09-15T09:00:00.000Z' }),
        entry({ id: 'b', gmvCents: 30_000, hours: 1, startISO: '2026-09-08T09:00:00.000Z' }),
      ],
      4,
      NOW,
    )
    expect(t[3].sessions).toBe(1)
    expect(t[3].gmvPerHourCents).toBe(10_000)
    expect(t[2].sessions).toBe(1)
    expect(t[2].gmvPerHourCents).toBe(30_000)
    // Empty weeks report null, never 0.
    expect(t[0].gmvPerHourCents).toBeNull()
    expect(t[0].sessions).toBe(0)
  })

  it('handles a Sunday anchor without slipping a week', () => {
    const sunday = new Date(Date.UTC(2026, 8, 20, 12)) // Sun 2026-09-20
    const t = weeklyTrend([], 1, sunday)
    expect(t[0].weekStartKey).toBe('2026-09-14') // the Monday before
  })
})
