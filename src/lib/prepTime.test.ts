import { describe, it, expect } from 'vitest'
import {
  buildPrepBlocks,
  prepBlockCents,
  beforeOpenMarkerStartISO,
  setupBonusApplies,
  PREP_DURATION_MINUTES,
  PREP_DURATION_MINUTES_V2,
  PREP_DURATION_CUTOFF_ISO,
  PREP_CUTOFF_ISO,
  PREP_TIME_ENABLED,
  type PrepStreamInput,
} from '@/lib/prepTime'

const s = (
  id: string,
  brand: string,
  mod: string | null,
  startISO: string,
  endISO: string,
): PrepStreamInput => ({
  id,
  brand_id: brand,
  moderator_id: mod,
  start_time: startISO,
  end_time: endISO,
})

describe('buildPrepBlocks — session grouping', () => {
  it('N touching rows, one moderator, one brand → exactly ONE block before the run start', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
      s('c', 'b1', 'm1', '2026-08-01T18:00:00.000Z', '2026-08-01T21:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
    expect(blocks[0].startISO).toBe('2026-08-01T11:30:00.000Z')
    expect(blocks[0].endISO).toBe('2026-08-01T12:00:00.000Z')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T21:00:00.000Z')
  })

  it('host changes mid-run are irrelevant — grouping keys on moderator + brand only', () => {
    // PrepStreamInput has no host field by design: two touching rows with
    // different hosts but the same moderator/brand are one session.
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
  })

  it('a gap between runs → two sessions, two blocks', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T14:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T16:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks.map(b => b.anchorId)).toEqual(['a', 'b'])
    expect(blocks[1].startISO).toBe('2026-08-01T15:30:00.000Z')
  })

  it('brand change breaks the session even when touching', () => {
    // Touching but different brand → separate sessions; the second is then
    // suppressed (the first shift covers its prep window).
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      s('b', 'b2', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
  })

  it('streams with no moderator yield nothing', () => {
    expect(
      buildPrepBlocks([s('a', 'b1', null, '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z')]),
    ).toEqual([])
    expect(buildPrepBlocks([])).toEqual([])
  })

  it('different moderators get independent sessions and blocks', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      s('b', 'b1', 'm2', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks.map(b => b.moderatorId).sort()).toEqual(['m1', 'm2'])
  })
})

describe('buildPrepBlocks — suppression', () => {
  it('cross-brand back-to-back: prior live overlapping the prep window suppresses', () => {
    // Live at b1 until 15:00; b2 go-live at 15:00 → prep 14:30–15:00 overlaps
    // b1's paid live time → no block for the b2 session.
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      s('b', 'b2', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['a'])
  })

  it('a shift ending exactly at prep start also suppresses (touching, closed interval)', () => {
    // b1 ends 14:30; b2 session starts 15:00 → prep window is exactly
    // 14:30–15:00. The moderator is already on set — no separate arrival.
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T14:30:00.000Z'),
      s('b', 'b2', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['a'])
  })

  it('a gap wider than the prep window does NOT suppress', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T14:29:00.000Z'),
      s('b', 'b2', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['a', 'b'])
  })

  it("another moderator's adjacent shift does not suppress", () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm2', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      s('b', 'b2', 'm1', '2026-08-01T15:00:00.000Z', '2026-08-01T18:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(2)
  })
})

