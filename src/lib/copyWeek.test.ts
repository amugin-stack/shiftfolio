import { describe, expect, it } from 'vitest'
import {
  buildCopyPlan,
  describeCopyPlan,
  shiftIso,
  weekOffsetMs,
  WEEK_MS,
  type CopySourceStream,
} from './copyWeek'

// PT-naive scheme: a stream's UTC fields ARE its PT wall-clock, so every
// assertion below reads the UTC text as the time a human would see.

const stream = (over: Partial<CopySourceStream> = {}): CopySourceStream => ({
  id: 's1',
  title: null,
  host_id: 'host-1',
  producer_id: null,
  moderator_id: null,
  notes: null,
  start_time: '2026-09-07T10:00:00.000Z',
  end_time: '2026-09-07T12:00:00.000Z',
  ...over,
})

const ms = (iso: string) => new Date(iso).getTime()

describe('shiftIso / weekOffsetMs', () => {
  it('moves a shift exactly one week, preserving wall-clock time', () => {
    expect(shiftIso('2026-09-07T10:00:00.000Z', WEEK_MS)).toBe('2026-09-14T10:00:00.000Z')
  })

  it('holds the wall-clock hour across the November PT DST fall-back', () => {
    // 2026-11-01 is the PT transition. Calendar/local-time arithmetic would
    // drift this to 09:00 or 11:00; exact-ms arithmetic must not.
    expect(shiftIso('2026-10-27T10:00:00.000Z', WEEK_MS)).toBe('2026-11-03T10:00:00.000Z')
  })

  it('holds the wall-clock hour across the March PT spring-forward', () => {
    // 2027-03-14 is the PT transition.
    expect(shiftIso('2027-03-09T23:30:00.000Z', WEEK_MS)).toBe('2027-03-16T23:30:00.000Z')
  })

  it('computes a whole-week offset between two week starts', () => {
    expect(weekOffsetMs(ms('2026-09-07T00:00:00.000Z'), ms('2026-09-14T00:00:00.000Z'))).toBe(WEEK_MS)
  })

  it('supports copying backwards', () => {
    expect(shiftIso('2026-09-14T10:00:00.000Z', -WEEK_MS)).toBe('2026-09-07T10:00:00.000Z')
  })
})

