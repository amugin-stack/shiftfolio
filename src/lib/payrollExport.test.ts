import { describe, it, expect } from 'vitest'
import {
  resolvePresetRange,
  resolvePayPeriodRange,
  resolveCustomRange,
  buildHostRows,
  buildModeratorRows,
  sortPayrollRows,
  csvEscape,
  rowsToCsv,
  type PayrollRow,
  type HostStreamInput,
  type ExtraPaySlotRow,
} from '@/lib/payrollExport'

// `now` is a Date whose UTC fields encode the current PT wall-clock
// (this is exactly what nowPtAsUtc() returns). 2026-06-02.
const NOW = new Date(Date.UTC(2026, 5, 2, 14, 30, 0)) // Jun 2 2026, 14:30 PT

// The biweekly window is no longer rolling — it comes off the anchored pay
// period calendar (src/lib/payPeriod.ts), which is what the worker's own My
// Shifts page reads too. The "windows abut exactly" and "no day belongs to two
// windows / to none" properties the old rolling tests guarded are now proved
// more strongly in payPeriod.test.ts, over a two-year sweep rather than one
// pair of runs. What is tested HERE is the part specific to payroll: which
// period an export resolves to, and the completed-shift gate.
describe('resolvePayPeriodRange', () => {
  // NOW = Jun 2 2026, which is before the anchor — the ordinary case for
  // historical exports, and the one that breaks if the period index is
  // truncated toward zero instead of floored.
  it('previous is the completed period immediately before the current one', () => {
    const cur = resolvePayPeriodRange('current', NOW)
    const prev = resolvePayPeriodRange('previous', NOW)
    expect(prev.toExclusiveISO).toBe(cur.fromISO)
  })

  it('both are exactly 14 days', () => {
    for (const which of ['current', 'previous'] as const) {
      const r = resolvePayPeriodRange(which, NOW)
      const spanDays =
        (new Date(r.toExclusiveISO).getTime() - new Date(r.fromISO).getTime()) / 86_400_000
      expect(spanDays).toBe(14)
    }
  })

  it('the current period contains today; the previous one does not', () => {
    const todayMs = Date.UTC(2026, 5, 2)
    const cur = resolvePayPeriodRange('current', NOW)
    const prev = resolvePayPeriodRange('previous', NOW)
    expect(new Date(cur.fromISO).getTime()).toBeLessThanOrEqual(todayMs)
    expect(new Date(cur.toExclusiveISO).getTime()).toBeGreaterThan(todayMs)
    expect(new Date(prev.toExclusiveISO).getTime()).toBeLessThanOrEqual(todayMs)
  })

  // Everything in the previous period has already ended, so buildHostRows'
  // "completed shifts only" gate cannot silently drop anything from the file
  // you actually pay from.
  it('the previous period is entirely in the past', () => {
    const prev = resolvePayPeriodRange('previous', NOW)
    const nowMs = NOW.getTime()
    expect(new Date(prev.toExclusiveISO).getTime()).toBeLessThanOrEqual(nowMs)
  })

  // The rolling window's fatal property, gone: a shift finishing later today
  // is skipped as unfinished by THIS export, and because the period is anchored
  // rather than measured from the click date, re-exporting the same period
  // after it closes still contains it. Under the old rolling window the next
  // run started 14 days back from a NEW date, so the shift could fall into no
  // window at all and never be paid.
  it('a shift finishing later today is picked up when the same period is re-exported', () => {
    const todayShiftEnd = new Date(Date.UTC(2026, 5, 2, 18, 0, 0)).getTime()
    const nowRun = resolvePayPeriodRange('current', NOW)
    expect(new Date(nowRun.fromISO).getTime()).toBeLessThanOrEqual(todayShiftEnd)
    expect(new Date(nowRun.toExclusiveISO).getTime()).toBeGreaterThan(todayShiftEnd)

    // Same period, exported after it has closed — identical bounds, and the
    // shift has now ended so buildHostRows will include it.
    const afterClose = new Date(new Date(nowRun.toExclusiveISO).getTime() + 86_400_000)
    const closedRun = resolvePayPeriodRange('previous', afterClose)
    expect(closedRun.fromISO).toBe(nowRun.fromISO)
    expect(closedRun.toExclusiveISO).toBe(nowRun.toExclusiveISO)
    expect(new Date(closedRun.toExclusiveISO).getTime()).toBeGreaterThan(todayShiftEnd)
  })

  it('handles crossing a year boundary', () => {
    const jan = new Date(Date.UTC(2026, 0, 5, 9, 0, 0)) // Jan 5 2026
    const r = resolvePayPeriodRange('current', jan)
    expect(new Date(r.fromISO).getTime()).toBeLessThanOrEqual(Date.UTC(2026, 0, 5))
    expect(new Date(r.toExclusiveISO).getTime()).toBeGreaterThan(Date.UTC(2026, 0, 5))
    const spanDays =
      (new Date(r.toExclusiveISO).getTime() - new Date(r.fromISO).getTime()) / 86_400_000
    expect(spanDays).toBe(14)
  })
})

