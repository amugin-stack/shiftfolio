// THROWAWAY audit test — timezone-correctness spot-check for prepTime.ts.
// Not part of the permanent suite; safe to delete after review.
//
// Claim under test: because the app's scheme is PT-naive (stored UTC fields
// ARE the PT wall-clock, no real offset ever applied — see src/lib/utils.ts
// header comment), the `sessStartMs - 30*60000` arithmetic in
// buildPrepBlocks is just integer ms subtraction on whatever numbers the
// ISO strings parse to. It never touches `America/Los_Angeles`, so a real
// PT DST transition (spring-forward 2026-03-08, fall-back 2026-11-01) is
// invisible to it — the 1970-epoch-ms distance between two UTC-labelled
// instants is DST-immune by construction. We assert exact ISO output on a
// nominal "DST date" session and on a midnight-crossing session, and confirm
// attribution keys off sessionStartISO even when the prep block's own
// startISO falls on the prior PT day.

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

describe('prepTime — TZ audit (throwaway)', () => {
  it('session starting 2026-03-08T02:30 (US spring-forward day) → prep at 02:00, pure naive ms math', () => {
    // 2026-03-08 is the real-world PT DST date (2am -> 3am). Under the
    // PT-naive scheme this date carries no special meaning to the code —
    // it's just another UTC-labelled instant. If ptWallClockToUtc /
    // ISO-parse ever grew a real offset lookup, 02:30 minus 30min could
    // jump to 01:00, 03:00, or throw on the "missing" 02:30 wall-clock.
    // It must not: expect exactly 02:00, same calendar day.
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-03-08T02:30:00.000Z', '2026-03-08T05:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startISO).toBe('2026-03-08T02:00:00.000Z')
    expect(blocks[0].endISO).toBe('2026-03-08T02:30:00.000Z')
    expect(blocks[0].sessionStartISO).toBe('2026-03-08T02:30:00.000Z')
  })

  it('session starting exactly at PT midnight → prep block lands on the PRIOR calendar day, but sessionStartISO (attribution key) stays on the new day', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-03-08T00:00:00.000Z', '2026-03-08T02:00:00.000Z'),
    ])
    expect(blocks).toHaveLength(1)
    // Prep tile itself is 23:30 the day before.
    expect(blocks[0].startISO).toBe('2026-03-07T23:30:00.000Z')
    expect(blocks[0].endISO).toBe('2026-03-08T00:00:00.000Z')
    // Attribution field (what every pay-surface window filter keys on)
    // stays on the session's own day, not the prep's day.
    expect(blocks[0].sessionStartISO).toBe('2026-03-08T00:00:00.000Z')
  })

  it('month-window fromISO gate filters on sessionStartISO, not the prep block startISO — a midnight session is INCLUDED even though its prep tile precedes the window start', () => {
    const monthStartISO = '2026-03-08T00:00:00.000Z' // window begins exactly at the session start
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-03-08T00:00:00.000Z', '2026-03-08T02:00:00.000Z')],
      { window: { fromISO: monthStartISO } },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startISO < monthStartISO).toBe(true) // prep tile IS before the window
    expect(blocks[0].sessionStartISO >= monthStartISO).toBe(true) // but session isn't, so it counts
  })

  it('the window gate reads the SESSION END, not the prep block\'s own start', () => {
    // Original intent of this test, preserved: prove the gate is not keyed off
    // the prep block's own startISO, which sits 30 min BEFORE the session and
    // would therefore still look in-window for a slightly later cut.
    //
    // What changed is which session instant gates it: END, not start, so a
    // prep block lands in the same pay period as the shift rows it belongs to
    // (payroll windows on end_time).
    //
    // Session 00:00 -> 02:00. Its prep block runs 23:30 -> 00:00 the day before.
    // A window starting just after the session START must still INCLUDE it,
    // because the session ends at 02:00, well inside the window.
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-03-08T00:00:00.000Z', '2026-03-08T02:00:00.000Z')],
      { window: { fromISO: '2026-03-08T00:00:00.001Z' } },
    )
    expect(blocks).toHaveLength(1)
  })

  it('the same session IS excluded once fromISO moves past its session END', () => {
    // And it drops out exactly one millisecond after the session ends -- which
    // is what proves the gate reads sessionEndISO and not the prep start
    // (23:30 the previous day) or the session start (00:00).
    const blocks = buildPrepBlocks(
      [s('a', 'b1', 'm1', '2026-03-08T00:00:00.000Z', '2026-03-08T02:00:00.000Z')],
      { window: { fromISO: '2026-03-08T02:00:00.001Z' } },
    )
    expect(blocks).toHaveLength(0)
  })

  // The point of this case is that the subtraction is plain wall-clock
  // arithmetic with no DST anomaly -- NOT the specific length. This session
  // starts after PREP_DURATION_CUTOFF_ISO so it is a 60-minute block; what is
  // being asserted is that 09:15 minus one hour is 08:15 on the PT fall-back
  // day, with no ±1h drift.
  it('fall-back date (2026-11-01) nominal session — plain subtraction, no anomaly', () => {
    const blocks = buildPrepBlocks([
      s('a', 'b1', 'm1', '2026-11-01T09:15:00.000Z', '2026-11-01T11:00:00.000Z'),
    ])
    expect(blocks[0].durationMinutes).toBe(60)
    expect(blocks[0].startISO).toBe('2026-11-01T08:15:00.000Z')
  })
})
