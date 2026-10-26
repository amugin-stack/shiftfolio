// Cross-surface money INVARIANTS for the prep-time feature.
//
// This file does NOT re-test the unit behavior already covered by
// prepTime.test.ts / prepTime.edge.test.ts / setupBonus.test.ts /
// payrollExport.test.ts. It builds ONE rich synthetic dataset spanning
// PREP_CUTOFF_ISO and asserts structural invariants that must hold across
// every pay surface simultaneously:
//   1. PARTITION       — no stream is ever paid by both the old setup-bonus
//                        rule and the new prep rule.
//   2. EQUIVALENCE      — prepBlockCents(rate) === setupBonusCents(rate).
//   3. CSV TOTALS       — buildModeratorRows' amountCents/prepCents/prepHours
//                        equal an independently hand-computed sum.
//   4. KILL-SWITCH SEMANTICS — computePrepBlocks output is a subset of the
//                        raw (no-cutoff) buildPrepBlocks output; every block
//                        the cutoff removes started before PREP_CUTOFF_ISO.
//   5. REALIZED ⊆ EXPECTED — amountCents only grows as `now` advances
//                        (monotonic realization of completed work).
//
// All expected numbers below are hand-computed literals (see the arithmetic
// comments) — the test never derives an expectation from the modules under
// test.

import { describe, it, expect } from 'vitest'
import {
  buildPrepBlocks,
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
  PREP_CUTOFF_ISO,
  type PrepBlock,
} from '@/lib/prepTime'
import { findSetupBonusStreamIds, setupBonusCents } from '@/lib/setupBonus'
import { buildModeratorRows, type ModeratorStreamInput } from '@/lib/payrollExport'

// ---------------------------------------------------------------------------
// Synthetic dataset: 3 moderators, 2 brands, 11 streams, spanning
// PREP_CUTOFF_ISO (all dates below are defined relative to it).
// ---------------------------------------------------------------------------

const MOD1 = { id: 'mod1', name: 'Mod One', rate_cents: 3000 } // $30.00/hr
const MOD2 = { id: 'mod2', name: 'Mod Two', rate_cents: 2400 } // $24.00/hr
const MOD3 = { id: 'mod3', name: 'Mod Three', rate_cents: 4500 } // $45.00/hr

function stream(
  id: string,
  brand_id: string,
  mod: typeof MOD1,
  start_time: string,
  end_time: string,
): ModeratorStreamInput {
  return { id, brand_id, moderator_id: mod.id, moderator: { name: mod.name, rate_cents: mod.rate_cents }, start_time, end_time }
}

// All fixture dates are RELATIVE to PREP_CUTOFF_ISO, so this test tracks the
// production cutoff instead of hardcoding a parallel copy of it (the exact
// coupling that let a cutoff change silently break these invariants).
// iso(d, h, m) = the instant d whole days from the cutoff midnight at h:m UTC
// (PT-naive). Only the pre/post-cutoff SPLIT and durations drive the expected
// numbers below, so they stay valid at any cutoff.
const C = new Date(PREP_CUTOFF_ISO).getTime()
const DAY = 86_400_000
function iso(dayOffset: number, hh: number, mm = 0): string {
  const d = new Date(C + dayOffset * DAY)
  d.setUTCHours(hh, mm, 0, 0)
  return d.toISOString()
}

const streams: ModeratorStreamInput[] = [
  // --- mod3, PRE-cutoff (−7d), brandA: first-of-day bonus winner (s0) + a
  //     same-day non-first, non-adjacent stream (s10: never a bonus winner
  //     since s0 claims that slot; not suppressed either since s0's end
  //     (10:00) doesn't reach s10's 30-min prep window [10:30,11:00)) ---
  stream('s0', 'brandA', MOD3, iso(-7, 9), iso(-7, 10)),
  stream('s10', 'brandA', MOD3, iso(-7, 11), iso(-7, 12)),

  // --- mod1, PRE-cutoff (−6d) first-of-day bonus winner ---
  stream('s1', 'brandA', MOD1, iso(-6, 9), iso(-6, 10)),

  // --- mod1, POST-cutoff session straddling the reporting-window boundary:
  //     s7 starts on the cutoff day at 23:30 (≥ cutoff), s8 is the next-day
  //     continuation. Under WINDOW_B, s7 is lookback-only context. ---
  stream('s7', 'brandB', MOD1, iso(0, 23, 30), iso(1, 0)),
  stream('s8', 'brandB', MOD1, iso(1, 0), iso(1, 1)),

  // --- mod2, POST-cutoff (+1d) multi-row (2-stream) session ---
  stream('s2', 'brandA', MOD2, iso(1, 9), iso(1, 10)),
  stream('s3', 'brandA', MOD2, iso(1, 10), iso(1, 11)),

  // --- mod3, POST-cutoff (+2d) cross-brand back-to-back suppression: s4
  //     (brandA) ends exactly when s5's (brandB) prep window would start, so
  //     s5's session prep is suppressed ---
  stream('s4', 'brandA', MOD3, iso(2, 8, 30), iso(2, 9)),
  stream('s5', 'brandB', MOD3, iso(2, 9), iso(2, 10)),

  // --- mod2, POST-cutoff (+3d) standalone session ---
  stream('s9', 'brandA', MOD2, iso(3, 14), iso(3, 15)),

  // --- mod1, POST-cutoff (+14d) standalone session that is FUTURE (unfinished)
  //     as of NOW_MID, completed as of NOW_LATE ---
  stream('s6', 'brandA', MOD1, iso(14, 9), iso(14, 10)),
]