describe('buildPrepBlocks — attribution and windows', () => {
  it('session starting at PT midnight: prep sits on the prior day but belongs to the session day', () => {
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-08-01T00:00:00.000Z', '2026-08-01T03:00:00.000Z')],
      { window: { fromISO: '2026-08-01T00:00:00.000Z', toExclusiveISO: '2026-09-01T00:00:00.000Z' } },
    )
    expect(blocks).toHaveLength(1)
    // The prep window itself is on July 31 (PT-naive) …
    expect(blocks[0].startISO).toBe('2026-07-31T23:30:00.000Z')
    // … but the block is attributed (windowed) by its session start in August.
    expect(blocks[0].sessionStartISO).toBe('2026-08-01T00:00:00.000Z')
  })

  it('session before day_start still yields a (pay-only) block — clipping is a render decision', () => {
    // 12:00 PM go-live on a noon-start brand: prep 11:30–12:00 precedes the
    // brand's day window. Pay still accrues; the calendar decides not to
    // render the tile (see CalendarView).
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T15:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startISO).toBe('2026-08-01T11:30:00.000Z')
  })

  it('a session straddling the window start is attributed to where it ENDS', () => {
    // Padded query: caller fetched 1 day of lookback. The session runs
    // Jul 31 22:00 -> Aug 1 02:00, so it ENDS in August and its prep block is
    // minted in August, alongside the shift rows it belongs to.
    //
    // This used to expect [] on the grounds that the session STARTED in July,
    // so July would mint it. That stopped being true once payroll windowed on
    // end_time: July's query (end_time < Aug 1) never returns this session at
    // all, so start-attribution left the prep block in a hole where NO period
    // ever paid it.
    const blocks = buildPrepBlocks(
      [
        s('a', 'b1', 'm1', '2026-07-31T22:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        s('b', 'b1', 'm1', '2026-08-01T00:00:00.000Z', '2026-08-01T02:00:00.000Z'),
      ],
      { window: { fromISO: '2026-08-01T00:00:00.000Z', toExclusiveISO: '2026-09-01T00:00:00.000Z' } },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].sessionStartISO).toBe('2026-07-31T22:00:00.000Z')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T02:00:00.000Z')
  })

  it('a session ending BEFORE the window mints no block in it', () => {
    // The other side of the same rule: the previous period already paid this.
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-07-31T18:00:00.000Z', '2026-07-31T20:00:00.000Z')],
      { window: { fromISO: '2026-08-01T00:00:00.000Z', toExclusiveISO: '2026-09-01T00:00:00.000Z' } },
    )
    expect(blocks).toEqual([])
  })

  it('cutoff partition: pre-cutoff sessions yield no prep; post-cutoff do', () => {
    const cutoff = '2026-08-15T00:00:00.000Z'
    const blocks = buildPrepBlocks(
      [
        s('pre', 'b1', 'm1', '2026-08-10T12:00:00.000Z', '2026-08-10T15:00:00.000Z'),
        s('post', 'b1', 'm1', '2026-08-20T12:00:00.000Z', '2026-08-20T15:00:00.000Z'),
      ],
      { cutoffISO: cutoff },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['post'])
    // And the old-rule gate is the exact complement of that partition.
    expect('2026-08-10T12:00:00.000Z' < cutoff).toBe(true)
  })
})