describe('resolvePresetRange', () => {
  it('month → exactly 30 days ending today', () => {
    const r = resolvePresetRange('month', NOW)
    expect(r.fromKey).toBe('2026-05-03')
    expect(r.toKey).toBe('2026-06-01')
    const spanDays =
      (new Date(r.toExclusiveISO).getTime() - new Date(r.fromISO).getTime()) / 86_400_000
    expect(spanDays).toBe(30)
  })

  it('handles crossing a year boundary', () => {
    const jan = new Date(Date.UTC(2026, 0, 5, 9, 0, 0)) // Jan 5 2026
    const r = resolvePresetRange('month', jan)
    expect(r.fromKey).toBe('2025-12-06')
    expect(r.toKey).toBe('2026-01-04')
  })
})

describe('resolveCustomRange', () => {
  it('builds inclusive range with exclusive upper ISO bound', () => {
    const r = resolveCustomRange('2026-05-01', '2026-05-31')
    expect(r.fromISO).toBe('2026-05-01T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2026-06-01T00:00:00.000Z')
    expect(r.fromKey).toBe('2026-05-01')
    expect(r.toKey).toBe('2026-05-31')
  })

  it('allows a single-day range', () => {
    const r = resolveCustomRange('2026-05-10', '2026-05-10')
    expect(r.fromISO).toBe('2026-05-10T00:00:00.000Z')
    expect(r.toExclusiveISO).toBe('2026-05-11T00:00:00.000Z')
  })

  it('throws when from is after to', () => {
    expect(() => resolveCustomRange('2026-05-31', '2026-05-01')).toThrow()
  })

  it('throws on malformed dates', () => {
    expect(() => resolveCustomRange('2026-5-1', '2026-05-01')).toThrow()
    expect(() => resolveCustomRange('not-a-date', '2026-05-01')).toThrow()
  })
})

// nowMs: treat anything ending at/before Jun 2 2026 12:00 PT as completed.
const NOW_MS = Date.UTC(2026, 5, 2, 12, 0, 0)

describe('buildHostRows', () => {
  it('sums completed shifts only, per host, at the flat rate', () => {
    const streams = [
      // Alice: 3h completed (May 15 9-12) + 2h completed (May 16 9-11) @ $40/hr flat
      { host_id: 'h1', host: { name: 'Alice', rate_cents: 4000 }, host_rate_cents: null,
        start_time: '2026-05-15T09:00:00.000Z', end_time: '2026-05-15T12:00:00.000Z' },
      { host_id: 'h1', host: { name: 'Alice', rate_cents: 4000 }, host_rate_cents: null,
        start_time: '2026-05-16T09:00:00.000Z', end_time: '2026-05-16T11:00:00.000Z' },
      // Alice future shift (after NOW) — must be ignored
      { host_id: 'h1', host: { name: 'Alice', rate_cents: 4000 }, host_rate_cents: null,
        start_time: '2026-06-10T09:00:00.000Z', end_time: '2026-06-10T12:00:00.000Z' },
    ]
    const rows = buildHostRows(streams, NOW_MS)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ name: 'Alice', role: 'Host', totalHours: 5, amountCents: 20000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 }) // 5h × 4000c/hr = 20000c
  })

  it('frozen host_rate_cents wins over the host flat rate', () => {
    const streams = [
      // 2h completed @ frozen $25/hr (host's live rate is $40/hr — must NOT apply)
      { host_id: 'h1', host: { name: 'Alice', rate_cents: 4000 }, host_rate_cents: 2500,
        start_time: '2026-05-15T09:00:00.000Z', end_time: '2026-05-15T11:00:00.000Z' },
    ]
    expect(buildHostRows(streams, NOW_MS)).toEqual([
      { name: 'Alice', role: 'Host', totalHours: 2, amountCents: 5000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
    ])
  })

  it('omits a host with zero completed shifts', () => {
    const streams = [
      { host_id: 'h2', host: { name: 'Bob', rate_cents: 3000 }, host_rate_cents: null,
        start_time: '2026-06-10T09:00:00.000Z', end_time: '2026-06-10T12:00:00.000Z' },
    ]
    expect(buildHostRows(streams, NOW_MS)).toHaveLength(0)
  })

  it('missing host join → name Unknown, rate 0', () => {
    const streams = [
      { host_id: 'h3', host: null, host_rate_cents: null,
        start_time: '2026-05-15T09:00:00.000Z', end_time: '2026-05-15T11:00:00.000Z' },
    ]
    expect(buildHostRows(streams, NOW_MS)).toEqual([
      { name: 'Unknown', role: 'Host', totalHours: 2, amountCents: 0, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
    ])
  })
})

