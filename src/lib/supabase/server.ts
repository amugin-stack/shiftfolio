import type { createServerClient } from '@supabase/ssr'

/** The retained application code has no live database transport. */
export async function createClient(): Promise<ReturnType<typeof createServerClient>> {
  throw new Error('Supabase is disabled in the portfolio demo')
}
