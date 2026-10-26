import { describe, expect, it } from 'vitest'
import { calendarRange, readIdChunks } from './windowedStreams'

describe('bounded stream requests', () => {
  it('validates finite ordered ranges, including DST wallclock bounds', () => {
    expect(calendarRange('2026-03-08T00:00Z', '2026-03-09T00:00Z')).toEqual({ from: '2026-03-08T00:00:00.000Z', to: '2026-03-09T00:00:00.000Z' })
    for (const [a, b] of [['bad', '2026-01-01'], ['2026-01-02', '2026-01-01'], ['2020-01-01', '2026-01-01']]) expect(() => calendarRange(a, b)).toThrow()
  })
  it('uses bounded identifier chunks without omitting rows', async () => {
    const ids = Array.from({ length: 251 }, (_, i) => `${i}`)
    const sizes: number[] = []
    const rows = await readIdChunks(ids, chunk => {
      sizes.push(chunk.length)
      return { range: async (from, to) => ({ data: chunk.slice(from, to + 1), error: null }) }
    })
    expect(rows).toEqual(ids)
    expect(sizes).toEqual([100, 100, 51])
  })
})
