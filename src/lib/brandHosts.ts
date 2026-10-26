// Helpers for managing brand_hosts relationships.
//
// Today, an admin unchecking a brand in the HostsManager edit dialog
// silently deletes the brand_hosts link — even when active future
// streams are still assigned to that (host, brand) pair. Those streams
// don't get cancelled or reassigned; they're left orphaned. This file
// centralizes the predicate so the UI can detect that and warn the
// admin before proceeding.

import type { SupabaseClient } from '@supabase/supabase-js'
import { nowPtAsUtc } from '@/lib/utils'

/**
 * Count of "active future" streams assigned to `hostId` on `brandId`.
 * "Active future" = `end_time > now()` in the PT-naive UTC convention.
 *
 * Returns 0 on query error so the calling UI degrades to the no-warning
 * path rather than blocking a save. Callers that need to surface the
 * error should use `supabase.from('streams')...` directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function countActiveFutureStreams(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  brandId: string,
  hostId: string,
): Promise<number> {
  const cutoffIso = nowPtAsUtc().toISOString()
  const { count, error } = await supabase
    .from('streams')
    .select('id', { count: 'exact', head: true })
    .eq('brand_id', brandId)
    .eq('host_id', hostId)
    .gt('end_time', cutoffIso)
  if (error) return 0
  return count ?? 0
}

/**
 * For a batch of (brand, host) pairs the admin is about to unlink,
 * return only the ones with at least one active future stream — plus
 * the per-pair count for warning copy. Used by HostsManager to decide
 * whether to interrupt the save flow with a confirm dialog.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function findOrphanRisks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  hostId: string,
  brandIds: string[],
): Promise<Array<{ brandId: string; count: number }>> {
  const results = await Promise.all(
    brandIds.map(async brandId => ({
      brandId,
      count: await countActiveFutureStreams(supabase, brandId, hostId),
    })),
  )
  return results.filter(r => r.count > 0)
}
