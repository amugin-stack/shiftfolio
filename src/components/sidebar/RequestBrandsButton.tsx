'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { BrandRequestSelector } from '@/components/brand/BrandRequestSelector'
import { BRAND_NONPRICING_COLUMNS, type Brand } from '@/lib/supabase/types'

interface RequestBrandsButtonProps {
  userId: string
}

/**
 * Sidebar entry for hosts. Opens a dialog that lazy-fetches the brands they
 * can still request (excluding linked + already-pending) and lets them send
 * one or more requests in a single submit.
 */
export function RequestBrandsButton({ userId }: RequestBrandsButtonProps) {
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<Brand[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadAvailable = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const supabase = createClient()
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
      const pendingIds = new Set(
        ((pendingData as { brand_id: string }[] | null) ?? []).map(r => r.brand_id),
      )
      let linkedIds = new Set<string>()
      if (myHost) {
        const { data: linksData } = await supabase
          .from('brand_hosts')
          .select('brand_id')
          .eq('host_id', (myHost as { id: string }).id)
        linkedIds = new Set(
          ((linksData as { brand_id: string }[] | null) ?? []).map(r => r.brand_id),
        )
      }
      setAvailable(brands.filter(b => !linkedIds.has(b.id) && !pendingIds.has(b.id)))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load brands')
    } finally {
      setLoading(false)
    }
  }, [userId])

  // Refetch every time the dialog opens so it stays in sync with whatever
  // got approved/denied/requested elsewhere.
  useEffect(() => {
    if (open) loadAvailable()
  }, [open, loadAvailable])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-primary transition-colors"
      >
        <Plus className="w-4 h-4 flex-shrink-0" />
        Request Brands
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Request brands</DialogTitle>
            <DialogDescription>
              Pick brands you&rsquo;d like to host. An admin will review and approve.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="py-8 flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : loadError ? (
            <div className="py-6 px-4 text-center space-y-3">
              <p className="text-sm text-destructive">{loadError}</p>
              <button
                type="button"
                onClick={loadAvailable}
                className="text-sm font-medium text-primary hover:underline"
              >
                Retry
              </button>
            </div>
          ) : available === null ? null : (
            <BrandRequestSelector
              availableBrands={available}
              onSuccess={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