describe('buildCopyPlan', () => {
  it('copies a clean week and carries assignments + notes across', () => {
    const plan = buildCopyPlan({
      sourceStreams: [stream({ id: 'a', host_id: 'h1', moderator_id: 'm1', notes: 'bring samples', title: 'Live' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
    })
    expect(plan.counts.create).toBe(1)
    expect(plan.toCreate[0]).toMatchObject({
      sourceId: 'a',
      host_id: 'h1',
      moderator_id: 'm1',
      notes: 'bring samples',
      title: 'Live',
      start_time: '2026-09-14T10:00:00.000Z',
      end_time: '2026-09-14T12:00:00.000Z',
    })
  })

  it('never carries frozen pay or revenue fields onto a copy', () => {
    const plan = buildCopyPlan({
      sourceStreams: [stream()],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
    })
    // A copy must price at the host's LIVE rate and start with no revenue.
    expect(plan.toCreate[0]).not.toHaveProperty('host_rate_cents')
    expect(plan.toCreate[0]).not.toHaveProperty('gmv_cents')
    expect(plan.toCreate[0]).not.toHaveProperty('verified')
    expect(plan.toCreate[0]).not.toHaveProperty('id')
  })

  it('skips a slot already booked on this brand (would abort the whole insert)', () => {
    const plan = buildCopyPlan({
      sourceStreams: [stream({ id: 'a' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [ms('2026-09-14T10:00:00.000Z')],
    })
    expect(plan.counts).toMatchObject({ create: 0, occupied: 1 })
    expect(plan.skipped[0]).toMatchObject({ sourceId: 'a', reason: 'occupied' })
  })

  it('skips a shift whose host is already booked on another brand', () => {
    const plan = buildCopyPlan({
      sourceStreams: [stream({ id: 'a', host_id: 'h1' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
      hostBusy: new Map([
        ['h1', [{ startMs: ms('2026-09-14T11:00:00.000Z'), endMs: ms('2026-09-14T13:00:00.000Z'), brandName: 'SAMPLE_BRAND_B' }]],
      ]),
    })
    expect(plan.counts).toMatchObject({ create: 0, hostConflict: 1 })
    expect(plan.skipped[0]).toMatchObject({ reason: 'host_conflict', conflictBrand: 'SAMPLE_BRAND_B' })
  })

  it('skips a shift whose moderator is already booked elsewhere', () => {
    const plan = buildCopyPlan({
      sourceStreams: [stream({ id: 'a', host_id: null, moderator_id: 'm1' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
      moderatorBusy: new Map([
        ['m1', [{ startMs: ms('2026-09-14T09:00:00.000Z'), endMs: ms('2026-09-14T11:00:00.000Z'), brandName: 'SAMPLE BRAND A' }]],
      ]),
    })
    expect(plan.counts).toMatchObject({ create: 0, moderatorConflict: 1 })
  })

  it('treats a merely touching commitment as free, not a conflict', () => {
    // Back-to-back shifts are normal and legal: [10,12) then [12,14).
    const plan = buildCopyPlan({
      sourceStreams: [stream({ host_id: 'h1' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
      hostBusy: new Map([
        ['h1', [{ startMs: ms('2026-09-14T12:00:00.000Z'), endMs: ms('2026-09-14T14:00:00.000Z'), brandName: 'SAMPLE_BRAND_B' }]],
      ]),
    })
    expect(plan.counts.create).toBe(1)
  })

  it('reports each skipped shift under exactly one reason', () => {
    // Occupied AND host-conflicted: counted once, as occupied.
    const plan = buildCopyPlan({
      sourceStreams: [stream({ id: 'a', host_id: 'h1' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [ms('2026-09-14T10:00:00.000Z')],
      hostBusy: new Map([
        ['h1', [{ startMs: ms('2026-09-14T10:00:00.000Z'), endMs: ms('2026-09-14T12:00:00.000Z'), brandName: 'SAMPLE_BRAND_B' }]],
      ]),
    })
    expect(plan.skipped).toHaveLength(1)
    expect(plan.counts).toMatchObject({ occupied: 1, hostConflict: 0 })
  })

  it('accounts for every source row exactly once', () => {
    const src = [
      stream({ id: 'a' }),
      stream({ id: 'b', start_time: '2026-09-07T12:00:00.000Z', end_time: '2026-09-07T14:00:00.000Z' }),
      stream({ id: 'c', start_time: '2026-09-08T10:00:00.000Z', end_time: '2026-09-08T12:00:00.000Z' }),
    ]
    const plan = buildCopyPlan({
      sourceStreams: src,
      offsetMs: WEEK_MS,
      occupiedStartMs: [ms('2026-09-14T12:00:00.000Z')],
    })
    const { create, occupied, hostConflict, moderatorConflict } = plan.counts
    expect(create + occupied + hostConflict + moderatorConflict).toBe(src.length)
  })

  it('does not plan two source shifts onto the same target slot', () => {
    // Defensive: a duplicate start_time cannot survive the unique index, and a
    // collision inside one insert would abort the entire batch.
    const plan = buildCopyPlan({
      sourceStreams: [stream({ id: 'a' }), stream({ id: 'b' })],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
    })
    expect(plan.counts).toMatchObject({ create: 1, occupied: 1 })
  })

  it('drops zero-length and inverted source rows (violate valid_time_range)', () => {
    const plan = buildCopyPlan({
      sourceStreams: [
        stream({ id: 'zero', end_time: '2026-09-07T10:00:00.000Z' }),
        stream({ id: 'inverted', start_time: '2026-09-07T14:00:00.000Z', end_time: '2026-09-07T12:00:00.000Z' }),
      ],
      offsetMs: WEEK_MS,
      occupiedStartMs: [],
    })
    expect(plan.toCreate).toHaveLength(0)
    expect(plan.skipped).toHaveLength(0)
  })

  it('flags copies that land in the past (immediately payable)', () => {
    const plan = buildCopyPlan({
      sourceStreams: [stream()],
      offsetMs: -WEEK_MS,
      occupiedStartMs: [],
      nowMs: ms('2026-09-10T00:00:00.000Z'),
    })
    expect(plan.counts.create).toBe(1)
    expect(plan.counts.landsInPast).toBe(1)
  })

  it('handles an empty source week', () => {
    const plan = buildCopyPlan({ sourceStreams: [], offsetMs: WEEK_MS, occupiedStartMs: [] })
    expect(plan.toCreate).toEqual([])
    expect(describeCopyPlan(plan)).toBe('That week has no shifts to copy.')
  })
})

describe('describeCopyPlan', () => {
  it('summarises creates and each skip reason', () => {
    const plan = buildCopyPlan({
      sourceStreams: [
        stream({ id: 'a' }),
        stream({ id: 'b', start_time: '2026-09-07T12:00:00.000Z', end_time: '2026-09-07T14:00:00.000Z' }),
      ],
      offsetMs: WEEK_MS,
      occupiedStartMs: [ms('2026-09-14T12:00:00.000Z')],
    })
    expect(describeCopyPlan(plan)).toBe('1 shift will be created, 1 skipped (slot already booked).')
  })
})