// Moderator extra pay — setup / training / office hours for a MODERATOR
// (migration 073). Mirrors the host fold, so an hour of training must price and
// realize identically whoever did it. Money file, rule 18.
describe('buildModeratorRows — extra pay', () => {
  const modSlot = (over: Partial<ExtraPaySlotRow> = {}): ExtraPaySlotRow => ({
    id: 'e1',
    host_id: null,
    host: null,
    moderator_id: 'm1',
    moderator: { name: 'Carol' },
    kind: 'training',
    rate_cents: 2000,
    status: 'scheduled',
    start_time: '2026-05-20T18:00:00.000Z',
    end_time: '2026-05-20T20:00:00.000Z',
    ...over,
  })

  it('pays a completed moderator block at the rate frozen on the slot', () => {
    const rows = buildModeratorRows([], NOW_MS, undefined, [modSlot()])
    expect(rows).toEqual([{
      name: 'Carol', role: 'Moderator', totalHours: 2, amountCents: 4000,
      prepHours: 0, prepCents: 0, extraHours: 2, extraCents: 4000, unworkedHours: 0,
    }])
  })

  // The block's own rate is used, NOT the moderator's hourly rate from any
  // stream. Raising someone's rate must never re-price training already done.
  it('ignores the moderator stream rate and uses the slot rate', () => {
    const streams = [
      { id: 's1', brand_id: 'b1', moderator_id: 'm1',
        moderator: { name: 'Carol', rate_cents: 9999 },
        start_time: '2026-05-21T18:00:00.000Z', end_time: '2026-05-21T19:00:00.000Z' },
    ]
    const rows = buildModeratorRows(streams, NOW_MS, undefined, [modSlot({ rate_cents: 1000 })])
    const carol = rows.find(r => r.name === 'Carol')!
    expect(carol.extraCents).toBe(2000) // 2h x $10, not x $99.99
  })

  it('skips cancelled and not-yet-finished blocks', () => {
    expect(buildModeratorRows([], NOW_MS, undefined, [modSlot({ status: 'canceled' })])).toEqual([])
    expect(buildModeratorRows([], NOW_MS, undefined, [modSlot({
      start_time: '2026-12-01T18:00:00.000Z', end_time: '2026-12-01T20:00:00.000Z',
    })])).toEqual([])
  })

  // The property that makes it safe to hand ONE slot array to both builders:
  // host slots have a null moderator_id, moderator slots a null host_id. If
  // either builder stopped skipping the other's rows, the same block would be
  // paid twice -- once as a host row and once as a moderator row.
  it('ignores host slots entirely', () => {
    const hostSlot = modSlot({ moderator_id: null, moderator: null, host_id: 'h1', host: { name: 'Alice' } })
    expect(buildModeratorRows([], NOW_MS, undefined, [hostSlot])).toEqual([])
  })

  it('a host slot handed to buildHostRows and the same array to buildModeratorRows pays once each', () => {
    const hostSlot = modSlot({ id: 'e2', moderator_id: null, moderator: null, host_id: 'h1', host: { name: 'Alice' } })
    const both = [modSlot(), hostSlot]
    const hostRows = buildHostRows([], NOW_MS, both)
    const modRows = buildModeratorRows([], NOW_MS, undefined, both)
    expect(hostRows.map(r => r.name)).toEqual(['Alice'])
    expect(modRows.map(r => r.name)).toEqual(['Carol'])
    expect(hostRows[0].extraCents).toBe(4000)
    expect(modRows[0].extraCents).toBe(4000)
  })

  it('adds to a moderator who also worked shifts, without disturbing prep', () => {
    const streams = [
      { id: 's1', brand_id: 'b1', moderator_id: 'm1',
        moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-05-21T18:00:00.000Z', end_time: '2026-05-21T20:00:00.000Z' },
    ]
    const withoutExtra = buildModeratorRows(streams, NOW_MS)[0]
    const withExtra = buildModeratorRows(streams, NOW_MS, undefined, [modSlot()])[0]
    expect(withExtra.prepCents).toBe(withoutExtra.prepCents)
    expect(withExtra.amountCents).toBe(withoutExtra.amountCents + 4000)
    expect(withExtra.totalHours).toBe(withoutExtra.totalHours + 2)
  })

  // Otherwise a moderator who only did training that period would be missing
  // from the CSV entirely and simply not get paid.
  it('gives a row to a moderator with extra pay and no shifts at all', () => {
    const rows = buildModeratorRows([], NOW_MS, undefined, [modSlot()])
    expect(rows).toHaveLength(1)
    expect(rows[0].amountCents).toBe(4000)
  })

  it('rounds per block then sums, matching every other pay surface', () => {
    // 25 minutes @ $20/hr = 833.33c -> 833c each, twice = 1666c.
    const a = modSlot({ id: 'a', start_time: '2026-05-20T18:00:00.000Z', end_time: '2026-05-20T18:25:00.000Z' })
    const b = modSlot({ id: 'b', start_time: '2026-05-20T19:00:00.000Z', end_time: '2026-05-20T19:25:00.000Z' })
    expect(buildModeratorRows([], NOW_MS, undefined, [a, b])[0].extraCents).toBe(1666)
  })
})

describe('buildModeratorRows', () => {
  it('uses flat rate_cents × hours, completed only (+setup on day-firsts)', () => {
    const streams = [
      // Carol: 2h @ $20/hr completed = 4000c. Day-first on b1 → +1000c, +0.5h.
      // The future shift is ignored even though it's also a day-first.
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-05-20T18:00:00.000Z', end_time: '2026-05-20T20:00:00.000Z' },
      { id: 's2', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-06-15T18:00:00.000Z', end_time: '2026-06-15T19:00:00.000Z' },
    ]
    const rows = buildModeratorRows(streams, NOW_MS)
    expect(rows).toEqual([{ name: 'Carol', role: 'Moderator', totalHours: 2.5, amountCents: 5000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 }])
  })

  it('buckets two moderators separately (each day-first on their brand-day)', () => {
    const streams = [
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-05-20T18:00:00.000Z', end_time: '2026-05-20T20:00:00.000Z' }, // 2h + setup → 5000c
      { id: 's2', brand_id: 'b1', moderator_id: 'm2', moderator: { name: 'Dave', rate_cents: 3000 },
        start_time: '2026-05-21T18:00:00.000Z', end_time: '2026-05-21T19:00:00.000Z' }, // 1h + setup → 4500c
    ]
    const rows = buildModeratorRows(streams, NOW_MS)
    expect(rows).toHaveLength(2)
    expect(rows).toContainEqual({ name: 'Carol', role: 'Moderator', totalHours: 2.5, amountCents: 5000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 })
    expect(rows).toContainEqual({ name: 'Dave', role: 'Moderator', totalHours: 1.5, amountCents: 4500, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 })
  })

  it('adds 30-min setup pay to the day-first moderator per brand (completed only)', () => {
    const streams = [
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-05-20T09:00:00.000Z', end_time: '2026-05-20T11:00:00.000Z' }, // b1 first → +1000
      { id: 's2', brand_id: 'b1', moderator_id: 'm2', moderator: { name: 'Dave', rate_cents: 3000 },
        start_time: '2026-05-20T12:00:00.000Z', end_time: '2026-05-20T13:00:00.000Z' }, // not first
      { id: 's3', brand_id: 'b2', moderator_id: 'm2', moderator: { name: 'Dave', rate_cents: 3000 },
        start_time: '2026-05-20T15:00:00.000Z', end_time: '2026-05-20T16:00:00.000Z' }, // b2 first → +1500
    ]
    const rows = buildModeratorRows(streams, NOW_MS)
    // Carol: 2h*2000 + 1000 = 5000c, 2.5h. Dave: 1h*3000 + 1h*3000 + 1500 = 7500c, 2.5h.
    expect(rows).toContainEqual({ name: 'Carol', role: 'Moderator', totalHours: 2.5, amountCents: 5000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 })
    expect(rows).toContainEqual({ name: 'Dave', role: 'Moderator', totalHours: 2.5, amountCents: 7500, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 })
  })

  // ---- New prep rule (post-cutoff sessions; see src/lib/prepTime.ts) ----
  // NOW for these cases sits after the cutoff so completed post-cutoff
  // sessions exist. PREP_CUTOFF_ISO is 2026-07-16.
  const POST_NOW_MS = Date.UTC(2026, 7, 10, 12, 0, 0) // Aug 10 2026, 12:00 PT

  it('post-cutoff: setup bonus stops; each completed session earns one prep block at the mod\'s own rate', () => {
    const streams = [
      // One session of two touching rows (day-first too — but post-cutoff, so
      // the per-day setup bonus is replaced by ONE per-session prep block).
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-01T12:00:00.000Z', end_time: '2026-08-01T15:00:00.000Z' },
      { id: 's2', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-01T15:00:00.000Z', end_time: '2026-08-01T18:00:00.000Z' },
    ]
    const rows = buildModeratorRows(streams, POST_NOW_MS)
    // Live: 6h × 3000 = 18000c. Prep: 1 block × Math.round(3000×30/60) = 1500c, +0.5h.
    expect(rows).toEqual([{
      name: 'Carol', role: 'Moderator', totalHours: 6.5, amountCents: 19500,
      prepHours: 0.5, prepCents: 1500, extraHours: 0, extraCents: 0, unworkedHours: 0,
    }])
  })

  it('post-cutoff: unfinished sessions earn no prep yet', () => {
    const streams = [
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-20T12:00:00.000Z', end_time: '2026-08-20T15:00:00.000Z' },
    ]
    expect(buildModeratorRows(streams, POST_NOW_MS)).toHaveLength(0)
  })

  it('window: a shift is paid in the period it ENDS in, exactly once', () => {
    // Payroll windows on end_time, so a shift belongs to the period its end
    // falls in. This session straddles the Jul/Aug boundary:
    //   s0  Jul 31 22:00 -> Aug 1 00:00
    //   s1  Aug 1 00:00 -> Aug 1 02:00   (contiguous, so ONE session)
    //
    // s0 ends exactly at the August window's inclusive start, so it is in
    // August (end >= from) and NOT in July (July's exclusive end is that same
    // instant, and end < toExclusive is false). Paid once, in August. Under
    // the old start_time windowing it was in July's window but could be
    // dropped there for not having finished yet, and July's window was already
    // behind it by the next run -- so it could go unpaid entirely.
    //
    // Prep follows the session's END for the same reason, so it lands in the
    // same period as the shift rows it belongs to.
    const streams = [
      { id: 's0', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-07-31T22:00:00.000Z', end_time: '2026-08-01T00:00:00.000Z' },
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-01T00:00:00.000Z', end_time: '2026-08-01T02:00:00.000Z' },
    ]
    const rows = buildModeratorRows(streams, POST_NOW_MS, {
      fromISO: '2026-08-01T00:00:00.000Z', toExclusiveISO: '2026-09-01T00:00:00.000Z',
    })
    // 2h + 2h live at $30/hr = 12000, plus one 30-min prep block = 1500.
    expect(rows).toEqual([{
      name: 'Carol', role: 'Moderator', totalHours: 4.5, amountCents: 13500,
      prepHours: 0.5, prepCents: 1500, extraHours: 0, extraCents: 0, unworkedHours: 0,
    }])
  })

  it('a session straddling a boundary pays its prep block in ONE period only', () => {
    // The regression the earlier test dodged by putting the split exactly on
    // midnight. Carol works one contiguous session as two rows:
    //   A  Jul 31 20:00 -> 22:00
    //   B  Jul 31 22:00 -> Aug 1 02:00
    // Each period's query is padded on BOTH sides, so both see the WHOLE
    // session and agree it ends Aug 1 02:00. Only August contains that end, so
    // the prep block is paid once. Previously July saw only {A}, called it a
    // session ending in July, and paid a second prep block.
    const rows = [
      { id: 'A', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-07-31T20:00:00.000Z', end_time: '2026-07-31T22:00:00.000Z' },
      { id: 'B', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-07-31T22:00:00.000Z', end_time: '2026-08-01T02:00:00.000Z' },
    ]
    const july = buildModeratorRows(rows, POST_NOW_MS, {
      fromISO: '2026-07-01T00:00:00.000Z', toExclusiveISO: '2026-08-01T00:00:00.000Z',
    })
    const august = buildModeratorRows(rows, POST_NOW_MS, {
      fromISO: '2026-08-01T00:00:00.000Z', toExclusiveISO: '2026-09-01T00:00:00.000Z',
    })
    const julyPrep = july[0]?.prepCents ?? 0
    const augPrep = august[0]?.prepCents ?? 0
    // Exactly one period pays the prep block -- never both, never neither.
    expect([julyPrep, augPrep].filter(c => c > 0)).toHaveLength(1)
    expect(julyPrep + augPrep).toBe(1500)

    // And the LIVE hours are split, each row paid in the period it ends in.
    expect(july[0].totalHours).toBeCloseTo(2, 6)      // A only
    expect(august[0].totalHours).toBeCloseTo(4.5, 6)  // B (4h) + prep (0.5h)
  })

  it('window: a shift ending BEFORE the window is context only, never paid', () => {
    // The lookback rows the query deliberately over-fetches for session
    // detection must not contribute pay. Keyed off end_time, matching the query.
    const streams = [
      { id: 's0', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-07-31T18:00:00.000Z', end_time: '2026-07-31T20:00:00.000Z' }, // ends in July
      { id: 's1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-01T10:00:00.000Z', end_time: '2026-08-01T12:00:00.000Z' }, // ends in Aug
    ]
    const rows = buildModeratorRows(streams, POST_NOW_MS, {
      fromISO: '2026-08-01T00:00:00.000Z', toExclusiveISO: '2026-09-01T00:00:00.000Z',
    })
    // Only the August shift pays: 2h at $30 = 6000, plus its own prep block.
    expect(rows[0].name).toBe('Carol')
    expect(rows[0].totalHours).toBe(2.5)
    expect(rows[0].amountCents).toBe(7500)
  })

  it('a range spanning the cutoff pays the old bonus pre-cutoff AND prep post-cutoff, once each', () => {
    // Real-world case: a custom export range crossing PREP_CUTOFF_ISO
    // (2026-07-16). Carol: pre-cutoff day-first 2h shift (bonus at own rate)
    // + post-cutoff 2-row session (one prep block). No double-pay.
    const streams = [
      { id: 'pre', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-07-10T12:00:00.000Z', end_time: '2026-07-10T14:00:00.000Z' },
      { id: 'p1', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-01T12:00:00.000Z', end_time: '2026-08-01T15:00:00.000Z' },
      { id: 'p2', brand_id: 'b1', moderator_id: 'm1', moderator: { name: 'Carol', rate_cents: 3000 },
        start_time: '2026-08-01T15:00:00.000Z', end_time: '2026-08-01T18:00:00.000Z' },
    ]
    const rows = buildModeratorRows(streams, POST_NOW_MS)
    // Live: 2h + 6h = 8h × 3000 = 24000c. Bonus: round(3000/2) = 1500c (+0.5h).
    // Prep: 1 block × round(3000×30/60) = 1500c (+0.5h). Total 27000c, 9h.
    expect(rows).toEqual([{
      name: 'Carol', role: 'Moderator', totalHours: 9, amountCents: 27000,
      prepHours: 0.5, prepCents: 1500, extraHours: 0, extraCents: 0, unworkedHours: 0,
    }])
  })

  it('a broken moderator join can mint a prep block but pays $0 (Unknown fallback)', () => {
    // moderator_id set but the join is null: the live loop skips the row
    // (no rate), while session detection only needs moderator_id — the
    // fallback pays prepBlockCents(0) = 0 rather than inventing money.
    const streams = [
      { id: 's1', brand_id: 'b1', moderator_id: 'm9', moderator: null,
        start_time: '2026-08-01T12:00:00.000Z', end_time: '2026-08-01T15:00:00.000Z' },
    ]
    const rows = buildModeratorRows(streams, POST_NOW_MS)
    expect(rows).toEqual([{
      name: 'Unknown', role: 'Moderator', totalHours: 0.5, amountCents: 0,
      prepHours: 0.5, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0,
    }])
  })
})

describe('csvEscape', () => {
  it('leaves plain values unquoted', () => {
    expect(csvEscape('Alice')).toBe('Alice')
  })
  it('quotes values with commas', () => {
    expect(csvEscape('Doe, Jane')).toBe('"Doe, Jane"')
  })
  it('quotes and doubles internal quotes', () => {
    expect(csvEscape('A "B" C')).toBe('"A ""B"" C"')
  })

  // Spreadsheet formula-injection neutralization (security F4/F5/F7).
  it('neutralizes a leading = by prefixing a single quote', () => {
    expect(csvEscape('=1+1')).toBe("'=1+1")
  })
  it('neutralizes leading + - @ triggers', () => {
    expect(csvEscape('+1')).toBe("'+1")
    expect(csvEscape('-2+3')).toBe("'-2+3")
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)")
  })
  it('neutralizes a formula trigger hidden behind leading whitespace', () => {
    expect(csvEscape('  =1+1')).toBe("'  =1+1")
  })
  it('neutralizes AND quotes when the value also contains a comma', () => {
    // prefix first, then RFC-4180 quote (the value contains a comma)
    expect(csvEscape('=cmd|, x')).toBe('"\'=cmd|, x"')
  })
  it('does not touch a normal name that merely contains = or - mid-string', () => {
    expect(csvEscape('A=B')).toBe('A=B')
    expect(csvEscape('Jean-Luc')).toBe('Jean-Luc')
  })
})

// ---------------------------------------------------------------------------
// PAY BASIS — scheduled vs completed hours (the support team, 2026-09-04)
// ---------------------------------------------------------------------------
// Payroll runs a couple of days BEFORE the period closes, so a completed-only
// file drops every shift still to come and people are paid short. These pin the
// 'expected' basis and, just as importantly, pin that 'realized' has not moved.
describe('pay basis', () => {
  // 2h shift ending AFTER NOW_MS — unfinished.
  const future: HostStreamInput[] = [{
    host_id: 'h1', host: { name: 'Alice', rate_cents: 4000 }, host_rate_cents: null,
    start_time: '2026-06-10T09:00:00.000Z', end_time: '2026-06-10T11:00:00.000Z',
  }]
  // 2h shift already finished.
  const past: HostStreamInput[] = [{
    host_id: 'h1', host: { name: 'Alice', rate_cents: 4000 }, host_rate_cents: null,
    start_time: '2026-05-15T09:00:00.000Z', end_time: '2026-05-15T11:00:00.000Z',
  }]

  it('realized is the DEFAULT and is unchanged — an unfinished shift is not paid', () => {
    expect(buildHostRows(future, NOW_MS)).toEqual([])
    expect(buildHostRows(future, NOW_MS, [], 'realized')).toEqual([])
  })

  it('expected pays the unfinished shift and reports it as unworked', () => {
    const rows = buildHostRows(future, NOW_MS, [], 'expected')
    expect(rows).toHaveLength(1)
    expect(rows[0].amountCents).toBe(8000) // 2h x $40
    expect(rows[0].totalHours).toBe(2)
    expect(rows[0].unworkedHours).toBe(2)
  })

  it('unworkedHours counts ONLY the not-yet-worked part of a mixed row', () => {
    const rows = buildHostRows([...past, ...future], NOW_MS, [], 'expected')
    expect(rows[0].totalHours).toBe(4)
    expect(rows[0].unworkedHours).toBe(2)
    expect(rows[0].amountCents).toBe(16000)
  })

  it('unworkedHours is 0 under the realized basis', () => {
    const rows = buildHostRows([...past, ...future], NOW_MS)
    expect(rows[0].unworkedHours).toBe(0)
  })

  // THE CHEAPEST CORRECTNESS CHECK ON THE WHOLE FEATURE. Everything in a closed
  // period has ended, so the basis cannot change a single number. If this ever
  // fails, a gate was changed that should not have been.
  it('for a CLOSED period the two bases are identical', () => {
    const realized = buildHostRows(past, NOW_MS, [], 'realized')
    const expected = buildHostRows(past, NOW_MS, [], 'expected')
    expect(expected).toEqual(realized)
  })

  it('moderators: unfinished shift excluded when realized, included when expected', () => {
    const streams = [{
      id: 's1', brand_id: 'b1', moderator_id: 'm1',
      moderator: { name: 'Carol', rate_cents: 2000 },
      start_time: '2026-06-10T18:00:00.000Z', end_time: '2026-06-10T20:00:00.000Z',
    }]
    expect(buildModeratorRows(streams, NOW_MS)).toEqual([])
    const rows = buildModeratorRows(streams, NOW_MS, undefined, [], 'expected')
    expect(rows).toHaveLength(1)
    expect(rows[0].unworkedHours).toBeGreaterThan(0)
  })

  // Prep realizes on the SESSION end, a gate of its own. Under expected it must
  // come along, matching what the admin payroll pages already show.
  //
  // Dated AFTER PREP_CUTOFF_ISO (2026-07-22) on purpose: before the cutoff a
  // session earns the OLD setup bonus instead, so a pre-cutoff date would test
  // nothing about prep. It is also after NOW_MS, so the session is unfinished —
  // which is the whole point.
  it('moderators: prep on an unfinished session is paid under expected', () => {
    const streams = [{
      id: 's1', brand_id: 'b1', moderator_id: 'm1',
      moderator: { name: 'Carol', rate_cents: 2000 },
      start_time: '2026-07-25T18:00:00.000Z', end_time: '2026-07-25T20:00:00.000Z',
    }]
    expect(buildModeratorRows(streams, NOW_MS)).toEqual([]) // realized: nothing
    const rows = buildModeratorRows(streams, NOW_MS, undefined, [], 'expected')
    expect(rows[0].prepCents).toBe(1000)  // round(2000 x 30/60)
    expect(rows[0].prepHours).toBe(0.5)
    // 2h live + 0.5h prep, all of it still to come.
    expect(rows[0].totalHours).toBe(2.5)
    expect(rows[0].unworkedHours).toBe(2.5)
  })

  // Extra pay HAS a real cancel state and it must keep working under BOTH
  // bases — 'expected' relaxes "has it finished", never "was it cancelled".
  it('extra pay: unfinished is paid under expected, but canceled never is', () => {
    const slot = (over: Partial<ExtraPaySlotRow>): ExtraPaySlotRow => ({
      id: 'e1', host_id: 'h1', host: { name: 'Alice' }, moderator_id: null, moderator: null,
      kind: 'training', rate_cents: 2000, status: 'scheduled',
      start_time: '2026-06-10T09:00:00.000Z', end_time: '2026-06-10T11:00:00.000Z',
      ...over,
    })
    const paid = buildHostRows([], NOW_MS, [slot({})], 'expected')
    expect(paid).toHaveLength(1)
    expect(paid[0].extraCents).toBe(4000)
    expect(paid[0].unworkedHours).toBe(2)

    expect(buildHostRows([], NOW_MS, [slot({ status: 'canceled' })], 'expected')).toEqual([])
    expect(buildHostRows([], NOW_MS, [slot({ status: 'canceled' })], 'realized')).toEqual([])
  })

  // The window gates are NOT the realized gate. They strip the caller's ±1 day
  // query padding, and dropping them would pay a straddling session in both
  // periods -- the double-pay bug fixed 2026-08-29. Expected must not relax them.
  it('expected still drops out-of-window padding rows', () => {
    const streams = [
      { id: 'inside', brand_id: 'b1', moderator_id: 'm1',
        moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-06-10T18:00:00.000Z', end_time: '2026-06-10T20:00:00.000Z' },
      { id: 'padding', brand_id: 'b1', moderator_id: 'm1',
        moderator: { name: 'Carol', rate_cents: 2000 },
        start_time: '2026-07-20T18:00:00.000Z', end_time: '2026-07-20T20:00:00.000Z' },
    ]
    const window = { fromISO: '2026-06-01T00:00:00.000Z', toExclusiveISO: '2026-07-01T00:00:00.000Z' }
    const rows = buildModeratorRows(streams, NOW_MS, window, [], 'expected')
    // Only the in-window shift is paid: 2h x $20 = 4000c, plus its prep block.
    expect(rows).toHaveLength(1)
    expect(rows[0].totalHours).toBeLessThan(4)
  })

  it('rowsToCsv emits Unworked Hours only when asked, and Amount Owed stays last', () => {
    const row: PayrollRow = {
      name: 'Alice', role: 'Host', totalHours: 4, amountCents: 10000,
      prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 1.5,
    }
    const without = rowsToCsv([row], false, false, false)
    expect(without.split('\n')[0]).toBe('Name,Role,Total Hours,Amount Owed')

    const withCol = rowsToCsv([row], false, false, true)
    expect(withCol.split('\n')[0]).toBe('Name,Role,Total Hours,Unworked Hours,Amount Owed')
    expect(withCol.split('\n')[1]).toBe('Alice,Host,4.00,1.50,100.00')
    // The contract downstream tooling depends on.
    expect(withCol.split('\n')[0].split(',').pop()).toBe('Amount Owed')
  })
})

describe('sortPayrollRows', () => {
  it('orders Host before Moderator, then by name asc', () => {
    const rows: PayrollRow[] = [
      { name: 'Zed', role: 'Moderator', totalHours: 1, amountCents: 100, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
      { name: 'Bob', role: 'Host', totalHours: 1, amountCents: 100, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
      { name: 'Ann', role: 'Moderator', totalHours: 1, amountCents: 100, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
      { name: 'Amy', role: 'Host', totalHours: 1, amountCents: 100, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
    ]
    expect(sortPayrollRows(rows).map(r => `${r.role}:${r.name}`)).toEqual([
      'Host:Amy', 'Host:Bob', 'Moderator:Ann', 'Moderator:Zed',
    ])
  })
})

describe('rowsToCsv', () => {
  it('emits header + 2-decimal hours and dollars', () => {
    const rows: PayrollRow[] = [
      { name: 'Alice', role: 'Host', totalHours: 5, amountCents: 20000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
      { name: 'Doe, Jane', role: 'Moderator', totalHours: 3, amountCents: 5567, prepHours: 0.5, prepCents: 1000, extraHours: 0, extraCents: 0, unworkedHours: 0 },
    ]
    // Explicit switches: these assertions describe BEHAVIOUR, so they must not
    // silently change meaning when a feature flag's default flips.
    expect(rowsToCsv(rows, true, false)).toBe(
      'Name,Role,Total Hours,Prep Hours,Prep Pay,Amount Owed\n' +
      'Alice,Host,5.00,0.00,0.00,200.00\n' +
      '"Doe, Jane",Moderator,3.00,0.50,10.00,55.67',
    )
  })
  it('emits header only when there are no rows', () => {
    expect(rowsToCsv([], true, false)).toBe('Name,Role,Total Hours,Prep Hours,Prep Pay,Amount Owed')
  })
  it('all kill switches off → exact legacy 4-column format', () => {
    const rows: PayrollRow[] = [
      { name: 'Alice', role: 'Host', totalHours: 5, amountCents: 20000, prepHours: 0, prepCents: 0, extraHours: 0, extraCents: 0, unworkedHours: 0 },
    ]
    expect(rowsToCsv(rows, false, false)).toBe(
      'Name,Role,Total Hours,Amount Owed\n' +
      'Alice,Host,5.00,200.00',
    )
    expect(rowsToCsv([], false, false)).toBe('Name,Role,Total Hours,Amount Owed')
  })
})

// ---------------------------------------------------------------------------
// Extra pay (setup / training / office hours) — migration 057, src/lib/extraPay
// ---------------------------------------------------------------------------

describe('buildHostRows with extra-pay slots', () => {
  const NOW = new Date('2026-12-01T00:00:00.000Z').getTime()

  const hostStream = (over: Partial<HostStreamInput> = {}): HostStreamInput => ({
    host_id: 'h1',
    host: { name: 'Alice', rate_cents: 3000 },
    host_rate_cents: null,
    start_time: '2026-09-07T10:00:00.000Z',
    end_time: '2026-09-07T12:00:00.000Z',
    ...over,
  })

  const extra = (over: Partial<ExtraPaySlotRow> = {}): ExtraPaySlotRow => ({
    id: 'e1',
    host_id: 'h1',
    host: { name: 'Alice' },
    kind: 'training',
    rate_cents: 2000,
    status: 'scheduled',
    start_time: '2026-09-08T10:00:00.000Z',
    end_time: '2026-09-08T12:00:00.000Z',
    ...over,
  })

  it('does not move any existing paycheck when there are no extra slots', () => {
    // The tie-out that matters: adding this feature must be a no-op until a
    // slot actually exists.
    const without = buildHostRows([hostStream()], NOW)
    const withEmpty = buildHostRows([hostStream()], NOW, [])
    expect(withEmpty).toEqual(without)
    expect(withEmpty[0].amountCents).toBe(6000) // 2h @ $30
    expect(withEmpty[0].extraCents).toBe(0)
  })

  it('adds extra pay to the total AND breaks it out as a subset', () => {
    const [row] = buildHostRows([hostStream()], NOW, [extra()])
    expect(row.amountCents).toBe(6000 + 4000) // shift + 2h training @ $20
    expect(row.totalHours).toBe(4)
    expect(row.extraCents).toBe(4000)
    expect(row.extraHours).toBe(2)
    // Subset, not an addition: never sum extra + amount.
    expect(row.extraCents).toBeLessThanOrEqual(row.amountCents)
  })

  it('pays each slot at ITS OWN frozen rate, not a shared one', () => {
    const [row] = buildHostRows([], NOW, [
      extra({ id: 'a', rate_cents: 2000 }),
      extra({ id: 'b', rate_cents: 2500, start_time: '2026-09-09T10:00:00.000Z', end_time: '2026-09-09T12:00:00.000Z' }),
    ])
    expect(row.amountCents).toBe(4000 + 5000)
  })

  it('gives a host with ONLY extra pay a row (otherwise it goes unpaid)', () => {
    const rows = buildHostRows([], NOW, [extra()])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Alice', role: 'Host', amountCents: 4000 })
  })

  it('excludes not-yet-worked slots — Realized uses end <= now', () => {
    const midBlock = new Date('2026-09-08T11:00:00.000Z').getTime()
    const rows = buildHostRows([], midBlock, [extra()])
    expect(rows).toHaveLength(0)
  })

  it('excludes cancelled slots', () => {
    expect(buildHostRows([], NOW, [extra({ status: 'canceled' })])).toHaveLength(0)
  })

  it('keeps extra pay on the right host', () => {
    const rows = buildHostRows([hostStream()], NOW, [
      extra({ host_id: 'h2', host: { name: 'Bob' } }),
    ])
    const alice = rows.find(r => r.name === 'Alice')!
    const bob = rows.find(r => r.name === 'Bob')!
    expect(alice.extraCents).toBe(0)
    expect(bob.extraCents).toBe(4000)
  })

  it('moderator rows never carry extra pay (host-only feature)', () => {
    const rows = buildModeratorRows([], NOW)
    for (const r of rows) expect(r.extraCents).toBe(0)
  })
})

describe('rowsToCsv with extra-pay columns', () => {
  const row = (over: Partial<PayrollRow> = {}): PayrollRow => ({
    name: 'Alice', role: 'Host', totalHours: 4, amountCents: 10000,
    prepHours: 0, prepCents: 0, extraHours: 2, extraCents: 4000, unworkedHours: 0,
    ...over,
  })

  it('adds Extra columns before Amount Owed, which stays last', () => {
    const csv = rowsToCsv([row()], false, true)
    expect(csv.split('\n')[0]).toBe('Name,Role,Total Hours,Extra Hours,Extra Pay,Amount Owed')
    expect(csv.split('\n')[1]).toBe('Alice,Host,4.00,2.00,40.00,100.00')
  })

  it('reverts to the exact legacy shape when both switches are off', () => {
    const csv = rowsToCsv([row()], false, false)
    expect(csv.split('\n')[0]).toBe('Name,Role,Total Hours,Amount Owed')
    expect(csv.split('\n')[1]).toBe('Alice,Host,4.00,100.00')
  })

  it('composes prep and extra columns together in a stable order', () => {
    const csv = rowsToCsv([row({ prepHours: 0.5, prepCents: 1000 })], true, true)
    expect(csv.split('\n')[0]).toBe(
      'Name,Role,Total Hours,Prep Hours,Prep Pay,Extra Hours,Extra Pay,Amount Owed',
    )
  })

  it('keeps every row the same width as the header', () => {
    const csv = rowsToCsv([row(), row({ name: 'Bob' })], true, true)
    const [head, ...body] = csv.split('\n')
    for (const line of body) expect(line.split(',')).toHaveLength(head.split(',').length)
  })
})
