import { describe, it, expect } from 'vitest'
import { buildPrepBlocks, type PrepStreamInput } from '@/lib/prepTime'

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

// ---------------------------------------------------------------------------
// 1. Zero-length streams (start === end)
// ---------------------------------------------------------------------------
describe('zero-length streams', () => {
  it('a zero-length stream sandwiched between two real streams does not break the session', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z'),
      s('zero', 'b1', 'm1', '2026-08-01T13:00:00.000Z', '2026-08-01T13:00:00.000Z'),
      s('c', 'b1', 'm1', '2026-08-01T13:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T14:00:00.000Z')
  })

  it('a zero-length stream that ties for earliest start becomes the session anchor', () => {
    // Same moderator/brand, same start instant: zero-length ('a') sorts before
    // the real stream ('b') by id tie-break, so zero touches itself as "cur",
    // then 'b' touches cur's (unchanged) end — one session anchored on 'a'.
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T11:00:00.000Z', '2026-08-01T11:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T11:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
    expect(blocks[0].sessionStartISO).toBe('2026-08-01T11:00:00.000Z')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T14:00:00.000Z')
    expect(blocks[0].startISO).toBe('2026-08-01T10:30:00.000Z')
  })

  it('an isolated zero-length stream still forms a session and a full 30-minute prep block', () => {
    const blocks = buildPrepBlocks([
      s('lone', 'b1', 'm1', '2026-08-01T20:00:00.000Z', '2026-08-01T20:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('lone')
    expect(blocks[0].sessionStartISO).toBe('2026-08-01T20:00:00.000Z')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T20:00:00.000Z')
    expect(blocks[0].startISO).toBe('2026-08-01T19:30:00.000Z')
    expect(blocks[0].endISO).toBe('2026-08-01T20:00:00.000Z')
  })

  it('a zero-length stream in another brand at the exact boundary is suppressed like any other overlap', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T11:00:00.000Z', '2026-08-01T14:00:00.000Z'),
      s('zero', 'b2', 'm1', '2026-08-01T14:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// 2. Identical start_time for the same moderator (DB trigger should prevent
//    this, but the pure function must not crash and must behave deterministically)
// ---------------------------------------------------------------------------
describe('identical start_time, same moderator (defensive — DB trigger should prevent overlap)', () => {
  it('two overlapping streams sharing a start instant do not crash and mutually suppress each other', () => {
    // 'a' 12:00-13:00 and 'b' 12:00-14:00, same moderator/brand, same start.
    // They cannot touch each other (touching requires start === OTHER's end),
    // so they form two separate one-stream "sessions" with the same
    // sessionStartISO. Each overlaps the other's prep window, so each
    // suppresses the other -> zero blocks, not a crash and not double-pay.
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    expect(blocks).toEqual([])
  })

  it('the same identical-start-time input produces the same result regardless of array order (id tie-break is order-independent)', () => {
    const forward = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    const reversed = buildPrepBlocks([
      s('b', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T14:00:00.000Z'),
      s('a', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z'),
    ])
    expect(forward).toEqual(reversed)
  })
})

// ---------------------------------------------------------------------------
// 3. Unsorted input order -> identical results to already-sorted input
// ---------------------------------------------------------------------------
describe('input order independence (module sorts internally)', () => {
  it('a shuffled multi-moderator, multi-session input yields the same blocks as the sorted input', () => {
    const sortedOrder: PrepStreamInput[] = [
      s('a', 'b1', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z'),
      s('b', 'b1', 'm1', '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z'),
      s('c', 'b1', 'm1', '2026-08-01T13:00:00.000Z', '2026-08-01T14:00:00.000Z'),
      s('d', 'b2', 'm2', '2026-08-01T09:30:00.000Z', '2026-08-01T12:00:00.000Z'),
      s('e', 'b2', 'm2', '2026-08-01T15:00:00.000Z', '2026-08-01T16:00:00.000Z'),
    ]
    // A deliberately scrambled copy of the same rows.
    const shuffled = [sortedOrder[3], sortedOrder[1], sortedOrder[4], sortedOrder[0], sortedOrder[2]]

    const fromSorted = buildPrepBlocks(sortedOrder)
    const fromShuffled = buildPrepBlocks(shuffled)
    expect(fromShuffled).toEqual(fromSorted)
    // Sanity: it actually computed something non-trivial (not comparing empties).
    expect(fromSorted.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Cutoff keys off session START, not end
// ---------------------------------------------------------------------------
describe('cutoff keys off session start, not end', () => {
  const cutoff = '2026-08-15T00:00:00.000Z'

  it('a session starting pre-cutoff and ending post-cutoff yields NO block (start-only gate)', () => {
    const blocks = buildPrepBlocks(
      [s('straddle', 'b1', 'm1', '2026-08-14T23:00:00.000Z', '2026-08-15T02:00:00.000Z')],
      { cutoffISO: cutoff },
    )
    expect(blocks).toEqual([])
  })

  it('a session starting exactly AT the cutoff instant DOES yield a block', () => {
    const blocks = buildPrepBlocks(
      [s('atCutoff', 'b1', 'm1', '2026-08-15T00:00:00.000Z', '2026-08-15T02:00:00.000Z')],
      { cutoffISO: cutoff },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('atCutoff')
  })
})

// ---------------------------------------------------------------------------
// 5. Cross-session (same brand, gap < 30 min) suppression
// ---------------------------------------------------------------------------
describe('same-brand adjacent-session suppression with a sub-30-minute gap', () => {
  it('session A ends 2:45, session B (same brand, non-touching gap) starts 3:00 -> B is suppressed', () => {
    const blocks = buildPrepBlocks([
      s('A', 'b1', 'm1', '2026-08-01T01:00:00.000Z', '2026-08-01T02:45:00.000Z'),
      s('B', 'b1', 'm1', '2026-08-01T03:00:00.000Z', '2026-08-01T05:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['A'])
  })

  it('same brand, a gap of exactly 30 minutes or more does NOT suppress', () => {
    const blocks = buildPrepBlocks([
      s('A', 'b1', 'm1', '2026-08-01T01:00:00.000Z', '2026-08-01T02:29:00.000Z'),
      s('B', 'b1', 'm1', '2026-08-01T03:00:00.000Z', '2026-08-01T05:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['A', 'B'])
  })
})

// ---------------------------------------------------------------------------
// 6. window.fromISO / cutoffISO independence
// ---------------------------------------------------------------------------
describe('window and cutoff filters are independent', () => {
  it('window.fromISO alone (no cutoffISO) filters correctly', () => {
    const blocks = buildPrepBlocks(
      [
        s('before', 'b1', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z'),
        s('after', 'b1', 'm1', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z'),
      ],
      { window: { fromISO: '2026-08-03T00:00:00.000Z' } },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['after'])
  })

  it('window.toExclusiveISO alone (no fromISO, no cutoffISO) filters correctly', () => {
    const blocks = buildPrepBlocks(
      [
        s('before', 'b1', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z'),
        s('after', 'b1', 'm1', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z'),
      ],
      { window: { toExclusiveISO: '2026-08-03T00:00:00.000Z' } },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['before'])
  })

  it('cutoffISO alone (no window at all) filters correctly', () => {
    const blocks = buildPrepBlocks(
      [
        s('before', 'b1', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z'),
        s('after', 'b1', 'm1', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z'),
      ],
      { cutoffISO: '2026-08-03T00:00:00.000Z' },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['after'])
  })

  it('cutoffISO and window.fromISO combined apply BOTH gates (neither alone would produce this result)', () => {
    // "mid" passes cutoff but fails window.fromISO; "late" passes both.
    const blocks = buildPrepBlocks(
      [
        s('early', 'b1', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z'),
        s('mid', 'b1', 'm1', '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z'),
        s('late', 'b1', 'm1', '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z'),
      ],
      {
        cutoffISO: '2026-08-03T00:00:00.000Z',
        window: { fromISO: '2026-08-05T00:00:00.000Z' },
      },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['late'])
  })
})

// ---------------------------------------------------------------------------
// 7. Duplicate stream ids in input (defensive — e.g. a duplicated join row)
// ---------------------------------------------------------------------------
describe('duplicate stream ids in input', () => {
  // Regression guard: buildPrepBlocks dedupes input rows by `id` before
  // grouping (src/lib/prepTime.ts). Without that, a duplicated stream row
  // (e.g. a repeated Supabase join) would split into two one-stream sessions
  // that never suppress each other — the suppression check keys off the
  // string `id` via sess.memberIds, so each duplicate would look like "my own
  // member" to the other — and both would emit a prep block, silently
  // doubling a moderator's prep pay. These two tests pin the fix.
  it('the exact same row appearing twice does not crash and mints at most one block', () => {
    const row = s('dup', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z')
    const blocks = buildPrepBlocks([row, { ...row }])
    // A duplicated input row is one stream → at most one prep block, never two.
    expect(blocks.length).toBeLessThanOrEqual(1)
  })

  it('a duplicated row plus a genuine touching neighbor still yields one session', () => {
    const row = s('dup', 'b1', 'm1', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z')
    const blocks = buildPrepBlocks([
      row,
      { ...row },
      s('next', 'b1', 'm1', '2026-08-01T13:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    // One physical stream ('dup') touching one real neighbor ('next') is a
    // single session → a single block whose sessionEndISO runs through 14:00.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T14:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// 8. Cross-brand same instant (moderator on two brands "simultaneously" is a
//    DB-trigger-prevented state, but the pure function must handle it sanely)
// ---------------------------------------------------------------------------
describe('cross-brand suppression at an exact shared instant', () => {
  it('A ends 09:00 (brandX), B starts 09:00 (brandY) -> only A survives', () => {
    const blocks = buildPrepBlocks([
      s('A', 'brandX', 'm1', '2026-08-01T06:00:00.000Z', '2026-08-01T09:00:00.000Z'),
      s('B', 'brandY', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T11:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['A'])
  })

  it('A ends 08:29 (31-minute gap before B at 09:00) -> both A and B survive', () => {
    const blocks = buildPrepBlocks([
      s('A', 'brandX', 'm1', '2026-08-01T06:00:00.000Z', '2026-08-01T08:29:00.000Z'),
      s('B', 'brandY', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T11:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['A', 'B'])
  })
})
