import { describe, expect, it } from 'vitest'
import { buildSessions, buildSessionsByHost, buildSessionsByPair, gmvPerHourCents, aggregateGmv } from './gmv'
import type { GmvStreamInput, HostedGmvStreamInput, PairedGmvStreamInput, Session } from './gmv'

// PT-naive UTC ISO at a whole UTC hour, e.g. at(16) → 4pm. Only instant
// differences matter here, so the timezone is irrelevant to the math.
const at = (h: number): string => `2026-06-17T${String(h).padStart(2, '0')}:00:00.000Z`

const stream = (over: Partial<GmvStreamInput> & { id: string }): GmvStreamInput => ({
  brand_id: 'brand-a',
  start_time: at(16),
  end_time: at(18),
  gmv_cents: null,
  ...over,
})

describe('buildSessions', () => {
  it('empty input → []', () => {
    expect(buildSessions([])).toEqual([])
  })

  it('single stream → one session (anchor, hours, gmv passthrough)', () => {
    const sessions = buildSessions([
      stream({ id: 's1', start_time: at(16), end_time: at(18), gmv_cents: 10000 }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual<Session>({
      anchorId: 's1',
      brandId: 'brand-a',
      startISO: at(16),
      endISO: at(18),
      hours: 2,
      gmvCents: 10000,
      streamIds: ['s1'],
    })
  })

  it('two touching same-brand streams → ONE session (hours summed, anchor earliest, ids in order)', () => {
    const sessions = buildSessions([
      stream({ id: 's1', start_time: at(16), end_time: at(18), gmv_cents: 10000 }),
      stream({ id: 's2', start_time: at(18), end_time: at(20), gmv_cents: 5000 }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].anchorId).toBe('s1')
    expect(sessions[0].streamIds).toEqual(['s1', 's2'])
    expect(sessions[0].startISO).toBe(at(16))
    expect(sessions[0].endISO).toBe(at(20))
    expect(sessions[0].hours).toBe(4)
    expect(sessions[0].gmvCents).toBe(10000) // anchor's gmv wins
  })

  it('two streams with a GAP → two sessions', () => {
    const sessions = buildSessions([
      stream({ id: 's1', start_time: at(16), end_time: at(18) }),
      stream({ id: 's2', start_time: at(19), end_time: at(21) }), // 1h gap
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.anchorId)).toEqual(['s1', 's2'])
  })

  it('two touching streams but DIFFERENT brand → two sessions', () => {
    const sessions = buildSessions([
      stream({ id: 's1', brand_id: 'brand-a', start_time: at(16), end_time: at(18) }),
      stream({ id: 's2', brand_id: 'brand-b', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.brandId)).toEqual(['brand-a', 'brand-b'])
  })

  it('anchor gmv null but a later stream has gmv → session gmvCents = that value', () => {
    const sessions = buildSessions([
      stream({ id: 's1', start_time: at(16), end_time: at(18), gmv_cents: null }),
      stream({ id: 's2', start_time: at(18), end_time: at(20), gmv_cents: 7500 }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].anchorId).toBe('s1') // anchor stays the earliest stream
    expect(sessions[0].gmvCents).toBe(7500) // first non-null among the session
  })

  it('out-of-order input still groups correctly (sorts by start)', () => {
    const sessions = buildSessions([
      stream({ id: 's2', start_time: at(18), end_time: at(20), gmv_cents: 5000 }),
      stream({ id: 's1', start_time: at(16), end_time: at(18), gmv_cents: 10000 }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].anchorId).toBe('s1')
    expect(sessions[0].streamIds).toEqual(['s1', 's2'])
    expect(sessions[0].gmvCents).toBe(10000)
  })
})

describe('gmvPerHourCents', () => {
  it('10000 cents over 2 hours → 5000', () => {
    expect(gmvPerHourCents(10000, 2)).toBe(5000)
  })

  it('rounds to an integer (10000 / 3 → 3333)', () => {
    expect(gmvPerHourCents(10000, 3)).toBe(3333)
  })

  it('hours 0 → null', () => {
    expect(gmvPerHourCents(10000, 0)).toBeNull()
  })

  it('negative hours → null', () => {
    expect(gmvPerHourCents(10000, -2)).toBeNull()
  })
})

describe('aggregateGmv', () => {
  const session = (over: Partial<Session>): Session => ({
    anchorId: 's',
    brandId: 'brand-a',
    startISO: at(16),
    endISO: at(18),
    hours: 0,
    gmvCents: null,
    streamIds: ['s'],
    ...over,
  })

  it('mixed sessions → only reported ones count toward total/hours/rate', () => {
    const agg = aggregateGmv([
      session({ gmvCents: 10000, hours: 2 }),
      session({ gmvCents: null, hours: 1 }), // un-reported: ignored
      session({ gmvCents: 5000, hours: 1 }),
    ])
    expect(agg.totalGmvCents).toBe(15000)
    expect(agg.reportedHours).toBe(3)
    expect(agg.gmvPerHourCents).toBe(5000)
  })

  it('all-null sessions → {0, 0, null}', () => {
    const agg = aggregateGmv([
      session({ gmvCents: null, hours: 2 }),
      session({ gmvCents: null, hours: 1 }),
    ])
    expect(agg).toEqual<typeof agg>({ totalGmvCents: 0, reportedHours: 0, gmvPerHourCents: null })
  })

  it('empty → {0, 0, null}', () => {
    expect(aggregateGmv([])).toEqual({ totalGmvCents: 0, reportedHours: 0, gmvPerHourCents: null })
  })
})

// Moderators can report GMV (migration 074). A moderator's shifts are NOT
// pre-filtered to a single host the way every previous caller's were, so these
// guard the one thing that would silently corrupt revenue reporting: merging
// two different hosts' work into one session.
describe('buildSessionsByHost', () => {
  const hosted = (
    over: Partial<HostedGmvStreamInput> & { id: string },
  ): HostedGmvStreamInput => ({
    brand_id: 'brand-a',
    host_id: 'host-1',
    start_time: at(16),
    end_time: at(18),
    gmv_cents: null,
    ...over,
  })

  // THE DOUBLE-COUNT GUARD. Same brand, touching in time, but different hosts.
  // buildSessions alone would merge these into one session; the org-wide totals
  // on the Performance tab sum every host's sessions, so one merged session
  // would have its GMV counted for both hosts.
  it('splits touching same-brand streams when the HOST differs', () => {
    const sessions = buildSessionsByHost([
      hosted({ id: 's1', host_id: 'host-1', start_time: at(16), end_time: at(18) }),
      hosted({ id: 's2', host_id: 'host-2', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.anchorId)).toEqual(['s1', 's2'])
  })

  it('buildSessions alone WOULD merge them — proving the partition is what splits', () => {
    const merged = buildSessions([
      { id: 's1', brand_id: 'brand-a', start_time: at(16), end_time: at(18), gmv_cents: null },
      { id: 's2', brand_id: 'brand-a', start_time: at(18), end_time: at(20), gmv_cents: null },
    ])
    expect(merged).toHaveLength(1)
  })

  it('still merges touching same-brand streams for the SAME host', () => {
    const sessions = buildSessionsByHost([
      hosted({ id: 's1', start_time: at(16), end_time: at(18) }),
      hosted({ id: 's2', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].anchorId).toBe('s1')
    expect(sessions[0].streamIds).toEqual(['s1', 's2'])
    expect(sessions[0].hours).toBe(4)
  })

  it('still splits on a brand change within one host', () => {
    const sessions = buildSessionsByHost([
      hosted({ id: 's1', brand_id: 'brand-a', start_time: at(16), end_time: at(18) }),
      hosted({ id: 's2', brand_id: 'brand-b', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(2)
  })

  // A session with no host has no host partition, so any GMV on it is invisible
  // to every admin aggregate. The write RPC rejects those sessions; dropping
  // them here stops the UI offering a row that cannot be saved.
  it('drops streams with no host', () => {
    const sessions = buildSessionsByHost([
      hosted({ id: 's1', host_id: null }),
      hosted({ id: 's2', host_id: 'host-1', start_time: at(20), end_time: at(22) }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].anchorId).toBe('s2')
  })

  it('returns sessions in start-time order across hosts, not grouped by host', () => {
    const sessions = buildSessionsByHost([
      hosted({ id: 'late',  host_id: 'host-1', start_time: at(20), end_time: at(22) }),
      hosted({ id: 'early', host_id: 'host-2', start_time: at(10), end_time: at(12) }),
      hosted({ id: 'mid',   host_id: 'host-1', start_time: at(14), end_time: at(16) }),
    ])
    expect(sessions.map(s => s.anchorId)).toEqual(['early', 'mid', 'late'])
  })

  it('carries GMV through from the anchor, per host', () => {
    const sessions = buildSessionsByHost([
      hosted({ id: 's1', host_id: 'host-1', start_time: at(16), end_time: at(18), gmv_cents: 5000 }),
      hosted({ id: 's2', host_id: 'host-2', start_time: at(18), end_time: at(20), gmv_cents: 9000 }),
    ])
    expect(sessions.map(s => s.gmvCents)).toEqual([5000, 9000])
    // And the totals stay separate — 14000 across two sessions, not 14000 twice.
    expect(aggregateGmv(sessions).totalGmvCents).toBe(14000)
  })

  it('empty in, empty out', () => {
    expect(buildSessionsByHost([])).toEqual([])
  })
})

// The moderator and pairing views aggregate from this. Grouping by moderator
// ALONE would merge two hosts' work into one session -- the same double-count
// buildSessionsByHost prevents, in the other direction.
describe('buildSessionsByPair', () => {
  const paired = (
    over: Partial<PairedGmvStreamInput> & { id: string },
  ): PairedGmvStreamInput => ({
    brand_id: 'brand-a',
    host_id: 'host-1',
    moderator_id: 'mod-1',
    start_time: at(16),
    end_time: at(18),
    gmv_cents: null,
    ...over,
  })

  it('splits touching same-brand, same-host streams when the MODERATOR differs', () => {
    const sessions = buildSessionsByPair([
      paired({ id: 's1', moderator_id: 'mod-1', start_time: at(16), end_time: at(18) }),
      paired({ id: 's2', moderator_id: 'mod-2', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.moderatorId)).toEqual(['mod-1', 'mod-2'])
  })

  it('splits touching same-brand, same-moderator streams when the HOST differs', () => {
    const sessions = buildSessionsByPair([
      paired({ id: 's1', host_id: 'host-1', start_time: at(16), end_time: at(18) }),
      paired({ id: 's2', host_id: 'host-2', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.hostId)).toEqual(['host-1', 'host-2'])
  })

  it('merges when both host and moderator match', () => {
    const sessions = buildSessionsByPair([
      paired({ id: 's1', start_time: at(16), end_time: at(18) }),
      paired({ id: 's2', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].streamIds).toEqual(['s1', 's2'])
  })

  // THE PROPERTY THAT MATTERS. A session whose moderator changes part-way is
  // split, but its GMV lives on the anchor, so exactly one piece carries the
  // figure -- the revenue is counted once, never twice.
  it('counts a mid-session moderator change ONCE, on the anchor side', () => {
    const sessions = buildSessionsByPair([
      paired({ id: 's1', moderator_id: 'mod-1', start_time: at(16), end_time: at(18), gmv_cents: 50_000 }),
      paired({ id: 's2', moderator_id: 'mod-2', start_time: at(18), end_time: at(20) }),
    ])
    expect(sessions).toHaveLength(2)
    expect(aggregateGmv(sessions).totalGmvCents).toBe(50_000)
    const withGmv = sessions.filter(s => s.gmvCents != null)
    expect(withGmv).toHaveLength(1)
    expect(withGmv[0].moderatorId).toBe('mod-1')
  })

  it('keeps unmoderated work, grouped under a null moderator', () => {
    const sessions = buildSessionsByPair([
      paired({ id: 's1', moderator_id: null, gmv_cents: 1_000 }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].moderatorId).toBeNull()
    expect(sessions[0].gmvCents).toBe(1_000)
  })

  it('drops streams with no host', () => {
    expect(buildSessionsByPair([paired({ id: 's1', host_id: null })])).toEqual([])
  })

  it('tags hostId on sessions from buildSessionsByHost too', () => {
    const sessions = buildSessionsByHost([
      { id: 's1', brand_id: 'b', host_id: 'host-9', start_time: at(16), end_time: at(18), gmv_cents: null },
    ])
    expect(sessions[0].hostId).toBe('host-9')
  })
})
