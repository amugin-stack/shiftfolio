import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { BrandsManager } from '@/components/admin/BrandsManager'
import { resolveRole } from '@/lib/role'
import {
  PROFILE_PICKER_COLUMNS, BRAND_NONPRICING_COLUMNS, type Brand, type Producer, type Profile } from '@/lib/supabase/types'

export default async function BrandsPage() {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  // Brand management (including producer assignment) is admin-only.
  if (!effectiveIsAdmin) redirect('/calendar')

  const [{ data: brandsData }, { data: profilesData }, { data: producersData }, pricingData] = await Promise.all([
    // client_rate_cents + contracted_hours_per_month are column-locked (mig 055);
    // fetch brands on the safe columns and merge pricing from the admin RPC.
    supabase.from('brands').select(BRAND_NONPRICING_COLUMNS).order('name'),
    supabase.from('profiles').select(PROFILE_PICKER_COLUMNS).order('email'),
    supabase.from('producers').select('*').order('name'),
    fetchAllRows(() => supabase.rpc('admin_brand_pricing') as never),
  ])

  const pricingByBrandId = new Map<string, { client_rate_cents: number | null; contracted_hours_per_month: number | null }>()
  for (const r of ((pricingData ?? []) as { brand_id: string; client_rate_cents: number | null; contracted_hours_per_month: number | null }[])) {
    pricingByBrandId.set(r.brand_id, { client_rate_cents: r.client_rate_cents, contracted_hours_per_month: r.contracted_hours_per_month })
  }
  const brands = ((brandsData as unknown as Brand[] | null) ?? []).map(b => ({
    ...b,
    client_rate_cents: pricingByBrandId.get(b.id)?.client_rate_cents ?? null,
    contracted_hours_per_month: pricingByBrandId.get(b.id)?.contracted_hours_per_month ?? null,
  }))

  return (
    <div className="p-6">
      <BrandsManager
        initialBrands={brands}
        profiles={(profilesData as Profile[] | null) ?? []}
        producers={(producersData as Producer[] | null) ?? []}
        canEditRates={effectiveIsAdmin}
      />
    </div>
  )
}
