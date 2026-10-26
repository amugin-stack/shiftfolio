import { describe, expect, it, vi } from 'vitest'
import { fetchAllRows, POSTGREST_PAGE_SIZE, type RangeableQuery } from './fetchAll'

/** Fake PostgREST builder over a fixed row set, honouring .range(from, to). */
function fakeTable(rows: number[], opts: { error?: string } = {}) {
  const calls: Array<[number, number]> = []
  const build = (): RangeableQuery<number> => ({
    range(from: number, to: number) {
      calls.push([from, to])
      if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } })
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    },
  })
  return { build, calls }
}

describe('fetchAllRows', () => {
  it('returns everything in one page when the result is short', async () => {
    const { build, calls } = fakeTable([1, 2, 3])
    expect(await fetchAllRows(build, { pageSize: 10 })).toEqual([1, 2, 3])
    expect(calls).toEqual([[0, 9]]) // stopped after the short page
  })

  it('pages past the cap — the exact bug this exists to prevent', async () => {
    // 2500 rows with a 1000-row cap: the old single-shot query returned 1000
    // and silently dropped 1500, blanking the calendar past that point.
    const rows = Array.from({ length: 2500 }, (_, i) => i)
    const { build, calls } = fakeTable(rows)
    const got = await fetchAllRows(build, { pageSize: 1000 })
    expect(got).toHaveLength(2500)
    expect(got[2499]).toBe(2499) // the rows that used to vanish
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('makes one extra call when the total is an exact multiple of the page size', async () => {
    // 2000 rows / 1000 per page: page 2 is full, so we cannot know we are done
    // until an empty page 3 confirms it.
    const { build, calls } = fakeTable(Array.from({ length: 2000 }, (_, i) => i))
    expect(await fetchAllRows(build, { pageSize: 1000 })).toHaveLength(2000)
    expect(calls).toHaveLength(3)
  })

  it('returns an empty array for no rows', async () => {
    const { build } = fakeTable([])
    expect(await fetchAllRows(build, { pageSize: 100 })).toEqual([])
  })

  it('builds a FRESH query per page (PostgREST builders are single-use)', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => i)
    const inner = fakeTable(rows)
    const buildSpy = vi.fn(inner.build)
    await fetchAllRows(buildSpy, { pageSize: 100 })
    expect(buildSpy).toHaveBeenCalledTimes(2)
  })

  it('throws on a query error instead of returning a short list', async () => {
    const { build } = fakeTable([1, 2, 3], { error: 'permission denied' })
    await expect(fetchAllRows(build, { pageSize: 10 })).rejects.toThrow('permission denied')
  })

  it('reports truncation loudly when the runaway guard trips', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => i)
    const { build } = fakeTable(rows)
    const onTruncated = vi.fn()
    await expect(fetchAllRows(build, { pageSize: 100, maxRows: 200, onTruncated })).rejects.toThrow("Incomplete data")
    expect(onTruncated).toHaveBeenCalledWith(200)
  })

  it('clamps page size to the PostgREST cap (a larger page would truncate silently)', async () => {
    const { build, calls } = fakeTable(Array.from({ length: 10 }, (_, i) => i))
    await fetchAllRows(build, { pageSize: 5000 })
    expect(calls[0]).toEqual([0, POSTGREST_PAGE_SIZE - 1])
  })
})

it('never presents 50,001 rows as a complete financial result', async () => {
  const { build } = fakeTable(Array.from({ length: 50_001 }, (_, i) => i))
  await expect(fetchAllRows(build, { onTruncated: () => {} })).rejects.toThrow('Incomplete data')
})
it('accepts exactly the cap only after proving there is no extra row', async () => {
  const { build } = fakeTable([1, 2, 3])
  expect(await fetchAllRows(build, { pageSize: 2, maxRows: 3 })).toEqual([1, 2, 3])
})
