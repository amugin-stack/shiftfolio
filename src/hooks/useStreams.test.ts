import { describe, it, expect } from 'vitest'
import {
  findMergeGroup,
  mergeAdjacentStreams,
  streamsToEvents,
} from '@/hooks/useStreams'
import type { StreamWithRelations } from '@/lib/supabase/types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
//
// Stable UUIDs make assertion failures readable. Times are full ISO strings
// so the Date-based comparison in `streamsTouchAndMatch` exercises the same
// codepath production uses (parse → getTime()).

const BRAND_A = '11111111-1111-4111-8111-111111111111'
const BRAND_B = '22222222-2222-4222-8222-222222222222'
const HOST_A  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOST_B  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MOD_A   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MOD_B   = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PROD_A  = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_X  = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

interface MakeStreamArgs {
  id: string
  start: string
  end: string
  hostId?: string | null
  moderatorId?: string | null
  brandId?: string
  producerId?: string | null
  hostName?: string | null
  moderatorName?: string | null
  brandName?: string
  producerName?: string | null
  notes?: string | null
}

function makeStream(args: MakeStreamArgs): StreamWithRelations {
  const hostId      = args.hostId      === undefined ? HOST_A : args.hostId
  const moderatorId = args.moderatorId === undefined ? MOD_A  : args.moderatorId
  const brandId     = args.brandId     ?? BRAND_A
  const producerId  = args.producerId  === undefined ? PROD_A : args.producerId
  const hostName      = args.hostName      === undefined ? 'Host Alpha'      : args.hostName
  const moderatorName = args.moderatorName === undefined ? 'Moderator Alpha' : args.moderatorName
  const brandName     = args.brandName     ?? 'Brand Alpha'
  const producerName  = args.producerName  === undefined ? 'Producer Alpha'  : args.producerName

  return {
    id: args.id,
    title: null,
    brand_id: brandId,
    host_id: hostId,
    producer_id: producerId,
    moderator_id: moderatorId,
    start_time: args.start,
    end_time: args.end,
    notes: args.notes ?? null,
    created_by: USER_X,
    created_at: '2026-01-01T00:00:00.000Z',
    gmv_cents: null,
    host:      hostId      ? { id: hostId,      name: hostName ?? 'Host' }         : null,
    brand:     { id: brandId, name: brandName },
    producer:  producerId  ? { id: producerId,  name: producerName ?? 'Producer' } : null,
    moderator: moderatorId ? { id: moderatorId, name: moderatorName ?? 'Mod' }     : null,
  }
}

// ---------------------------------------------------------------------------
// findMergeGroup
// ---------------------------------------------------------------------------

