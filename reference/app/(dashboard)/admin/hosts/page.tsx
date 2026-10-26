import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { HostsManager } from '@/components/admin/HostsManager'
import { resolveRole } from '@/lib/role'
import {
  BRAND_PUBLIC_COLUMNS,
  HOST_PUBLIC_COLUMNS,
  type Brand,
  type BrandHost,
  type Host,
  type HostPublic,
  type Profile,
  PROFILE_PICKER_COLUMNS,
} from '@/lib/supabase/types'

export default async function HostsPage() {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)
  if (!userRoles.isScheduler) redirect('/calendar')

  // rate_cents is column-locked (migration 055) — even admins can't read it
  // via a raw table select. Fetch the host list on the safe columns and merge
  // each rate from the admin-only RPC. This page is admin-only (guard above),
  // so the RPC returns the full map; it returns empty for any non-admin.
  const [
    { data: hostsData },
    { data: profilesData },
    { data: brandsData },
    { data: brandHostsData },
    rateMapData,
    contactsData,
  ] = await Promise.all([
    supabase.from('hosts').select(HOST_PUBLIC_COLUMNS).order('name'),
    supabase.from('profiles').select(PROFILE_PICKER_COLUMNS).order('email'),
    // HostsManager only needs brand id + name + logo to render link badges.
    supabase.from('brands').select(BRAND_PUBLIC_COLUMNS).order('name'),
    supabase.from('brand_hosts').select('*'),
    fetchAllRows(() => supabase.rpc('admin_host_rate_map') as never),
    // email/phone are column-locked (migration 066) because the hosts SELECT
    // policy lets ANY signed-in user read every row — so those columns were
    // downloadable off the raw API by anyone with a token. Admin-only accessor,
    // merged back onto the same objects HostsManager renders.
    fetchAllRows(() => supabase.rpc('admin_host_contacts') as never),
  ])

  const rateByHostId = new Map<string, number>()
  for (const r of ((rateMapData ?? []) as { host_id: string; rate_cents: number }[])) {
    rateByHostId.set(r.host_id, r.rate_cents)
  }
  const contactByHostId = new Map<string, { email: string | null; phone: string | null }>()
  for (const c of ((contactsData ?? []) as { host_id: string; email: string | null; phone: string | null }[])) {
    contactByHostId.set(c.host_id, { email: c.email, phone: c.phone })
  }
  const hosts = ((hostsData as unknown as HostPublic[] | null) ?? [])
    .map(h => ({
      ...h,
      rate_cents: rateByHostId.get(h.id) ?? 0,
      email: contactByHostId.get(h.id)?.email ?? null,
      phone: contactByHostId.get(h.id)?.phone ?? null,
    }))

  return (
    <div className="p-6">
      <HostsManager
        initialHosts={hosts as unknown as Host[]}
        profiles={(profilesData as Profile[] | null) ?? []}
        brands={(brandsData as unknown as Brand[] | null) ?? []}
        initialBrandHosts={(brandHostsData as BrandHost[] | null) ?? []}
        canEditRates={effectiveIsAdmin}
      />
    </div>
  )
}
