'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Send, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { BrandLogo } from '@/components/brand/BrandLogo'
import type { Brand } from '@/lib/supabase/types'
import { cn } from '@/lib/utils'

interface BrandRequestSelectorProps {
  /** Brands the host can still request — already filtered server-side */
  availableBrands: Brand[]
  /** Where to navigate after a successful submit. Onboarding routes to /calendar; settings stays put. */
  redirectAfter?: string
  /** Called after a fully-successful submit (e.g. close a containing dialog). */
  onSuccess?: () => void
}

export function BrandRequestSelector({ availableBrands, redirectAfter, onSuccess }: BrandRequestSelectorProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit() {
    if (selected.size === 0) return
    setBusy(true)
    const supabase = createClient()
    const ids = Array.from(selected)
    const errors: string[] = []
    for (const id of ids) {
      const { error } = await supabase.rpc('request_brand', { p_brand_id: id })
      if (error) errors.push(error.message)
    }
    setBusy(false)

    if (errors.length === 0) {
      toast({ title: ids.length === 1 ? 'Request sent' : `${ids.length} requests sent` })
      setSelected(new Set())
      onSuccess?.()
      if (redirectAfter) {
        router.push(redirectAfter)
      } else {
        router.refresh()
      }
    } else if (errors.length < ids.length) {
      toast({
        title: 'Some requests failed',
        description: `${ids.length - errors.length} sent, ${errors.length} failed: ${errors[0]}`,
        variant: 'destructive',
      })
      router.refresh()
    } else {
      toast({
        title: 'Could not send requests',
        description: errors[0],
        variant: 'destructive',
      })
    }
  }

  if (availableBrands.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-secondary/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          You&rsquo;re already linked to or pending on every brand. Nothing left to request.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {availableBrands.map(brand => {
          const isSelected = selected.has(brand.id)
          return (
            <li key={brand.id}>
              <button
                type="button"
                onClick={() => toggle(brand.id)}
                className={cn(
                  'w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:bg-secondary/40',
                )}
                aria-pressed={isSelected}
              >
                <BrandLogo name={brand.name} logoPath={brand.logo_path} size="md" />
                <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
                  {brand.name}
                </span>
                <span
                  className={cn(
                    'flex-shrink-0 w-5 h-5 rounded-full border flex items-center justify-center transition-colors',
                    isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-border',
                  )}
                  aria-hidden
                >
                  {isSelected && <Check className="w-3 h-3" />}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-muted-foreground">
          {selected.size === 0
            ? 'Pick the brands you’d like to host.'
            : `${selected.size} selected`}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={busy || selected.size === 0}
          className="gap-1.5"
        >
          <Send className="w-3.5 h-3.5" />
          {busy ? 'Sending…' : `Send ${selected.size > 1 ? selected.size + ' requests' : 'request'}`}
        </Button>
      </div>
    </div>
  )
}
