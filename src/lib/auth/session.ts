import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { resolveUserRoles, type UserRoles } from '@/lib/role'
import type { Profile } from '@/lib/supabase/types'

/**
 * Request-scoped memoization of the "who is this?" work.
 *
 * WHY THIS EXISTS. Rendering any dashboard page used to resolve the caller's
 * identity three or four separate times. The middleware calls getUser(); the
 * dashboard layout calls getUser() again, then fetches the profile, then runs
 * resolveUserRoles (three more queries); then the PAGE inside that layout does
 * the exact same three things over again. getUser() is not a local JWT decode —
 * @supabase/ssr issues a real network request to the Supabase Auth server every
 * time. So a single navigation paid for ~2 redundant auth round-trips and ~5
 * redundant database queries before any actual page data was fetched.
 *
 * React's cache() removes the duplication: the first call inside a given render
 * does the work, and every later call with the same arguments gets the stored
 * result.
 *
 * >>> IS IT SAFE TO CACHE AUTH? Yes, and this is worth being precise about,
 * because "cached identity" is exactly the kind of thing that turns into a
 * user-A-sees-user-B bug. React's cache() is scoped to a SINGLE SERVER RENDER
 * of a SINGLE REQUEST. It is not a module-level variable, not an LRU, and not
 * shared between requests, users, or server instances — the cache is created
 * fresh per request and thrown away when that request finishes. Two concurrent
 * requests from two different people get two independent caches. The layout and
 * the page it renders are the same request, which is precisely the duplication
 * we want to collapse, and nothing wider than that.
 *
 * These are additive helpers. Call sites can migrate one at a time, and any
 * page still calling supabase directly keeps working exactly as before — it
 * just doesn't get the dedup until it switches over.
 */

/**
 * The signed-in user, or null. Wraps supabase.auth.getUser(), which validates
 * the session against the Auth server rather than trusting the cookie.
 */
export const getSessionUser = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
})

/**
 * The caller's profile row. Takes userId explicitly rather than calling
 * getSessionUser() internally so the cache key is the thing that actually
 * determines the result.
 */
export const getSessionProfile = cache(async (userId: string): Promise<Profile | null> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  return data as Profile | null
})

/**
 * Host / producer / moderator memberships. Delegates to the existing
 * resolveUserRoles in src/lib/role.ts — the role logic (including the
 * deactivation rules and the duplicate-link error surfacing) lives there and is
 * unchanged. This only stops it running twice.
 *
 * `effectiveIsAdmin` is part of the cache key on purpose: an admin using the
 * "view as host" toggle resolves to a genuinely different set of roles, and the
 * two results must not be conflated. In practice every caller in a single
 * request derives it from the same profile plus the same cookie, so they share
 * one entry.
 */
export const getSessionRoles = cache(async (
  userId: string,
  effectiveIsAdmin: boolean,
): Promise<UserRoles> => {
  const supabase = await createClient()
  return resolveUserRoles(supabase as SupabaseClient, userId, effectiveIsAdmin)
})

/**
 * Distinct brand ids a moderator has at least one stream assignment on — the
 * moderator half of the brand-visibility rules (the support team 2026-07-21 access model).
 *
 * This exact query ran up to three times per navigation: once in the dashboard
 * layout, once in the /calendar landing page, and then once more in the layout
 * again after that page's redirect. Same request, same answer, three times.
 *
 * Deliberately NOT date-bounded. Bounding it (say, "brands worked in the last
 * 90 days") would quietly remove a brand from a moderator's sidebar the moment
 * they went a while without a shift on it — a product decision for the support team, not
 * something to slip in as a performance tweak. The row set here is unchanged;
 * it just stops being fetched repeatedly.
 */
export const getModeratorBrandIds = cache(async (): Promise<Set<string>> => {
  const supabase = await createClient()
  // ONE round trip, ~20 rows.
  //
  // This runs in the dashboard LAYOUT, so it fires on every navigation a
  // moderator makes. It used to fetch one row per lifetime assignment -- paged,
  // so multiple SEQUENTIAL round trips, each re-evaluating the streams RLS
  // policy over every preceding row -- and then reduce all of it to a Set of at
  // most ~20 brand ids. A moderator with 1,500 assignments paid for 1,500 rows
  // on every page load to compute 8 uuids.
  //
  // my_moderator_brand_ids() (migration 070) does the DISTINCT in the database.
  // It is SECURITY DEFINER, so the ownership rule lives in its own WHERE --
  // this moderator, and only while still active -- which is the same boundary
  // migration 058 enforces, in one readable place.
  //
  // No moderatorId argument: the function derives identity from auth.uid(),
  // so a caller cannot ask for someone else's brands.
  const { data, error } = await supabase.rpc('my_moderator_brand_ids')
  if (error) throw new Error(error.message)
  return new Set(((data ?? []) as { brand_id: string }[]).map(r => r.brand_id))
})
