import { cookies } from 'next/headers'
import type { Profile } from '@/lib/supabase/types'
import type { SupabaseClient } from '@supabase/supabase-js'

export const VIEW_AS_HOST_COOKIE = 'view_as_host'

export interface ResolvedRole {
  /** True iff profiles.role === 'admin' (the real DB-backed role). */
  actualIsAdmin: boolean
  /** True iff a true admin has opted into "viewing as host". */
  viewingAsHost: boolean
  /** What the UI should treat the user as. */
  effectiveIsAdmin: boolean
}

export interface UserRoles {
  isAdmin: boolean       // effective admin (real admin AND not view-as-host)
  isHost: boolean        // a hosts row exists for this user
  isProducer: boolean    // a producers row links to this user
  isModerator: boolean   // a moderators row links to this user
  /** Schedulers (admin OR producer) can create/edit/delete streams, manage
   *  the hosts/brands/producers/moderators rosters, and decide host requests.
   *  Mirrors the DB-side public.is_scheduler() helper. */
  isScheduler: boolean
  hostId: string | null
  producerId: string | null
  moderatorId: string | null
  /** True when this user's ONLY link to the app is a deactivated host and/or
   *  moderator record (migration 054) — i.e. they have been removed from the
   *  roster but their login still exists. Access is blocked for these users
   *  (the support team 2026-08-25). Admins and producers are never deactivated this way,
   *  and a user with any ACTIVE role is unaffected. */
  isDeactivated: boolean
  // NOTE: moderatorRateCents was REMOVED here by the pay-column lock
  // (migration 055). rate_cents is no longer readable from the moderators
  // table by the app's role, so a viewer's own rate now comes from the
  // get_my_pay_context RPC at the surfaces that actually need it. Resolving
  // roles must not require a pay read.
}

/**
 * Resolve the effective role for the current request.
 *
 * Only true admins can opt into host preview — the cookie is ignored
 * for everyone else, so a non-admin planting `view_as_host=1` has no
 * effect.
 */
export async function resolveRole(profile: Profile | null): Promise<ResolvedRole> {
  const c = await cookies()
  const actualIsAdmin = profile?.role === 'admin'
  const viewingAsHost = actualIsAdmin && c.get(VIEW_AS_HOST_COOKIE)?.value === '1'
  return {
    actualIsAdmin,
    viewingAsHost,
    effectiveIsAdmin: actualIsAdmin && !viewingAsHost,
  }
}

/**
 * Resolve all role memberships for the current user in a single round-trip.
 * `effectiveIsAdmin` from resolveRole flows in so that an admin viewing-as-host
 * is reported as `isAdmin: false`, matching the rest of the UI.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveUserRoles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  userId: string,
  effectiveIsAdmin: boolean,
): Promise<UserRoles> {
  const [hostRes, producerRes, moderatorRes] = await Promise.all([
    supabase.from('hosts').select('id, is_active').eq('user_id', userId).maybeSingle(),
    supabase.from('producers').select('id').eq('user_id', userId).maybeSingle(),
    // rate_cents is NOT selected: migration 055 revokes it from the app's role,
    // and requesting a locked column makes PostgREST error the whole query
    // rather than return null — which would break role resolution for
    // everyone. Own-rate reads moved to the get_my_pay_context RPC.
    supabase.from('moderators').select('id, is_active').eq('user_id', userId).maybeSingle(),
  ])
  const { data: hostRow } = hostRes
  const { data: producerRow } = producerRes
  const { data: moderatorRow } = moderatorRes
  // Surface the duplicate-link failure instead of swallowing it. PostgREST's
  // maybeSingle() returns `data: null, error: PGRST116` when it matches MORE
  // THAN ONE row, and hosts/moderators/producers.user_id had no uniqueness
  // guarantee (fixed by migration 060). Discarding `error` here made a
  // duplicated link indistinguishable from "no record": the person silently
  // became role-less — no shifts, no pay, no error anywhere — while their data
  // sat untouched in the DB. Logging it is what turns a mystery support ticket
  // into a one-line diagnosis.
  for (const [table, res] of [
    ['hosts', hostRes], ['producers', producerRes], ['moderators', moderatorRes],
  ] as const) {
    if (res.error) {
      console.error(
        `[resolveUserRoles] ${table} lookup failed for user ${userId} — treating as NO ${table} link:`,
        res.error.message,
      )
    }
  }

  const host = hostRow as { id: string; is_active: boolean } | null
  const moderator = moderatorRow as { id: string; is_active: boolean } | null
  const isProducer = !!producerRow

  // Deactivating someone (migration 054) removes them from rosters but left
  // their login working — they could still sign in and browse their old
  // shifts. Block that: a user whose ONLY links are deactivated records has no
  // business in the app. Requires at least one link to exist, so a brand-new
  // account with no roles yet still falls through to the normal onboarding
  // path rather than being told its access was removed. Admins and producers
  // are never gated here — there is no is_active on those roles.
  const hasAnyLink = !!host || !!moderator
  const hasActiveLink = (host?.is_active ?? false) || (moderator?.is_active ?? false)
  const isDeactivated =
    !effectiveIsAdmin && !isProducer && hasAnyLink && !hasActiveLink

  return {
    isDeactivated,
    isAdmin: effectiveIsAdmin,
    isHost: !!hostRow,
    isProducer,
    isModerator: !!moderatorRow,
    // Only admins schedule (create/edit/delete). Producers are VIEW-ONLY now
    // (the support team 2026-07-21) — they can see all brand schedules but cannot write,
    // so they are no longer folded into "scheduler". The DB is the real
    // boundary (migration 051 neutralizes is_scheduler/is_brand_scheduler);
    // this flips every UI write gate + roster-page guard to admin-only too.
    isScheduler: effectiveIsAdmin,
    hostId: (hostRow as { id: string } | null)?.id ?? null,
    producerId: (producerRow as { id: string } | null)?.id ?? null,
    moderatorId: moderator?.id ?? null,
  }
}

/**
 * Brand IDs the given producer is currently assigned to via `brands.producer_id`.
 * Returns an empty array for non-producers or producers with no assignments.
 * Admins should bypass this filter entirely (they see all brands).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getProducerBrandIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  producerId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('brands')
    .select('id')
    .eq('producer_id', producerId)
  return ((data ?? []) as { id: string }[]).map(r => r.id)
}