describe('setupBonusApplies — the old-rule gate', () => {
  it('pre-cutoff streams keep the setup bonus; post-cutoff do not (while enabled)', () => {
    if (!PREP_TIME_ENABLED) return
    expect(setupBonusApplies('2026-01-01T12:00:00.000Z')).toBe(true)
    expect(setupBonusApplies(PREP_CUTOFF_ISO)).toBe(false)
    expect(setupBonusApplies('2027-01-01T12:00:00.000Z')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PREP LENGTH CHANGED 30 -> 60 MINUTES (the support team, 2026-09-04)
// ---------------------------------------------------------------------------
// "For every shift a moderator does, they should get 1 extra hour of pay."
// Confirmed as per ARRIVAL (a contiguous session), not per stored calendar row.
//
// Gated on a cutoff for the same reason PREP_CUTOFF_ISO exists: the constant is
// read by every pay surface with no date attached, so changing it outright
// would silently re-price already-paid periods.
describe('prep duration cutoff', () => {
  const before = '2026-08-20T10:00:00.000Z' // before PREP_DURATION_CUTOFF_ISO
  const after = '2026-08-25T10:00:00.000Z'  // after

  it('a session before the cutoff still gets 30 minutes', () => {
    const [b] = buildPrepBlocks([s('a', 'b1', 'm1', before, '2026-08-20T12:00:00.000Z')])
    expect(b.durationMinutes).toBe(30)
    expect(b.startISO).toBe('2026-08-20T09:30:00.000Z')
  })

  it('a session after the cutoff gets 60 minutes', () => {
    const [b] = buildPrepBlocks([s('a', 'b1', 'm1', after, '2026-08-25T12:00:00.000Z')])
    expect(b.durationMinutes).toBe(60)
    expect(b.startISO).toBe('2026-08-25T09:00:00.000Z')
  })

  // Half-open, matching every other cutoff in this codebase: a session starting
  // exactly ON the boundary is in the NEW regime.
  it('a session starting exactly at the cutoff is 60 minutes', () => {
    const [b] = buildPrepBlocks([
      s('a', 'b1', 'm1', PREP_DURATION_CUTOFF_ISO, '2026-08-24T02:00:00.000Z'),
    ])
    expect(b.durationMinutes).toBe(60)
  })

  it('one millisecond before the cutoff is still 30 minutes', () => {
    const justBefore = new Date(new Date(PREP_DURATION_CUTOFF_ISO).getTime() - 1).toISOString()
    const [b] = buildPrepBlocks([s('a', 'b1', 'm1', justBefore, '2026-08-24T02:00:00.000Z')])
    expect(b.durationMinutes).toBe(30)
  })

  it('the length is decided per SESSION, so a mixed range pays both', () => {
    const blocks = buildPrepBlocks([
      s('old', 'b1', 'm1', before, '2026-08-20T12:00:00.000Z'),
      s('new', 'b1', 'm1', after, '2026-08-25T12:00:00.000Z'),
    ])
    expect(blocks.map(b => b.durationMinutes)).toEqual([30, 60])
  })

  // Brent's real shape (the support team's report): 71 hour-long calendar rows that stack
  // into 18 contiguous sessions. He arrived 18 times, so he is owed 18 hours --
  // NOT 71, which would have made his prep pay equal his entire live pay.
  it('pays one hour per ARRIVAL, not per calendar row', () => {
    // One 4-hour session built from four touching 1-hour rows.
    const rows = [0, 1, 2, 3].map(i =>
      s(`r${i}`, 'b1', 'm1',
        `2026-08-25T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        `2026-08-25T${String(11 + i).padStart(2, '0')}:00:00.000Z`),
    )
    const blocks = buildPrepBlocks(rows)
    expect(blocks).toHaveLength(1)               // one arrival
    expect(blocks[0].durationMinutes).toBe(60)   // one paid hour
  })
})

describe('prepBlockCents — money (moderator\'s own rate)', () => {
  it('is rate × duration / 60 with standard rounding (payout.ts convention)', () => {
    expect(PREP_DURATION_MINUTES).toBe(30)
    expect(prepBlockCents(2000, 30)).toBe(1000) // $20/hr → $10 per half hour
    expect(prepBlockCents(3000, 30)).toBe(1500) // $30/hr → $15
    expect(prepBlockCents(3333, 30)).toBe(1667) // Math.round(1666.5)
    expect(prepBlockCents(0, 30)).toBe(0)
  })

  // The length changed to 60 minutes on PREP_DURATION_CUTOFF_ISO (the support team,
  // 2026-09-04 — moderators arrive a full hour early, not half of one).
  it('prices a 60-minute block at a full hour of the rate', () => {
    expect(PREP_DURATION_MINUTES_V2).toBe(60)
    expect(prepBlockCents(2000, 60)).toBe(2000) // $20/hr → $20
    expect(prepBlockCents(3333, 60)).toBe(3333)
    // Double the duration is NOT always double the pay, and that is correct:
    // each block rounds independently (round-per-item-then-sum, rule 22). At
    // $33.33/hr the half-hour block rounds UP to 1667c, so twice that is 3334c
    // while the true hour is 3333c. Asserted rather than glossed, because a
    // future reader would otherwise "fix" this into a doubling.
    expect(prepBlockCents(3333, 30)).toBe(1667)
    expect(prepBlockCents(3333, 60)).toBe(3333)
    for (const rate of [2000, 2500, 3000, 4400]) {
      expect(prepBlockCents(rate, 60)).toBe(prepBlockCents(rate, 30) * 2)
    }
  })

  it('at 30 minutes, per-block pay equals the old setupBonusCents at the same rate', () => {
    // The supersede changes SCOPE (per-session vs first-of-day), never the
    // per-block amount — setupBonusCents(rate) === Math.round(rate/2).
    for (const rate of [2000, 2500, 3000, 3333, 4400]) {
      expect(prepBlockCents(rate, 30)).toBe(Math.round(rate / 2))
    }
  })
})

describe('buildPrepBlocks — boundary instant compare (DB +00:00 vs .000Z)', () => {
  // Regression: the DB renders timestamps as "...+00:00" while cutoff/window
  // bounds are ".000Z". A raw string compare misfires at an exact boundary
  // midnight because '+' (0x2B) sorts before '.' (0x2E). Every fixture here
  // uses the +00:00 form on the session side, .000Z on the bound side — the
  // real-world mix — so a lexical compare would fail these.
  const CUT = '2026-08-01T00:00:00.000Z'

  it('session starting EXACTLY at the cutoff instant (+00:00 form) is post-cutoff → gets a prep block', () => {
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-08-01T00:00:00+00:00', '2026-08-01T01:00:00+00:00')],
      { cutoffISO: CUT },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
  })

  it('session one ms before the cutoff is pre-cutoff → no block', () => {
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-07-31T23:59:59.999+00:00', '2026-08-01T00:59:59.999+00:00')],
      { cutoffISO: CUT },
    )
    expect(blocks).toHaveLength(0)
  })

  it('setupBonusApplies mirrors the cutoff gate at the REAL cutoff instant (no double pay)', () => {
    // A session starting exactly at PREP_CUTOFF_ISO must be post-cutoff on
    // BOTH the prep gate AND setupBonusApplies — otherwise the '+00:00' vs
    // '.000Z' string sort could hand that one instant a prep block AND the
    // old bonus. Uses the real cutoff in +00:00 form so it holds at any
    // deploy date. Skipped only if the feature is disabled.
    if (!PREP_TIME_ENABLED) return
    const cutoffPlus = PREP_CUTOFF_ISO.replace('.000Z', '+00:00')
    const cutoffMs = new Date(PREP_CUTOFF_ISO).getTime()
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', cutoffPlus, new Date(cutoffMs + 3_600_000).toISOString())],
      { cutoffISO: PREP_CUTOFF_ISO },
    )
    expect(blocks).toHaveLength(1) // prep gate: included (post-cutoff)
    expect(setupBonusApplies(cutoffPlus)).toBe(false) // old bonus: excluded
    // A stream well before the cutoff still keeps the old bonus.
    expect(setupBonusApplies('2000-01-01T00:00:00+00:00')).toBe(true)
  })

  it('window fromISO is INCLUSIVE at an exact boundary midnight (+00:00 session)', () => {
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-09-01T00:00:00+00:00', '2026-09-01T01:00:00+00:00')],
      { window: { fromISO: '2026-09-01T00:00:00.000Z', toExclusiveISO: '2026-10-01T00:00:00.000Z' } },
    )
    expect(blocks).toHaveLength(1)
  })

  it('window toExclusiveISO EXCLUDES a session starting exactly at next-month midnight (no cross-month double count)', () => {
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-10-01T00:00:00+00:00', '2026-10-01T01:00:00+00:00')],
      { window: { fromISO: '2026-09-01T00:00:00.000Z', toExclusiveISO: '2026-10-01T00:00:00.000Z' } },
    )
    expect(blocks).toHaveLength(0)
  })
})

describe('beforeOpenMarkerStartISO — DST-proof marker placement (calendar)', () => {
  // Regression: the marker used to be computed with a local-tz setHours + ms
  // add, which drifts ±1h on PT DST-transition days for viewers whose browser
  // observes Pacific time. Pure-UTC math must return the brand-open instant on
  // the session's own calendar day, identical under ANY machine timezone.
  it('spring-forward day (2026-03-08): 10:00 open → 10:00, not 11:00', () => {
    expect(beforeOpenMarkerStartISO('2026-03-08T12:00:00.000Z', 600))
      .toBe('2026-03-08T10:00:00.000Z')
  })

  it('fall-back day (2026-11-01): 10:00 open → 10:00, not 09:00', () => {
    expect(beforeOpenMarkerStartISO('2026-11-01T12:00:00.000Z', 600))
      .toBe('2026-11-01T10:00:00.000Z')
  })

  it('accepts the DB "+00:00" form and keeps the session calendar day', () => {
    expect(beforeOpenMarkerStartISO('2026-07-14T18:00:00+00:00', 720))
      .toBe('2026-07-14T12:00:00.000Z')
  })

  it('midnight-open (0) and half-hour opens map exactly', () => {
    expect(beforeOpenMarkerStartISO('2026-07-14T00:00:00.000Z', 0))
      .toBe('2026-07-14T00:00:00.000Z')
    expect(beforeOpenMarkerStartISO('2026-07-14T12:00:00.000Z', 630))
      .toBe('2026-07-14T10:30:00.000Z')
  })
})

describe('buildPrepBlocks — pay stays a flat 30 min across a DST-transition day', () => {
  // Money path is pure epoch math (no tz conversion), so a session straddling
  // a PT DST transition still earns exactly one 30-minute prep block.
  it('spring-forward session yields one block, prep window exactly 30 min', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-03-08T02:30:00.000Z', '2026-03-08T05:30:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    const durMin =
      (new Date(blocks[0].endISO).getTime() - new Date(blocks[0].startISO).getTime()) / 60_000
    expect(durMin).toBe(PREP_DURATION_MINUTES)
    expect(blocks[0].startISO).toBe('2026-03-08T02:00:00.000Z')
    expect(blocks[0].endISO).toBe('2026-03-08T02:30:00.000Z')
  })
})
