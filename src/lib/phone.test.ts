import { describe, expect, it } from 'vitest'
import { toE164US } from './phone'

describe('toE164US', () => {
  it('accepts common formats', () => {
    expect(toE164US('(310) 555-0101')).toBe('+13105550101')
    expect(toE164US('310-555-0101')).toBe('+13105550101')
    expect(toE164US('3105550101')).toBe('+13105550101')
    expect(toE164US('+1 310 555 0101')).toBe('+13105550101')
    expect(toE164US('1-310-555-0101')).toBe('+13105550101')
    expect(toE164US('310.555.0101')).toBe('+13105550101')
    expect(toE164US('  310 555 0101  ')).toBe('+13105550101')
  })

  it('rejects an area code starting with 0 or 1 (matches the DB CHECK exactly)', () => {
    expect(toE164US('010-555-0101')).toBeNull()
    expect(toE164US('110-555-0101')).toBeNull()
  })

  it('rejects the wrong number of digits', () => {
    expect(toE164US('555-0101')).toBeNull()
    expect(toE164US('31055501011')).toBeNull()
    expect(toE164US('2-310-555-0101')).toBeNull()
  })

  it('rejects non-numeric junk and empty input', () => {
    expect(toE164US('')).toBeNull()
    expect(toE164US('not a phone number')).toBeNull()
    expect(toE164US('abc-def-ghij')).toBeNull()
  })

  it('is idempotent on an already-normalized E.164 number', () => {
    expect(toE164US('+13105550101')).toBe('+13105550101')
  })
})
