import { describe, it, expect } from 'vitest'
import { findSetupBonusStreamIds, setupBonusCents } from '@/lib/setupBonus'

const s = (id: string, brand: string, mod: string | null, iso: string) =>
  ({ id, brand_id: brand, moderator_id: mod, start_time: iso })

describe('findSetupBonusStreamIds', () => {
  it('earliest moderator-assigned stream per (brand, PT day) wins', () => {
    const ids = findSetupBonusStreamIds([
      s('a', 'b1', 'm1', '2026-06-09T09:00:00+00:00'),
      s('b', 'b1', 'm2', '2026-06-09T12:00:00+00:00'),
      s('c', 'b1', 'm2', '2026-06-10T09:00:00+00:00'),
    ])
    expect(ids).toEqual(new Set(['a', 'c']))
  })
  it('brands are independent on the same day', () => {
    const ids = findSetupBonusStreamIds([
      s('a', 'b1', 'm1', '2026-06-09T10:00:00+00:00'),
      s('b', 'b2', 'm2', '2026-06-09T09:00:00+00:00'),
    ])
    expect(ids).toEqual(new Set(['a', 'b']))
  })
  it('moderator-less streams neither grant nor block', () => {
    const ids = findSetupBonusStreamIds([
      s('a', 'b1', null, '2026-06-09T09:00:00+00:00'),
      s('b', 'b1', 'm1', '2026-06-09T12:00:00+00:00'),
    ])
    expect(ids).toEqual(new Set(['b']))
  })
  it('exact tie falls to lowest id (defensive)', () => {
    const ids = findSetupBonusStreamIds([
      s('z', 'b1', 'm1', '2026-06-09T09:00:00+00:00'),
      s('a', 'b1', 'm2', '2026-06-09T09:00:00+00:00'),
    ])
    expect(ids).toEqual(new Set(['a']))
  })
  it('empty input → empty set', () => {
    expect(findSetupBonusStreamIds([])).toEqual(new Set())
  })
  it('PT day comes from the stored ISO date, not local TZ', () => {
    // 2026-06-09T23:30 PT-as-UTC stays June 9 regardless of runtime TZ
    const ids = findSetupBonusStreamIds([
      s('a', 'b1', 'm1', '2026-06-09T23:30:00+00:00'),
      s('b', 'b1', 'm1', '2026-06-10T00:30:00+00:00'),
    ])
    expect(ids).toEqual(new Set(['a', 'b']))
  })
})

describe('setupBonusCents', () => {
  it('is 30 minutes at the flat rate', () => {
    expect(setupBonusCents(3000)).toBe(1500)
  })
  it('rounds odd rates like the rest of the money math', () => {
    expect(setupBonusCents(3333)).toBe(1667) // Math.round(1666.5)
  })
  it('zero rate → zero bonus', () => {
    expect(setupBonusCents(0)).toBe(0)
  })
})
