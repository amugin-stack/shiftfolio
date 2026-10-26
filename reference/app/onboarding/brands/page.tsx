import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { BrandRequestSelector } from '@/components/brand/BrandRequestSelector'
import { BRAND_NONPRICING_COLUMNS, type Brand } from '@/lib/supabase/types'

export default async function OnboardingBrandsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const availableBrands = await getAvailableBrands(supabase, user.id)

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-foreground">Pick your brands</h1>
          <p className="text-sm text-muted-foreground">
            Select the brands you&rsquo;d like to host for. An admin will review your request and approve you.
          </p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <BrandRequestSelector
            availableBrands={availableBrands}
            redirectAfter="/calendar"
          />
        </div>

        <div className="text-center">
          <Link
            href="/calendar"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip for now
          </Link>
        </div>
      </div>
    </div>
  )
}

async function getAvailableBrands(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<Brand[]> {
  // Brands MINUS those the user is already linked to (via brand_hosts → hosts.user_id)
  // MINUS those they have a pending request for.
  const [{ data: brandsData }, { data: myHost }, { data: pendingData }] = await Promise.all([
    supabase.from('brands').select(BRAND_NONPRICING_COLUMNS).order('name'),
    supabase.from('hosts').select('id').eq('user_id', userId).maybeSingle(),
    supabase
      .from('brand_host_requests')
      .select('brand_id')
      .eq('host_user_id', userId)
      .eq('status', 'pending'),
  ])

  const brands = (brandsData as Brand[] | null) ?? []
  const pendingIds = new Set(((pendingData as { brand_id: string }[] | null) ?? []).map(r => r.brand_id))

  let linkedIds = new Set<string>()
  if (myHost) {
    const { data: linksData } = await supabase
      .from('brand_hosts')
      .select('brand_id')
      .eq('host_id', (myHost as { id: string }).id)
    linkedIds = new Set(((linksData as { brand_id: string }[] | null) ?? []).map(r => r.brand_id))
  }

  return brands.filter(b => !linkedIds.has(b.id) && !pendingIds.has(b.id))
}
