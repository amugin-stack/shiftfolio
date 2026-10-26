import type { createBrowserClient } from '@supabase/ssr'

/** The retained application code has no live database transport. */
export function createClient(): ReturnType<typeof createBrowserClient> {
  throw new Error('Supabase is disabled in the portfolio demo')
}
