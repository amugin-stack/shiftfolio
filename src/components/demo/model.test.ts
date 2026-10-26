import { describe, expect, it } from 'vitest'
import { addDays, conflictFor, DEMO_WEEK, demoPayrollCsv, emptyDraft, endMs, fmtMoney, hoursOf, keyOf, parseSavedShifts, payoutOf, seedShifts, startMs } from './model'

describe('Shiftfolio synthetic model', () => {
  it('starts from the same fictional week and resets to fresh seed data', () => {
    const first = seedShifts()
    expect(keyOf(DEMO_WEEK)).toBe('2026-10-05')
    expect(first).toHaveLength(13)
    expect(first[0].date).toBe('2026-10-05')
    first[0].title = 'Changed locally'
    expect(seedShifts()[0].title).toBe('Morning edition')
    expect(keyOf(addDays(DEMO_WEEK, 7))).toBe('2026-10-12')
  })

  it('uses UTC fields for wall-clock duration and payout', () => {
    const shift = seedShifts()[0]
    expect(startMs(shift)).toBe(Date.parse('2026-10-05T09:00:00Z'))
    expect(endMs(shift)).toBe(Date.parse('2026-10-05T12:00:00Z'))
    expect(hoursOf(shift)).toBe(3)
    expect(payoutOf(shift, 'Host')).toBe(15_600)
    expect(payoutOf(shift, 'Moderator')).toBe(10_200)
    expect(fmtMoney(12345)).toBe('$123.45')
  })

  it('keeps wall-clock duration stable across spring and fall DST dates', () => {
    for (const date of ['2026-03-08', '2026-11-01']) {
      const shift = { ...seedShifts()[0], date, start: '01:00', end: '04:00' }
      expect(hoursOf(shift)).toBe(3)
      expect(payoutOf(shift, 'Host')).toBe(15_600)
    }
  })

  it('blocks either overlapping worker but allows back-to-back shifts and the shift being edited', () => {
    const existing = seedShifts()[0]
    const overlappingHost = { ...emptyDraft(existing.date), start:'10:00', end:'11:00', hostId:existing.hostId, moderatorId:'leo' }
    expect(conflictFor([existing], overlappingHost)).toContain('Mara Chen')
    expect(conflictFor([existing], { ...overlappingHost, hostId:'jules', moderatorId:existing.moderatorId })).toContain('Nina Patel')
    expect(conflictFor([existing], { ...overlappingHost, start:'12:00', end:'13:00' })).toBeNull()
    expect(conflictFor([existing], overlappingHost, existing.id)).toBeNull()
  })

  it('rejects malformed persisted records and accepts an empty edited schedule', () => {
    expect(parseSavedShifts(JSON.stringify(seedShifts()))).toHaveLength(13)
    expect(parseSavedShifts('[]')).toEqual([])
    expect(parseSavedShifts('not json')).toBeNull()
    expect(parseSavedShifts(JSON.stringify([{ ...seedShifts()[0], hostId:'unknown' }]))).toBeNull()
    expect(parseSavedShifts(JSON.stringify([{ ...seedShifts()[0], end:'08:00' }]))).toBeNull()
  })

  it('exports seven actual CRLF-delimited CSV lines and the expected payroll', () => {
    const csv = demoPayrollCsv(seedShifts())
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(7) // header and six people
    expect(lines[0]).toBe('Name,Role,Shifts,Hours,Hourly Rate,Projected Pay')
    expect(csv).not.toContain('\\r\\n')
    expect(lines.slice(1).reduce((sum,line) => sum + Number(line.split(',').at(-1)),0)).toBe(3276)
  })
})