describe('findMergeGroup', () => {
  it('returns [anchor] when the list contains a single stream', () => {
    const s = makeStream({
      id: 's1',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const group = findMergeGroup([s], s)
    expect(group).toHaveLength(1)
    expect(group[0].id).toBe('s1')
  })

  it('returns [anchor] when the anchor is not in the streams array', () => {
    // findMergeGroup must always return at least [anchor] so the click
    // handler never deletes/edits nothing.
    const inList = makeStream({
      id: 's-inlist',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const stranger = makeStream({
      id: 's-stranger',
      start: '2026-06-01T12:00:00.000Z',
      end:   '2026-06-01T13:00:00.000Z',
    })
    const group = findMergeGroup([inList], stranger)
    expect(group).toEqual([stranger])
  })

  it('returns [anchor] when the streams array is empty', () => {
    const anchor = makeStream({
      id: 's1',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const group = findMergeGroup([], anchor)
    expect(group).toEqual([anchor])
  })

  it('groups two adjacent streams that share brand + host + moderator', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const group = findMergeGroup([a, b], a)
    expect(group.map(s => s.id)).toEqual(['a', 'b'])
    // Same group regardless of which one is the anchor.
    expect(findMergeGroup([a, b], b).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('does NOT merge two adjacent streams with different brand', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      brandId: BRAND_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      brandId: BRAND_B,
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['a'])
    expect(findMergeGroup([a, b], b).map(s => s.id)).toEqual(['b'])
  })

  it('does NOT merge two adjacent streams with different host', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      hostId: HOST_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      hostId: HOST_B,
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['a'])
  })

  it('does NOT merge two adjacent streams with different moderator', () => {
    // Merge equivalence class = (host_id, moderator_id, brand_id). Producer
    // is intentionally NOT part of it.
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      moderatorId: MOD_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      moderatorId: MOD_B,
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['a'])
  })

  it('DOES merge two adjacent streams with different producer (producer is not part of merge key)', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      producerId: PROD_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      producerId: null,
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('does NOT merge when there is a gap between streams', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:30:00.000Z',
      end:   '2026-06-01T12:30:00.000Z',
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['a'])
  })

  it('does merge across the midnight boundary when end_time === next start_time exactly', () => {
    // The merge predicate is purely "same instant on the timeline" — it has
    // no notion of calendar days. So a 23:00→00:00 shift followed by an
    // 00:00→01:00 shift on the next day collapses into one block as long
    // as host/moderator/brand line up. Calendar day boundaries are a UI
    // concern, not a merge concern.
    const a = makeStream({
      id: 'late',
      start: '2026-06-01T23:00:00.000Z',
      end:   '2026-06-02T00:00:00.000Z',
    })
    const b = makeStream({
      id: 'early',
      start: '2026-06-02T00:00:00.000Z',
      end:   '2026-06-02T01:00:00.000Z',
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['late', 'early'])
  })

  it('does NOT merge when there is a 1-second gap (adjacency is exact)', () => {
    // "Touching" is exact instant-equality, not a tolerance window.
    // 23:59:59 + 00:00:00 (next day) leaves a 1-second hole.
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T23:00:00.000Z',
      end:   '2026-06-01T23:59:59.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-02T00:00:00.000Z',
      end:   '2026-06-02T01:00:00.000Z',
    })
    expect(findMergeGroup([a, b], a).map(s => s.id)).toEqual(['a'])
  })

  it('walks forward and backward from the anchor across three adjacent streams', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const c = makeStream({
      id: 'c',
      start: '2026-06-01T12:00:00.000Z',
      end:   '2026-06-01T13:00:00.000Z',
    })
    // Anchor in the middle exercises both scan directions.
    expect(findMergeGroup([a, b, c], b).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(findMergeGroup([a, b, c], a).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(findMergeGroup([a, b, c], c).map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns the correct sub-group when multiple merge groups exist in the same array', () => {
    // Group 1: a + b touching, host A.
    // Group 2: c standalone (gap before it).
    // Group 3: d + e touching, host B.
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      hostId: HOST_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      hostId: HOST_A,
    })
    const c = makeStream({
      id: 'c',
      start: '2026-06-01T13:00:00.000Z',
      end:   '2026-06-01T14:00:00.000Z',
      hostId: HOST_A,
    })
    const d = makeStream({
      id: 'd',
      start: '2026-06-01T14:00:00.000Z',
      end:   '2026-06-01T15:00:00.000Z',
      hostId: HOST_B,
    })
    const e = makeStream({
      id: 'e',
      start: '2026-06-01T15:00:00.000Z',
      end:   '2026-06-01T16:00:00.000Z',
      hostId: HOST_B,
    })
    const all = [a, b, c, d, e]
    expect(findMergeGroup(all, a).map(s => s.id)).toEqual(['a', 'b'])
    expect(findMergeGroup(all, b).map(s => s.id)).toEqual(['a', 'b'])
    expect(findMergeGroup(all, c).map(s => s.id)).toEqual(['c'])
    expect(findMergeGroup(all, d).map(s => s.id)).toEqual(['d', 'e'])
    expect(findMergeGroup(all, e).map(s => s.id)).toEqual(['d', 'e'])
  })

  it('works regardless of input order (sorts internally by start_time)', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const c = makeStream({
      id: 'c',
      start: '2026-06-01T12:00:00.000Z',
      end:   '2026-06-01T13:00:00.000Z',
    })
    // Shuffled input.
    expect(findMergeGroup([c, a, b], a).map(s => s.id)).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// mergeAdjacentStreams
// ---------------------------------------------------------------------------

describe('mergeAdjacentStreams', () => {
  it('returns [] for empty input', () => {
    expect(mergeAdjacentStreams([])).toEqual([])
  })

  it('returns a single stream unchanged (but as a fresh copy)', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const merged = mergeAdjacentStreams([a])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('a')
    // Visual-only collapse — must not mutate the input.
    expect(merged[0]).not.toBe(a)
  })

  it('collapses two adjacent matching streams into one block ending at the second end_time', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const merged = mergeAdjacentStreams([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('a')           // first stream's id wins
    expect(merged[0].start_time).toBe(a.start_time)
    expect(merged[0].end_time).toBe(b.end_time)
  })

  it('keeps two adjacent streams with different brand separate', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      brandId: BRAND_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      brandId: BRAND_B,
    })
    expect(mergeAdjacentStreams([a, b]).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('collapses two unassigned (null host AND null moderator) touching streams', () => {
    // The source comment promises: "null === null counts as 'same' for
    // host/moderator so two unassigned touching shifts also collapse."
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      hostId: null,
      moderatorId: null,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      hostId: null,
      moderatorId: null,
    })
    const merged = mergeAdjacentStreams([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0].end_time).toBe(b.end_time)
  })

  it('collapses three adjacent matching streams into one block spanning the full range', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const c = makeStream({
      id: 'c',
      start: '2026-06-01T12:00:00.000Z',
      end:   '2026-06-01T13:00:00.000Z',
    })
    const merged = mergeAdjacentStreams([a, b, c])
    expect(merged).toHaveLength(1)
    expect(merged[0].start_time).toBe(a.start_time)
    expect(merged[0].end_time).toBe(c.end_time)
  })

  it('produces multiple output blocks when scattered groups exist', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      hostId: HOST_A,
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
      hostId: HOST_A,
    })
    const gap = makeStream({
      id: 'gap',
      start: '2026-06-01T13:00:00.000Z',
      end:   '2026-06-01T14:00:00.000Z',
      hostId: HOST_A,
    })
    const d = makeStream({
      id: 'd',
      start: '2026-06-01T14:00:00.000Z',
      end:   '2026-06-01T15:00:00.000Z',
      hostId: HOST_B,
    })
    const e = makeStream({
      id: 'e',
      start: '2026-06-01T15:00:00.000Z',
      end:   '2026-06-01T16:00:00.000Z',
      hostId: HOST_B,
    })
    const merged = mergeAdjacentStreams([a, b, gap, d, e])
    expect(merged).toHaveLength(3)
    // Block 1: a+b collapsed.
    expect(merged[0].id).toBe('a')
    expect(merged[0].end_time).toBe(b.end_time)
    // Block 2: gap standalone.
    expect(merged[1].id).toBe('gap')
    // Block 3: d+e collapsed.
    expect(merged[2].id).toBe('d')
    expect(merged[2].end_time).toBe(e.end_time)
  })

  it('does not mutate the input array or its members', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const originalEnd = a.end_time
    const input = [a, b]
    const snapshot = JSON.stringify(input)
    mergeAdjacentStreams(input)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(a.end_time).toBe(originalEnd)
  })
})

