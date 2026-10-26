import { describe, it, expect } from 'vitest'
import { computeFillRate } from '@/lib/fill'

describe('computeFillRate', () => {
  it('returns booked / contracted', () => {
    expect(computeFillRate(80, 160)).toBe(0.5)
  })
  it('can exceed 1 when over-booked', () => {
    expect(computeFillRate(200, 160)).toBeCloseTo(1.25)
  })
  it('returns 0 when nothing is booked', () => {
    expect(computeFillRate(0, 160)).toBe(0)
  })
  it('handles fractional booked hours', () => {
    expect(computeFillRate(40.5, 81)).toBe(0.5)
  })
  it('returns null when contracted is null (unset)', () => {
    expect(computeFillRate(80, null)).toBeNull()
  })
  it('returns null when contracted is undefined', () => {
    expect(computeFillRate(80, undefined)).toBeNull()
  })
  it('returns null when contracted is 0', () => {
    expect(computeFillRate(80, 0)).toBeNull()
  })
  it('returns null when contracted is negative', () => {
    expect(computeFillRate(80, -10)).toBeNull()
  })
})
