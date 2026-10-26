import { describe, expect, it } from 'vitest'
import { computeHostShiftPayoutCents } from './payout'
import {
  DEFAULT_RATE_CENTS,
  extraPayCents,
  extraPayDurationMinutes,
  extraPayHours,
  extraPaySlotCents,
  isExtraPayRealized,
  sumExtraPay,
  type ExtraPaySlotInput,
} from './extraPay'

const slot = (over: Partial<ExtraPaySlotInput> = {}): ExtraPaySlotInput => ({
  id: 'e1',
  hostId: 'h1',
  kind: 'training',
  startISO: '2026-09-07T10:00:00.000Z',
  endISO: '2026-09-07T12:00:00.000Z',
  rateCents: 2000,
  status: 'scheduled',
  ...over,
})

const ms = (iso: string) => new Date(iso).getTime()
const LATER = ms('2026-12-01T00:00:00.000Z')

describe('extraPayCents', () => {
  it('pays rate x hours in integer cents', () => {
    expect(extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T12:00:00.000Z', 2000)).toBe(4000)
  })

  it('rounds part-hours the same way host shift pay does', () => {
    // 1 minute at $33/hr -> 55c on both paths. Identical rounding is the point
    // of keeping this math in one place.
    const a = extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T10:01:00.000Z', 3300)
    const b = computeHostShiftPayoutCents(
      '2026-09-07T10:00:00.000Z', '2026-09-07T10:01:00.000Z', null, 3300,
    ).totalCents
    expect(a).toBe(b)
    expect(a).toBe(55)
  })

  it('handles a 90-minute block', () => {
    expect(extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T11:30:00.000Z', 2000)).toBe(3000)
  })

  it('returns 0 for a zero or inverted range', () => {
    expect(extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z', 2000)).toBe(0)
    expect(extraPayCents('2026-09-07T12:00:00.000Z', '2026-09-07T10:00:00.000Z', 2000)).toBe(0)
  })

  it('returns 0 for a zero or invalid rate', () => {
    expect(extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T12:00:00.000Z', 0)).toBe(0)
    expect(extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T12:00:00.000Z', NaN)).toBe(0)
  })
})

describe('the frozen rate — the whole point of storing rate_cents', () => {
  it('prices a slot from ITS OWN stored rate, never from the current default', () => {
    // Work done when training paid $20/hr must stay at $20/hr even after the
    // default is raised. Proven by pricing a slot whose stored rate differs
    // from today's default.
    const old = slot({ rateCents: 2000 })
    expect(extraPaySlotCents(old)).toBe(4000)

    const raised = slot({ rateCents: 2500 })
    expect(extraPaySlotCents(raised)).toBe(5000)

    // Same helper, same inputs, different stored rates -> different pay.
    // Nothing here reads DEFAULT_RATE_CENTS.
    expect(extraPaySlotCents(old)).not.toBe(extraPaySlotCents(raised))
  })

  it('two slots of identical length priced at different rates keep their own pay', () => {
    const totals = sumExtraPay(
      [
        slot({ id: 'a', rateCents: 2000 }),
        slot({
          id: 'b',
          rateCents: 2500,
          startISO: '2026-09-08T10:00:00.000Z',
          endISO: '2026-09-08T12:00:00.000Z',
        }),
      ],
      LATER,
    )
    expect(totals.cents).toBe(4000 + 5000)
    expect(totals.hours).toBe(4)
  })

  it('defaults exist for prefill but are not used by any pay function', () => {
    // Guard against someone "helpfully" defaulting a missing rate later.
    expect(DEFAULT_RATE_CENTS.training).toBeGreaterThan(0)
    expect(extraPayCents('2026-09-07T10:00:00.000Z', '2026-09-07T12:00:00.000Z', 0)).toBe(0)
  })
})

describe('duration helpers', () => {
  it('measures minutes and hours', () => {
    expect(extraPayDurationMinutes('2026-09-07T10:00:00.000Z', '2026-09-07T11:30:00.000Z')).toBe(90)
    expect(extraPayHours('2026-09-07T10:00:00.000Z', '2026-09-07T11:30:00.000Z')).toBe(1.5)
  })

  it('is DST-proof: PT-naive fields are read verbatim', () => {
    // Spans the Nov PT transition in wall-clock terms. Under the PT-naive
    // scheme this is exactly 2 hours; a real-timezone reading would give 3.
    expect(extraPayDurationMinutes('2026-11-01T01:00:00.000Z', '2026-11-01T03:00:00.000Z')).toBe(120)
  })

  it('returns 0 for malformed input', () => {
    expect(extraPayDurationMinutes('nonsense', '2026-09-07T12:00:00.000Z')).toBe(0)
  })
})

describe('isExtraPayRealized', () => {
  it('realizes exactly at the end instant (<=, matching every other surface)', () => {
    const end = '2026-09-07T12:00:00.000Z'
    expect(isExtraPayRealized(end, ms(end))).toBe(true)
    expect(isExtraPayRealized(end, ms(end) - 1)).toBe(false)
  })
})

describe('sumExtraPay', () => {
  it('counts only completed blocks — scheduled future work is not payable', () => {
    const totals = sumExtraPay([slot()], ms('2026-09-07T11:00:00.000Z')) // mid-block
    expect(totals.cents).toBe(0)
    expect(totals.hours).toBe(0)
  })

  it('excludes cancelled blocks even when they are in the past', () => {
    expect(sumExtraPay([slot({ status: 'canceled' })], LATER).cents).toBe(0)
  })

  it('splits totals per kind for the payroll breakdown', () => {
    const totals = sumExtraPay(
      [
        slot({ id: 'a', kind: 'training' }),
        slot({
          id: 'b',
          kind: 'office_hours',
          startISO: '2026-09-08T10:00:00.000Z',
          endISO: '2026-09-08T11:00:00.000Z',
        }),
      ],
      LATER,
    )
    expect(totals.byKind.training).toEqual({ hours: 2, cents: 4000 })
    expect(totals.byKind.office_hours).toEqual({ hours: 1, cents: 2000 })
    expect(totals.byKind.setup).toEqual({ hours: 0, cents: 0 })
    expect(totals.cents).toBe(6000)
  })

  it('per-kind totals always sum to the overall total', () => {
    const totals = sumExtraPay(
      [
        slot({ id: 'a', kind: 'setup' }),
        slot({ id: 'b', kind: 'training', startISO: '2026-09-08T10:00:00.000Z', endISO: '2026-09-08T13:00:00.000Z' }),
        slot({ id: 'c', kind: 'office_hours', startISO: '2026-09-09T10:00:00.000Z', endISO: '2026-09-09T11:00:00.000Z' }),
      ],
      LATER,
    )
    const summed = Object.values(totals.byKind).reduce((n, k) => n + k.cents, 0)
    expect(summed).toBe(totals.cents)
  })

  it('returns zeros for an empty list', () => {
    expect(sumExtraPay([], LATER)).toMatchObject({ hours: 0, cents: 0 })
  })
})
