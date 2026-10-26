import { fetchAllRows, type RangeableQuery } from './fetchAll'
import type { SupabaseClient } from '@supabase/supabase-js'

export function calendarRange(from?: string, to?: string, now = new Date()) {
  if (from || to) {
    const start = new Date(from ?? '')
    const end = new Date(to ?? '')
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || +end <= +start || +end - +start > 100 * 86400000) {
      throw new Error('Invalid calendar range. Choose a range of at most 100 days.')
    }
    return { from: start.toISOString(), to: end.toISOString() }
  }
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), -6)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 8)).toISOString(),
  }
}

export async function windowStreamIds(client: SupabaseClient, from: string, to: string, scope: { brand?: string; host?: string; moderator?: string }) {
  return fetchAllRows<string>(() => client.rpc('get_stream_window_ids', {
    p_from: from, p_to: to, p_brand: scope.brand ?? null,
    p_host: scope.host ?? null, p_mod: scope.moderator ?? null,
  }) as never, { maxRows: 5000 })
}

// Chunk the identifier filter as well as paging the response, avoiding URL
// limits and never relying on PostgREST's implicit 1,000-row response cap.
// Chunks are read up to 4 at a time (a calendar reload used to wait on each in
// turn); results are concatenated in chunk order, so id ordering is preserved.
export async function readIdChunks<T>(ids: string[], build: (chunk: string[]) => RangeableQuery<T>) {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
  const results: T[][] = new Array(chunks.length)
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++
      results[i] = await fetchAllRows<T>(() => build(chunks[i]))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker))
  return results.flat()
}