// ---------------------------------------------------------------------------
// streamsToEvents
// ---------------------------------------------------------------------------

describe('streamsToEvents', () => {
  it('maps an empty array to an empty array', () => {
    expect(streamsToEvents([])).toEqual([])
  })

  it('maps a fully-populated stream to a FullCalendar event with the right shape', () => {
    const s = makeStream({
      id: 's1',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      hostName: 'Alice',
      brandName: 'Acme',
      producerName: 'Pat',
      moderatorName: 'Morgan',
      notes: 'bring lights',
    })
    const [event] = streamsToEvents([s])
    expect(event.id).toBe('s1')
    expect(event.title).toBe('Alice')
    expect(event.start).toBe('2026-06-01T10:00:00.000Z')
    expect(event.end).toBe('2026-06-01T11:00:00.000Z')
    // Color tokens are part of the contract — calendar styling depends on
    // these being present and stable.
    expect(event.backgroundColor).toBe('#FF4433')
    expect(event.borderColor).toBe('#E03A2C')
    expect(event.textColor).toBe('#ffffff')

    expect(event.extendedProps).toEqual({
      hostName:      'Alice',
      brandName:     'Acme',
      producerName:  'Pat',
      moderatorName: 'Morgan',
      notes:         'bring lights',
      streamId:      's1',
      hostId:        HOST_A,
      brandId:       BRAND_A,
      producerId:    PROD_A,
      moderatorId:   MOD_A,
    })
  })

  it('falls back to "Host TBD" as the title when host is unassigned', () => {
    const s = makeStream({
      id: 's-unassigned',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      hostId: null,
      hostName: null,
    })
    const [event] = streamsToEvents([s])
    expect(event.title).toBe('Host TBD')
    expect(event.extendedProps.hostName).toBeNull()
    expect(event.extendedProps.hostId).toBeNull()
  })

  it('passes through null moderator and producer relations correctly', () => {
    const s = makeStream({
      id: 's-no-mod-no-prod',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
      moderatorId: null,
      moderatorName: null,
      producerId: null,
      producerName: null,
    })
    const [event] = streamsToEvents([s])
    expect(event.extendedProps.moderatorName).toBeNull()
    expect(event.extendedProps.moderatorId).toBeNull()
    expect(event.extendedProps.producerName).toBeNull()
    expect(event.extendedProps.producerId).toBeNull()
  })

  it('preserves order and emits one event per input stream', () => {
    const a = makeStream({
      id: 'a',
      start: '2026-06-01T10:00:00.000Z',
      end:   '2026-06-01T11:00:00.000Z',
    })
    const b = makeStream({
      id: 'b',
      start: '2026-06-01T11:00:00.000Z',
      end:   '2026-06-01T12:00:00.000Z',
    })
    const c = makeStream({
      id: 'c',
      start: '2026-06-01T12:00:00.000Z',
      end:   '2026-06-01T13:00:00.000Z',
    })
    const events = streamsToEvents([a, b, c])
    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c'])
  })
})
