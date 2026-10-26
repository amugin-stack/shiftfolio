// Adversarial attack-angle tests for buildPrepBlocks/computePrepBlocks.
//
// This file does NOT re-cover what prepTime.test.ts / prepTime.edge.test.ts /
// prepTime.consistency.test.ts already assert. Every test below targets an
// angle none of those three files exercise: three-brand suppression chains
// where the middle session's fate is decided independently of its
// neighbors, non-contiguous session membership after moderator interleaving,
// corrupted end-before-start rows, very long sessions, a multi-row zero-gap
// prior session suppressing a brand-new next session, exact-equality window
// boundaries (inclusive lower / exclusive upper), moderator_id '' vs null,
// and sort-order stability across many same-instant blocks.

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
// 1. Three-brand chains: the middle session's suppression is decided by a
//    direct scan over ALL of the moderator's streams, not by "does the chain
//    of blocks propagate" — so a middle session can suppress (or fail to
//    suppress) independently of whether ITS OWN block survived.
// ---------------------------------------------------------------------------
describe('three-brand chains — middle session suppression is evaluated independently', () => {
  it('cascading suppression: session1 survives, sessions 2 AND 3 are both suppressed by reaching back past the middle session', () => {
    // a: brand1 08:00-09:00, b: brand2 09:00-09:05 (touches a), c: brand3 09:05-10:00 (touches b).
    // b is suppressed by a (a's real end 09:00 covers b's prep window [08:30,09:00]).
    // c is suppressed too — and NOT merely "because b was suppressed": c's prep
    // window [08:35,09:05] is directly covered by a's own span (08:00-09:00),
    // independent of b's fate.
    const blocks = buildPrepBlocks([
      s('a', 'brand1', 'm1', '2026-08-01T08:00:00.000Z', '2026-08-01T09:00:00.000Z'),
      s('b', 'brand2', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T09:05:00.000Z'),
      s('c', 'brand3', 'm1', '2026-08-01T09:05:00.000Z', '2026-08-01T10:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['a'])
  })

  it('broken middle: session1 unsuppressed, session2 suppressed by session1, session3 UNsuppressed because its gap from session2 is >=30min', () => {
    // a: brand1 08:00-08:30. b: brand2 08:30-08:35 (touches a -> suppressed by a).
    // c: brand3 09:10-10:00 -- 35 minutes after b ends (08:35) and 40 minutes
    // after a ends (08:30) -- neither a nor b reaches c's prep window
    // [08:40,09:10], so c is NOT suppressed even though b (its immediate
    // predecessor in time) got suppressed itself. Suppression does not chain.
    const blocks = buildPrepBlocks([
      s('a', 'brand1', 'm1', '2026-08-01T08:00:00.000Z', '2026-08-01T08:30:00.000Z'),
      s('b', 'brand2', 'm1', '2026-08-01T08:30:00.000Z', '2026-08-01T08:35:00.000Z'),
      s('c', 'brand3', 'm1', '2026-08-01T09:10:00.000Z', '2026-08-01T10:00:00.000Z'),
    ])
    expect(blocks.map(b => b.anchorId)).toEqual(['a', 'c'])
  })
})

// ---------------------------------------------------------------------------
// 2. A prior session that is ITSELF a multi-row zero-gap chain still
//    suppresses the very next (different-brand) session as a single unit.
// ---------------------------------------------------------------------------
describe('prep suppression when the prior shift is itself a zero-gap chain', () => {
  it('a 3-row touching session (one merged session, one block) suppresses the next brand session it touches', () => {
    const blocks = buildPrepBlocks([
      s('a', 'brand1', 'm1', '2026-08-01T08:00:00.000Z', '2026-08-01T08:20:00.000Z'),
      s('b', 'brand1', 'm1', '2026-08-01T08:20:00.000Z', '2026-08-01T08:40:00.000Z'),
      s('c', 'brand1', 'm1', '2026-08-01T08:40:00.000Z', '2026-08-01T09:00:00.000Z'),
      s('d', 'brand2', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z'),
    ])
    // Only the merged {a,b,c} session survives, as ONE block anchored on 'a'
    // spanning the full chain; 'd' is suppressed by 'c' touching its start.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('a')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T09:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// 3. Session members that are NOT contiguous in the input array, with a
//    different moderator's rows interleaved between them (and everything
//    shuffled out of chronological order too).
// ---------------------------------------------------------------------------
describe('non-contiguous session membership after moderator interleaving', () => {
  it('an m1 3-row session interleaved with m2 noise, all scrambled, still merges into one m1 session and produces independent m2 blocks', () => {
    const a = s('a', 'B1', 'm1', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z')
    const b = s('b', 'B1', 'm1', '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z')
    const c = s('c', 'B1', 'm1', '2026-08-01T11:00:00.000Z', '2026-08-01T12:00:00.000Z')
    const x = s('x', 'B9', 'm2', '2026-08-01T09:15:00.000Z', '2026-08-01T09:45:00.000Z')
    const y = s('y', 'B9', 'm2', '2026-08-01T11:05:00.000Z', '2026-08-01T11:35:00.000Z')

    // Deliberately out of chronological order AND interleaved across moderators.
    const blocks = buildPrepBlocks([b, x, c, y, a])

    expect(blocks).toHaveLength(3)
    const m1Block = blocks.find(bl => bl.moderatorId === 'm1')!
    expect(m1Block.anchorId).toBe('a')
    expect(m1Block.sessionStartISO).toBe('2026-08-01T09:00:00.000Z')
    expect(m1Block.sessionEndISO).toBe('2026-08-01T12:00:00.000Z')
    expect(m1Block.startISO).toBe('2026-08-01T08:30:00.000Z')

    const m2Anchors = blocks.filter(bl => bl.moderatorId === 'm2').map(bl => bl.anchorId).sort()
    expect(m2Anchors).toEqual(['x', 'y'])
  })
})

// ---------------------------------------------------------------------------
// 4. Corrupted end-before-start rows (DB CHECK `end_time > start_time`
//    prevents this in production — see supabase/migrations/001_initial_schema.sql
//    `valid_time_range` — but the pure function must not crash on bad data
//    from any other path, and its actual behavior here is worth pinning down).
// ---------------------------------------------------------------------------
describe('negative-duration (end before start) rows', () => {
  it('does not crash, and a normal session is correctly unsuppressed by a later corrupted row', () => {
    // 'normal' 14:00-15:30. 'neg' claims start 15:00, end 14:00 (-1h).
    // 'neg' starts AFTER 'normal' starts, so it can never reach back into
    // 'normal's prep window [13:30,14:00] -> 'normal' is unsuppressed.
    expect(() =>
      buildPrepBlocks([
        s('normal', 'bN', 'mN', '2026-08-01T14:00:00.000Z', '2026-08-01T15:30:00.000Z'),
        s('neg', 'bN', 'mN', '2026-08-01T15:00:00.000Z', '2026-08-01T14:00:00.000Z'),
      ]),
    ).not.toThrow()

    const blocks = buildPrepBlocks([
      s('normal', 'bN', 'mN', '2026-08-01T14:00:00.000Z', '2026-08-01T15:30:00.000Z'),
      s('neg', 'bN', 'mN', '2026-08-01T15:00:00.000Z', '2026-08-01T14:00:00.000Z'),
    ])
    // 'normal' unsuppressed (nothing precedes it into its prep window).
    // 'neg' IS suppressed: its own prep window [14:30,15:00] is covered by
    // 'normal's real span (14:00-15:30), which is exactly the scenario the
    // suppression rule exists for (moderator already on set).
    expect(blocks.map(b => b.anchorId)).toEqual(['normal'])
  })

  it('DOCUMENTS a defensive gap: a negative-duration row that starts inside a later session\'s prep window fails to suppress it', () => {
    // 'neg2' claims start 14:45 (which sits INSIDE the prep window below) but
    // end 14:00 (before its own start). The suppression check tests
    // `sEnd >= prepStartMs`; with sEnd=14:00 < prepStart=14:30, 'neg2' is
    // silently treated as if it ended before the window, so it fails to
    // suppress 'real' even though intuitively the moderator was doing
    // *something* at 14:45. This is unreachable in production because the
    // `valid_time_range` CHECK constraint (end_time > start_time) guarantees
    // sEnd >= sStart for every row the DB will ever hand back — recorded here
    // purely as a pinned defensive-robustness fact, not a required fix.
    //
    // 'neg2' also forms its own (nonsensical, sessionEnd-before-sessionStart)
    // one-row session, and since 'real' starts AFTER 'neg2' it can't reach
    // back to suppress 'neg2' either — so both rows independently survive as
    // blocks. The finding is specifically that 'real' is NOT suppressed by
    // 'neg2', which is what a corrupted row should not be able to escape.
    const blocks = buildPrepBlocks([
      s('neg2', 'bX', 'mX', '2026-08-01T14:45:00.000Z', '2026-08-01T14:00:00.000Z'),
      s('real', 'bY', 'mX', '2026-08-01T15:00:00.000Z', '2026-08-01T16:00:00.000Z'),
    ])
    const realBlock = blocks.find(b => b.anchorId === 'real')
    expect(realBlock).toBeDefined() // documents the miss: 'real' escapes suppression
    expect(blocks.map(b => b.anchorId).sort()).toEqual(['neg2', 'real'])
  })
})

// ---------------------------------------------------------------------------
// 5. Extremely long sessions still yield exactly one block.
// ---------------------------------------------------------------------------
describe('extremely long sessions', () => {
  it('a single 12-hour stream yields exactly one block spanning the full session', () => {
    const blocks = buildPrepBlocks([
      s('long', 'bLong', 'mLong', '2026-08-02T06:00:00.000Z', '2026-08-02T18:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('long')
    expect(blocks[0].sessionStartISO).toBe('2026-08-02T06:00:00.000Z')
    expect(blocks[0].sessionEndISO).toBe('2026-08-02T18:00:00.000Z')
    expect(blocks[0].startISO).toBe('2026-08-02T05:30:00.000Z')
  })

  it('24 chained half-hour rows spanning 12 hours merge into exactly one session/block', () => {
    const base = Date.UTC(2026, 7, 1, 6, 0, 0) // 2026-08-01T06:00:00.000Z
    const segMs = 30 * 60_000
    const rows: PrepStreamInput[] = []
    for (let i = 0; i < 24; i++) {
      rows.push(
        s(
          `seg${i}`,
          'bChain',
          'mChain',
          new Date(base + i * segMs).toISOString(),
          new Date(base + (i + 1) * segMs).toISOString(),
        ),
      )
    }
    const blocks = buildPrepBlocks(rows)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('seg0')
    expect(blocks[0].sessionStartISO).toBe('2026-08-01T06:00:00.000Z')
    expect(blocks[0].sessionEndISO).toBe('2026-08-01T18:00:00.000Z')
    expect(blocks[0].startISO).toBe('2026-08-01T05:30:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// 6. Window boundary exact-equality: fromISO is an INCLUSIVE lower bound,
//    toExclusiveISO is an EXCLUSIVE upper bound — asserted at exact equality,
//    which none of the existing window tests exercise (they all use margin).
// ---------------------------------------------------------------------------
describe('window boundaries at exact equality', () => {
  it('a session starting exactly AT window.fromISO is included (inclusive lower bound)', () => {
    const blocks = buildPrepBlocks(
      [s('atFrom', 'b1', 'm1', '2026-08-05T00:00:00.000Z', '2026-08-05T01:00:00.000Z')],
      { window: { fromISO: '2026-08-05T00:00:00.000Z' } },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['atFrom'])
  })

  it('a session starting exactly AT window.toExclusiveISO is excluded (exclusive upper bound)', () => {
    const blocks = buildPrepBlocks(
      [s('atToExclusive', 'b1', 'm1', '2026-08-06T00:00:00.000Z', '2026-08-06T01:00:00.000Z')],
      { window: { toExclusiveISO: '2026-08-06T00:00:00.000Z' } },
    )
    expect(blocks).toEqual([])
  })

  it('one instant apart: fromISO-equal session included, toExclusiveISO-equal session excluded, in the SAME call', () => {
    const blocks = buildPrepBlocks(
      [
        s('included', 'b1', 'm1', '2026-08-05T00:00:00.000Z', '2026-08-05T01:00:00.000Z'),
        s('excluded', 'b1', 'm2', '2026-08-06T00:00:00.000Z', '2026-08-06T01:00:00.000Z'),
      ],
      { window: { fromISO: '2026-08-05T00:00:00.000Z', toExclusiveISO: '2026-08-06T00:00:00.000Z' } },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['included'])
  })

  it('cutoffISO and window.fromISO both equal to the session start simultaneously -> included (both gates are ">= inclusive")', () => {
    const T = '2026-08-07T00:00:00.000Z'
    const blocks = buildPrepBlocks(
      [s('bothEqual', 'b1', 'm1', T, '2026-08-07T01:00:00.000Z')],
      { cutoffISO: T, window: { fromISO: T } },
    )
    expect(blocks.map(b => b.anchorId)).toEqual(['bothEqual'])
  })
})

// ---------------------------------------------------------------------------
// 7. moderator_id: '' (empty string) vs null. Only null is treated as
//    "unassigned" — the type is `string | null`, and the filter is a strict
//    `=== null` check, so '' is a distinct, valid grouping key.
// ---------------------------------------------------------------------------
describe("moderator_id '' vs null", () => {
  it('null moderator_id yields no block; empty-string moderator_id is treated as a real (if unusual) moderator id and yields one', () => {
    const blocks = buildPrepBlocks([
      s('nullmod', 'b1', null, '2026-08-01T08:00:00.000Z', '2026-08-01T09:00:00.000Z'),
      s('emptymod', 'b1', '', '2026-08-01T20:00:00.000Z', '2026-08-01T21:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].anchorId).toBe('emptymod')
    expect(blocks[0].moderatorId).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 8. Sort-order stability: many blocks sharing the exact same startISO
//    (prep-window start) across different brands/moderators must sort
//    deterministically by anchorId.
// ---------------------------------------------------------------------------
describe('blocks sort order stability with many same-start blocks across brands', () => {
  it('five independent moderators/brands all starting at the identical instant sort strictly by anchorId', () => {
    const T = '2026-08-01T10:00:00.000Z'
    const T_END = '2026-08-01T11:00:00.000Z'
    const rows: PrepStreamInput[] = [
      s('zulu', 'brandZ', 'mod_z', T, T_END),
      s('mike', 'brandM', 'mod_m', T, T_END),
      s('alpha', 'brandA', 'mod_a', T, T_END),
      s('delta', 'brandD', 'mod_d', T, T_END),
      s('bravo', 'brandB', 'mod_b', T, T_END),
    ]
    const blocks = buildPrepBlocks(rows)
    expect(blocks).toHaveLength(5)
    // All five ties share the exact same prep-window startISO ...
    expect(new Set(blocks.map(b => b.startISO)).size).toBe(1)
    // ... so the ONLY thing left to break the tie is anchorId, ascending.
    expect(blocks.map(b => b.anchorId)).toEqual(['alpha', 'bravo', 'delta', 'mike', 'zulu'])
  })
})