const NOW_VERY_EARLY = new Date(iso(-15, 0)).getTime() // nothing completed yet
const NOW_MID = new Date(iso(9, 0)).getTime() // s6 (+14d) still in the future
const NOW_LATE = new Date(iso(30, 0)).getTime() // everything completed

// Loose window covering the whole dataset (no lookback exclusions).
const WINDOW_ALL = { fromISO: iso(-15, 0), toExclusiveISO: iso(41, 0) }
// Window starting the day after the cutoff — isolates the s7/s8 straddle:
// s7 (cutoff day 23:30) becomes a lookback-only row and the {s7,s8} session is
// excluded from prep entirely because its session start precedes fromISO.
const WINDOW_B = { fromISO: iso(1, 0), toExclusiveISO: iso(41, 0) }

function amountOf(rows: ReturnType<typeof buildModeratorRows>, name: string): number {
  return rows.find(r => r.name === name)?.amountCents ?? 0
}

// ---------------------------------------------------------------------------
// 1. PARTITION — bonus-applies-true streams and prep-block member streams
//    are disjoint.
// ---------------------------------------------------------------------------

describe('invariant 1 — PARTITION (bonus vs prep never both pay the same stream)', () => {
  it('bonusApplies-true ∩ prep-block member streams = ∅', () => {
    const bonusIds = findSetupBonusStreamIds(streams)
    // Only pre-cutoff bonus winners still actually pay under the gate.
    const bonusAppliesTrue = new Set(
      streams.filter(s => bonusIds.has(s.id) && setupBonusApplies(s.start_time)).map(s => s.id),
    )
    // Sanity: exactly the two pre-cutoff first-of-day winners (s0, s1).
    expect(bonusAppliesTrue).toEqual(new Set(['s0', 's1']))

    const blocks = computePrepBlocks(streams) // no window: full-history view
    // Derive each block's member streams independently (not via module
    // internals): same moderator + brand, start/end inside the session span.
    const prepMemberIds = new Set<string>()
    for (const b of blocks) {
      for (const s of streams) {
        if (
          s.moderator_id === b.moderatorId
          && s.brand_id === b.brandId
          && s.start_time >= b.sessionStartISO
          && s.end_time <= b.sessionEndISO
        ) {
          prepMemberIds.add(s.id)
        }
      }
    }
    // Sanity: matches hand analysis — s5 is suppressed (no block), s10 is
    // suppressed too, s0/s1 are pre-cutoff (no block).
    expect(prepMemberIds).toEqual(new Set(['s2', 's3', 's4', 's9', 's6', 's7', 's8']))

    const intersection = Array.from(bonusAppliesTrue).filter(id => prepMemberIds.has(id))
    expect(intersection).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. EQUIVALENCE — prepBlockCents(rate) === setupBonusCents(rate) for every
//    rate in play (the 3 moderator rates plus rounding-edge rates).
// ---------------------------------------------------------------------------

describe('invariant 2 — EQUIVALENCE (prep block pays exactly what the old bonus paid)', () => {
  it.each([MOD1.rate_cents, MOD2.rate_cents, MOD3.rate_cents, 0, 1, 2501, 33333, 100000])(
    'prepBlockCents(%i) === setupBonusCents(%i)',
    rate => {
      // Explicitly 30: this invariant is about the ORIGINAL block length,
      // which is what the pre-cutoff sessions in this dataset still use.
      expect(prepBlockCents(rate, 30)).toBe(setupBonusCents(rate))
    },
  )
})

// ---------------------------------------------------------------------------
// 3. CSV TOTALS — buildModeratorRows amounts equal an independent
//    hand-computed sum: live-rate pay (completed, in-window) + pre-cutoff
//    completed bonuses + completed-session windowed prep blocks.
// ---------------------------------------------------------------------------

describe('invariant 3 — CSV totals equal hand-computed live + bonus + prep sums', () => {
  it('WINDOW_ALL @ NOW_MID: mod3 = live(s0+s10+s4+s5) + bonus(s0) + prep(s4)', () => {
    const rows = buildModeratorRows(streams, NOW_MID, WINDOW_ALL)
    const row = rows.find(r => r.name === MOD3.name)!
    // live: s0 1h*4500=4500, s10 1h*4500=4500, s4 0.5h*4500=2250, s5 1h*4500=4500 → 18000
    // bonus: s0 is BrandA/07-09 first-of-day, pre-cutoff → +round(4500/2)=2250
    // prep: s4 standalone completed session → prepBlockCents(4500)=2250; s5 suppressed → 0
    const expectedAmount = 4500 + 4500 + 2250 + 4500 + 2250 + 2250
    expect(expectedAmount).toBe(20250)
    expect(row.amountCents).toBe(20250)
    // minutes: 60+60+30+60 live + 30 bonus + 30 prep = 270 → 4.5h
    expect(row.totalHours).toBeCloseTo(4.5, 6)
    expect(row.prepCents).toBe(2250)
    expect(row.prepHours).toBeCloseTo(0.5, 6)
  })

  it('WINDOW_ALL @ NOW_MID: mod1 = live(s1+s7+s8, s6 excluded-future) + bonus(s1) + prep({s7,s8})', () => {
    const rows = buildModeratorRows(streams, NOW_MID, WINDOW_ALL)
    const row = rows.find(r => r.name === MOD1.name)!
    // live: s1 1h*3000=3000, s7 0.5h*3000=1500, s8 1h*3000=3000 → 7500 (s6 not completed yet)
    // bonus: s1 is BrandA/07-10 first-of-day, pre-cutoff → +round(3000/2)=1500
    // prep: {s7,s8} session (post-cutoff, sessionStart 07-16T23:30 ≥ cutoff, in
    //   WINDOW_ALL, completed by NOW_MID) → prepBlockCents(3000)=1500
    //   s6's own session exists but its sessionEnd (07-30T10:00) > NOW_MID → excluded
    const expectedAmount = 3000 + 1500 + 3000 + 1500 + 1500
    expect(expectedAmount).toBe(10500)
    expect(row.amountCents).toBe(10500)
    // minutes: 60+30+60 live + 30 bonus + 30 prep = 210 → 3.5h
    expect(row.totalHours).toBeCloseTo(3.5, 6)
    expect(row.prepCents).toBe(1500)
    expect(row.prepHours).toBeCloseTo(0.5, 6)
  })

  it('WINDOW_ALL @ NOW_MID: mod2 = live(s2+s3+s9) + bonus(none, all post-cutoff) + prep({s2,s3}+{s9})', () => {
    const rows = buildModeratorRows(streams, NOW_MID, WINDOW_ALL)
    const row = rows.find(r => r.name === MOD2.name)!
    // live: s2 1h*2400=2400, s3 1h*2400=2400, s9 1h*2400=2400 → 7200 (no bonus: all post-cutoff)
    // prep: {s2,s3} session → prepBlockCents(2400)=1200; s9 standalone session → 1200
    const expectedAmount = 2400 + 2400 + 2400 + 1200 + 1200
    expect(expectedAmount).toBe(9600)
    expect(row.amountCents).toBe(9600)
    // minutes: 60*3 live + 30 + 30 prep = 240 → 4.0h
    expect(row.totalHours).toBeCloseTo(4.0, 6)
    expect(row.prepCents).toBe(2400)
    expect(row.prepHours).toBeCloseTo(1.0, 6)
  })

  it('WINDOW_B @ NOW_MID (fromISO = day after cutoff): straddling session pays live AND prep, once', () => {
    const rows = buildModeratorRows(streams, NOW_MID, WINDOW_B)
    const mod1Row = rows.find(r => r.name === MOD1.name)!
    // Windows are keyed on END time, so a shift is paid in the period it
    // FINISHES in — exactly once, with no seam day shared between periods.
    //
    //   s7  07-16 23:30 -> 07-17 00:00  ends exactly AT WINDOW_B.fromISO.
    //       In this window (end >= from); NOT in the previous one, whose
    //       exclusive end is that same instant. 0.5h * 3000 = 1500.
    //   s8  07-17 00:00 -> 07-17 01:00  1h * 3000 = 3000.
    //   {s7,s8} is one contiguous session ENDING 07-17 01:00, inside the
    //       window, so its prep block is minted here: 0.5h * 3000 = 1500.
    //   s6  not completed at NOW_MID -> 0.
    //
    // This previously expected 3000 with no prep, because attribution keyed
    // off the session START (07-16, before the window). That only worked while
    // queries windowed on start_time. Once they window on end_time the prior
    // period never sees this session at all, so start-attribution left both
    // s7's live pay and the session's prep unpaid by ANY period.
    expect(mod1Row.amountCents).toBe(1500 + 3000 + 1500)
    expect(mod1Row.amountCents).toBe(6000)
    expect(mod1Row.totalHours).toBeCloseTo(2.0, 6)
    expect(mod1Row.prepCents).toBe(1500)
    expect(mod1Row.prepHours).toBeCloseTo(0.5, 6)

    const mod3Row = rows.find(r => r.name === MOD3.name)!
    // s0/s10 (07-09) are lookback-excluded under WINDOW_B (start < 07-17).
    // live: s4 0.5h*4500=2250, s5 1h*4500=4500 → 6750; prep: s4 only → 2250
    expect(mod3Row.amountCents).toBe(2250 + 4500 + 2250)
    expect(mod3Row.amountCents).toBe(9000)

    const mod2Row = rows.find(r => r.name === MOD2.name)!
    // mod2 has no streams before WINDOW_B.fromISO, so it is unaffected.
    expect(mod2Row.amountCents).toBe(9600)
  })
})

// ---------------------------------------------------------------------------
// 4. KILL-SWITCH SEMANTICS — computePrepBlocks ⊆ raw buildPrepBlocks (no
//    cutoff); every excluded block started before PREP_CUTOFF_ISO.
// ---------------------------------------------------------------------------

describe('invariant 4 — kill switch / cutoff semantics', () => {
  it('computePrepBlocks(streams) output ⊆ buildPrepBlocks(streams, {}) output', () => {
    const raw = buildPrepBlocks(streams, {}) // no cutoffISO: the "always-bonus" rule off
    const computed = computePrepBlocks(streams) // production entrypoint: cutoff applied

    const rawByAnchor = new Map<string, PrepBlock>(raw.map(b => [b.anchorId, b]))
    // Subset check: every computed block exists, byte-for-byte, in raw.
    for (const b of computed) {
      expect(rawByAnchor.has(b.anchorId)).toBe(true)
      expect(rawByAnchor.get(b.anchorId)).toEqual(b)
    }

    // Sanity: raw has exactly 3 more blocks than computed — s0, s10, s1's
    // pre-cutoff sessions. s10's prep window is [10:30,11:00) (30 min, not
    // 60): s0 ends at 10:00, which does NOT touch/overlap it, so s10 is its
    // OWN unsuppressed session in both views (it just isn't a bonus winner,
    // since s0 is (brandA,07-09,mod3)'s first stream). s5 remains suppressed
    // in BOTH views (suppression is cutoff-independent).
    expect(raw.length).toBe(8) // s0, s10, s1, {s2,s3}, s4, s9, s6, {s7,s8}
    expect(computed.length).toBe(5) // {s2,s3}, s4, s9, s6, {s7,s8}

    const computedAnchors = new Set(computed.map(b => b.anchorId))
    const excluded = raw.filter(b => !computedAnchors.has(b.anchorId))
    expect(excluded.map(b => b.anchorId).sort()).toEqual(['s0', 's1', 's10'])
    for (const b of excluded) {
      expect(b.sessionStartISO < PREP_CUTOFF_ISO).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. REALIZED ⊆ EXPECTED — amountCents is monotonically non-decreasing as
//    `now` advances (a stream/session can only go from unrealized to
//    realized, never back).
// ---------------------------------------------------------------------------

describe('invariant 5 — monotonic realization', () => {
  it('amount(now=veryEarly) <= amount(now=mid) <= amount(now=late) for every moderator', () => {
    const early = buildModeratorRows(streams, NOW_VERY_EARLY, WINDOW_ALL)
    const mid = buildModeratorRows(streams, NOW_MID, WINDOW_ALL)
    const late = buildModeratorRows(streams, NOW_LATE, WINDOW_ALL)

    for (const name of [MOD1.name, MOD2.name, MOD3.name]) {
      const a = amountOf(early, name)
      const m = amountOf(mid, name)
      const l = amountOf(late, name)
      expect(a).toBeLessThanOrEqual(m)
      expect(m).toBeLessThanOrEqual(l)
    }

    // Sanity on the concrete numbers: nothing has completed at NOW_VERY_EARLY.
    expect(early).toEqual([])
    // mod2/mod3 are already fully realized by NOW_MID (no change at NOW_LATE);
    // mod1 gains s6's live pay (3000) + s6's prep block (1500) = 4500 more.
    expect(amountOf(mid, MOD2.name)).toBe(amountOf(late, MOD2.name))
    expect(amountOf(mid, MOD3.name)).toBe(amountOf(late, MOD3.name))
    expect(amountOf(late, MOD1.name) - amountOf(mid, MOD1.name)).toBe(4500)
    expect(amountOf(late, MOD1.name)).toBe(15000)
  })
})
