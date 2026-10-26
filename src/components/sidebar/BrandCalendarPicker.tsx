'use client'

import { useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Search, CalendarDays } from 'lucide-react'
import type { Brand } from '@/lib/supabase/types'
import { cn } from '@/lib/utils'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { activeBrandId, filterBrands } from '@/lib/brandPicker'

interface BrandCalendarPickerProps {
  brands: Brand[]
  /** Mobile drawer close callback — fired on selection so the sheet dismisses
   *  before navigation lands. No-op on desktop. */
  onNavigate?: () => void
}

/** Admin-only replacement for the sidebar's vertical brand list: a searchable
 *  dropdown. The trigger shows the brand whose calendar is currently open;
 *  picking another navigates to its `/calendar/[id]` schedule. */
export function BrandCalendarPicker({ brands, onNavigate }: BrandCalendarPickerProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const activeId = activeBrandId(pathname)
  const activeBrand = brands.find(b => b.id === activeId) ?? null
  const filtered = useMemo(() => filterBrands(brands, query), [brands, query])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) setQuery('') // reset the filter each time it closes
  }

  function selectBrand(id: string) {
    setOpen(false)
    setQuery('')
    onNavigate?.()
    router.push(`/calendar/${id}`)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select a calendar"
          className={cn(
            'flex w-full items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
            activeBrand
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {activeBrand ? (
            <BrandLogo name={activeBrand.name} logoPath={activeBrand.logo_path} size="xs" fallbackIcon />
          ) : (
            <CalendarDays className="w-4 h-4 flex-shrink-0" />
          )}
          <span className="truncate flex-1 text-left">
            {activeBrand ? activeBrand.name : 'Select a calendar'}
          </span>
          <ChevronsUpDown className="w-4 h-4 flex-shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search calendars…"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        {/* Filtered list */}
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No calendars found.</p>
          ) : (
            filtered.map(brand => {
              const isActive = brand.id === activeId
              return (
                <button
                  key={brand.id}
                  type="button"
                  onClick={() => selectBrand(brand.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-2 py-1.5 rounded-sm text-sm text-left transition-colors',
                    isActive
                      ? 'bg-primary/15 text-primary'
                      : 'text-foreground hover:bg-secondary',
                  )}
                >
                  <BrandLogo name={brand.name} logoPath={brand.logo_path} size="xs" fallbackIcon />
                  <span className="truncate flex-1">{brand.name}</span>
                  {isActive && <Check className="w-4 h-4 flex-shrink-0" />}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
