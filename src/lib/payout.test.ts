import { describe, it, expect } from 'vitest'
import {
  resolveHostShiftRateCents,
  computeHostShiftPayoutCents,
} from '@/lib/payout'

// ============================================================
// Flat host rate (migration 046)
// ============================================================
// The Studio scheduler stores stream timestamps as UTC-typed but treats the
// UTC fields as PT wall-clock (see src/lib/utils.ts comments). The flat-rate
// payout math is timestamp-pure — only the duration matters.

describe('flat host rate — resolveHostShiftRateCents', () => {
  it('frozen stream rate wins over the host flat rate', () => {
    expect(resolveHostShiftRateCents(2500, 3000)).toBe(2500)
  })
  it('frozen rate of 0 cents is respected (nullish coalescing, not ||)', () => {
    expect(resolveHostShiftRateCents(0, 3000)).toBe(0)
  })
  it('falls back to the host flat rate when no frozen rate', () => {
    expect(resolveHostShiftRateCents(null, 3000)).toBe(3000)
    expect(resolveHostShiftRateCents(undefined, 3000)).toBe(3000)
  })
  it('falls back to 0 when neither is set (hostless / unloaded row)', () => {
    expect(resolveHostShiftRateCents(null, null)).toBe(0)
    expect(resolveHostShiftRateCents(null, undefined)).toBe(0)
  })
})

describe('flat host rate — computeHostShiftPayoutCents', () => {
  it('180-minute shift at flat $30/hr = 9000 cents', () => {
    const r = computeHostShiftPayoutCents(
      '2026-06-15T09:00:00+00:00', '2026-06-15T12:00:00+00:00', null, 3000,
    )
    expect(r).toEqual({ rateCents: 3000, totalCents: 9000, durationMinutes: 180 })
  })
  it('frozen rate beats flat rate in the total', () => {
    const r = computeHostShiftPayoutCents(
      '2026-05-01T10:00:00+00:00', '2026-05-01T11:00:00+00:00', 4500, 3000,
    )
    expect(r).toEqual({ rateCents: 4500, totalCents: 4500, durationMinutes: 60 })
  })
  it('rounds sub-cent values like the old math (1 min at $33/hr → 55 cents)', () => {
    const r = computeHostShiftPayoutCents(
      '2026-06-15T09:00:00+00:00', '2026-06-15T09:01:00+00:00', null, 3300,
    )
    expect(r.totalCents).toBe(55)
  })
  it('accepts Date objects as well as ISO strings', () => {
    const r = computeHostShiftPayoutCents(
      new Date('2026-06-15T09:00:00+00:00'), new Date('2026-06-15T10:30:00+00:00'), null, 3000,
    )
    expect(r.totalCents).toBe(4500)
  })
  it('zero-duration shift returns 0 total but keeps the rate', () => {
    const r = computeHostShiftPayoutCents(
      '2026-06-15T09:00:00+00:00', '2026-06-15T09:00:00+00:00', 2000, 3000,
    )
    expect(r).toEqual({ rateCents: 2000, totalCents: 0, durationMinutes: 0 })
  })
  it('negative duration (end < start) returns a negative total — surfaces the bug instead of silently zeroing', () => {
    const r = computeHostShiftPayoutCents(
      '2026-06-15T12:00:00+00:00', '2026-06-15T11:00:00+00:00', null, 3000,
    )
    expect(r.totalCents).toBe(-3000)
  })
  it('past-shift timestamps compute identically to future ones (no clock-based gating)', () => {
    const past = computeHostShiftPayoutCents(
      '2020-05-15T15:00:00+00:00', '2020-05-15T16:00:00+00:00', 4000, 3000,
    )
    expect(past.totalCents).toBe(4000)
  })
})
