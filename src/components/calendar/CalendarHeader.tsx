'use client'

import { useEffect, useState } from 'react'
import { Settings, Mic, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Brand } from '@/lib/supabase/types'
import { Button } from '@/components/ui/button'
import { ShiftSettingsDialog } from './ShiftSettingsDialog'
import { minutesToLabel } from '@/lib/utils'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { useCalendarNav } from './CalendarNavContext'

interface CalendarHeaderProps {
  brand: Brand
  canEdit: boolean
  /** Name of the producer assigned to this brand, if any. Shown next to
   *  the brand info so everyone viewing the calendar knows who runs it. */
  producerName?: string | null
}

// View identifiers tracked here mirror what FullCalendar reports via datesSet
// (also mirrored into CalendarNavContext.currentView). The button group on
// mobile lets the user flip between Day / Week / List.
const MOBILE_VIEWS: Array<{ id: string; label: string }> = [
  { id: 'timeGridDay',  label: 'Day' },
  { id: 'timeGridWeek', label: 'Week' },
  { id: 'listWeek',     label: 'List' },
]

export function CalendarHeader({ brand, canEdit, producerName }: CalendarHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Mobile detection mirrors CalendarView's pattern (matchMedia ≤767px).
  // SSR returns false so first paint matches desktop, then we swap on
  // hydration if we landed on a phone.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)')
    setIsMobile(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Mobile nav reads CalendarView's FullCalendar API from context. While the
  // calendar is mounting the API is null and the nav buttons stay disabled —
  // briefly, only on first frame.
  const navCtx = useCalendarNav()
  const navApi = navCtx?.api ?? null
  const currentView = navCtx?.currentView ?? 'timeGridWeek'

  const blockCount = Math.floor(
    (brand.day_end_minutes - brand.day_start_minutes) / brand.block_size_minutes
  )

  return (
    <>
      <div className="px-4 md:px-6 pt-4 md:pt-5 pb-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-border">
        <div className="min-w-0 flex-1 flex items-center gap-3">
          <BrandLogo name={brand.name} logoPath={brand.logo_path} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold text-foreground truncate">{brand.name}</h1>
            <div className="flex items-center gap-2 mt-1 text-xs flex-wrap">
              <span className="text-muted-foreground">
                {blockCount} × {brand.block_size_minutes}-min shifts ·{' '}
                {minutesToLabel(brand.day_start_minutes)} – {minutesToLabel(brand.day_end_minutes)}
              </span>
              {producerName && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-foreground font-medium">
                  <Mic className="w-3 h-3 text-muted-foreground" />
                  Producer: <span className="text-foreground">{producerName}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Mobile nav — prev/next/today + Day/Week/List. Lives inside the
            brand banner so FC's own headerToolbar (disabled on mobile in
            CalendarView) doesn't eat a second row of vertical space. Drives
            the calendar via the API exposed through CalendarNavContext. */}
        {isMobile && (
          <div className="flex items-center justify-between gap-1 -mt-1">
            <div className="flex items-center gap-0.5">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => navApi?.prev()}
                disabled={!navApi}
                aria-label="Previous"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => navApi?.next()}
                disabled={!navApi}
                aria-label="Next"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => navApi?.today()}
                disabled={!navApi}
              >
                Today
              </Button>
            </div>
            <div className="flex items-center gap-0.5">
              {MOBILE_VIEWS.map(v => {
                const active = currentView === v.id
                return (
                  <Button
                    key={v.id}
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 px-2 text-xs"
                    onClick={() => navApi?.changeView(v.id)}
                    disabled={!navApi}
                  >
                    {v.label}
                  </Button>
                )
              })}
            </div>
          </div>
        )}

        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="w-3.5 h-3.5" />
            Shift Settings
          </Button>
        )}
      </div>
      {canEdit && (
        <ShiftSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          brand={brand}
        />
      )}
    </>
  )
}
