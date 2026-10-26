import { describe, it, expect, vi, beforeEach } from 'vitest'
import { countActiveFutureStreams, findOrphanRisks } from './brandHosts'

// We don't pull in the real Supabase client. Instead, build a minimal
// chainable mock that mirrors the subset of the query builder we use:
//   .from('streams').select(..., { count, head }).eq().eq().gt()
// and resolves to { count, error }.

interface MockResult { count: number | null; error: { message: string } | null }

function buildMockClient(rowsByQuery: MockResult[]) {
  const queue = [...rowsByQuery]
  const calls: Array<{ eq: Array<[string, unknown]>; gt: Array<[string, unknown]> }> = []

  function chain() {
    const state = { eq: [] as Array<[string, unknown]>, gt: [] as Array<[string, unknown]> }
    const builder = {
      eq(col: string, val: unknown) {
        state.eq.push([col, val])
        return builder
      },
      gt(col: string, val: unknown) {
        state.gt.push([col, val])
        return builder
      },
      then(resolve: (v: MockResult) => unknown) {
        calls.push(state)
        const next = queue.shift() ?? { count: 0, error: null }
        return Promise.resolve(next).then(resolve)
      },
    }
    return builder
  }

  return {
    client: {
      from: () => ({ select: () => chain() }),
    },
    calls,
  }
}

const BRAND_A = '00000000-0000-0000-0000-00000000000a'
const BRAND_B = '00000000-0000-0000-0000-00000000000b'
const HOST = '00000000-0000-0000-0000-000000000001'

describe('countActiveFutureStreams', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T18:00:00.000Z'))
  })

  it('returns the row count for active future streams', async () => {
    const { client, calls } = buildMockClient([{ count: 3, error: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await countActiveFutureStreams(client as any, BRAND_A, HOST)
    expect(n).toBe(3)
    // Filter applied: brand_id, host_id (eq) + end_time (gt with PT-naive UTC iso)
    expect(calls[0].eq).toEqual([['brand_id', BRAND_A], ['host_id', HOST]])
    expect(calls[0].gt[0][0]).toBe('end_time')
    // The PT-naive UTC encoding of "now" should match our fake clock.
    // (We don't pin the exact value to avoid coupling to nowPtAsUtc's
    // implementation; just confirm a valid ISO string was passed.)
    const cutoff = calls[0].gt[0][1] as string
    expect(typeof cutoff).toBe('string')
    expect(new Date(cutoff).toString()).not.toBe('Invalid Date')
  })

  it('returns 0 when count is null', async () => {
    const { client } = buildMockClient([{ count: null, error: null }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await countActiveFutureStreams(client as any, BRAND_A, HOST)
    expect(n).toBe(0)
  })

  it('returns 0 (degrades safely) when the query errors', async () => {
    const { client } = buildMockClient([{ count: 7, error: { message: 'boom' } }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await countActiveFutureStreams(client as any, BRAND_A, HOST)
    // Count is ignored when error is present — fail-open so the save
    // flow isn't blocked by an unrelated transient failure.
    expect(n).toBe(0)
  })
})

describe('findOrphanRisks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T18:00:00.000Z'))
  })

  it('returns only brands with active future streams', async () => {
    const { client, calls } = buildMockClient([
      { count: 0, error: null }, // BRAND_A → no risk
      { count: 4, error: null }, // BRAND_B → at risk
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const risks = await findOrphanRisks(client as any, HOST, [BRAND_A, BRAND_B])
    expect(risks).toEqual([{ brandId: BRAND_B, count: 4 }])
    expect(calls).toHaveLength(2)
  })

  it('returns empty when no brands have active streams', async () => {
    const { client } = buildMockClient([
      { count: 0, error: null },
      { count: 0, error: null },
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const risks = await findOrphanRisks(client as any, HOST, [BRAND_A, BRAND_B])
    expect(risks).toEqual([])
  })

  it('returns empty when the input brand list is empty', async () => {
    const { client } = buildMockClient([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const risks = await findOrphanRisks(client as any, HOST, [])
    expect(risks).toEqual([])
  })
})
