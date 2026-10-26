'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { VIEW_AS_HOST_COOKIE } from './role'
import type { Profile } from '@/lib/supabase/types'

/**
 * Toggle the "view as host" cookie. Server-side enforced: only true admins
 * (profiles.role === 'admin') can flip the cookie on. Anyone else who calls
 * this action is a no-op — defense in depth alongside hiding the button.
 */
export async function toggleViewAsHost() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const { data: profileData } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  const profile = profileData as Pick<Profile, 'role'> | null
  if (profile?.role !== 'admin') return

  const c = await cookies()
  const on = c.get(VIEW_AS_HOST_COOKIE)?.value === '1'
  if (on) {
    c.delete(VIEW_AS_HOST_COOKIE)
  } else {
    c.set(VIEW_AS_HOST_COOKIE, '1', {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
    })
  }
  revalidatePath('/', 'layout')
}
