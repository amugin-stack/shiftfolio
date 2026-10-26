import type { Profile } from '@/lib/supabase/types'

/**
 * Returns true iff every required onboarding field is non-empty.
 * Used by route guards to decide whether a user must finish onboarding.
 */
export function isProfileComplete(p: Profile | null): boolean {
  if (!p) return false
  const required: (string | null | undefined)[] = [
    p.full_name,
    p.phone,
    p.height,
    p.weight,
    p.hair_color,
    p.eye_color,
    p.top_size,
    p.bottom_size,
    p.shoe_size,
    p.headshot_path,
  ]
  return required.every(v => typeof v === 'string' && v.trim().length > 0)
}
