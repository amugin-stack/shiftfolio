'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import type { EventContentArg, EventClickArg, EventInput } from '@fullcalendar/core'
import { AlertTriangle } from 'lucide-react'
import { APP_TIMEZONE, formatPT } from '@/lib/utils'
import { maxConcurrentByEventId, concurrentEvents } from '@/lib/masterSchedule'
import type { ScheduleView, MasterEvent } from '@/lib/masterSchedule'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface MasterScheduleViewProps {
  view: ScheduleView
  /** 'YYYY-MM-DD' anchor (PT-naive) */
  dateKey: string
  /** Pre-built, brand-colored events */
  events: MasterEvent[]
  /** 'HH:MM:SS' */
  slotMinTime: string
  /** 'HH:MM:SS' */
  slotMaxTime: string
}

/** Distinct brand for the legend: dedupe by brandId, keep first-seen order. */
interface LegendBrand {
  brandId: string
  brandName: string
  bg: string
}

export function MasterScheduleView({
  view,
  dateKey,
  events,
  slotMinTime,
  slotMaxTime,
}: MasterScheduleViewProps) {
  // The live the admin clicked — drives the "who's live" detail dialog.
  const [selected, setSelected] = useState<MasterEvent | null>(null)

  // Per-tile concurrency count = max lives simultaneously live within that
  // tile's span. 2 gets a subtle badge, 3+ a red one; solo (1) gets nothing.
  const countById = useMemo(() => maxConcurrentByEventId(events), [events])

  // FullCalendar event inputs — brand color + context via extendedProps.
  const fcEvents: EventInput[] = useMemo(
    () =>
      events.map((e) => ({
        id: e.id,
        start: e.start,
        end: e.end,
        backgroundColor: e.bg,
        borderColor: e.border,
        textColor: e.text,
        extendedProps: { brandName: e.brandName, hostName: e.hostName },
      })),
    [events],
  )

  // Distinct brands present, first-seen order, for the legend swatches.
  const legendBrands: LegendBrand[] = useMemo(() => {
    const seen = new Set<string>()
    const out: LegendBrand[] = []
    for (const e of events) {
      if (seen.has(e.brandId)) continue
      seen.add(e.brandId)
      out.push({ brandId: e.brandId, brandName: e.brandName, bg: e.bg })
    }
    return out
  }, [events])

  function renderEventContent(arg: EventContentArg) {
    const brandName = arg.event.extendedProps.brandName as string
    const hostName = arg.event.extendedProps.hostName as string | null
    const color = arg.event.textColor || undefined
    const count = countById.get(arg.event.id) ?? 1
    return (
      <div
        className="absolute inset-0 flex flex-col justify-center px-1.5 overflow-hidden leading-tight"
        style={{ color }}
      >
        {/* Concurrency count — how many lives run at once in this slot. The
            side-by-side split shows it too; the number makes the exact count
            (2, 3, …) readable at a glance without clicking. */}
        {count >= 2 && (
          <span
            className="absolute top-0.5 right-0.5 rounded px-1 text-[0.6rem] font-bold leading-tight tabular-nums bg-black/20"
            title={`${count} live at the same time`}
          >
            {count}
          </span>
        )}
        <span className="text-[0.7rem] font-semibold truncate pr-4">{brandName}</span>
        <span className="text-[0.6rem] opacity-80 truncate">{hostName ?? 'Host TBD'}</span>
      </div>
    )
  }

  function handleEventClick(arg: EventClickArg) {
    const ev = events.find((e) => e.id === arg.event.id)
    if (ev) setSelected(ev)
  }

  // Lives concurrent with the selected one (includes itself). >1 means overlap.
  const concurrent = selected ? concurrentEvents(events, selected) : []
  const isOverlapDetail = concurrent.length > 1

  return (
    <div className="h-full flex flex-col gap-3">
      {/* Brand legend — distinct brands present in events */}
      {legendBrands.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {legendBrands.map((b) => (
            <div key={b.brandId} className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-sm border border-border shrink-0"
                style={{ backgroundColor: b.bg }}
              />
              <span className="text-xs text-foreground truncate">{b.brandName}</span>
            </div>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">
          No lives scheduled this {view}.
        </div>
      ) : (
        <div key={`${view}:${dateKey}`} className="flex-1 min-h-0">
          <FullCalendar
            plugins={[timeGridPlugin, interactionPlugin]}
            initialView={view === 'day' ? 'timeGridDay' : 'timeGridWeek'}
            initialDate={dateKey}
            timeZone={APP_TIMEZONE}
            firstDay={1}
            headerToolbar={false}
            editable={false}
            selectable={false}
            // Flush side-by-side columns so concurrent lives read as a single
            // multi-color split column rather than stacked/overlapping tiles.
            slotEventOverlap={false}
            events={fcEvents}
            eventContent={renderEventContent}
            eventClick={handleEventClick}
            slotMinTime={slotMinTime}
            slotMaxTime={slotMaxTime}
            allDaySlot={false}
            height="100%"
            nowIndicator
            expandRows
          />
        </div>
      )}

      {/* Click detail — for an overlap, lists every brand live at that time. */}
      <Dialog open={selected !== null} onOpenChange={(o) => { if (!o) setSelected(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isOverlapDetail && <AlertTriangle className="h-4 w-4 text-amber-500" />}
              {isOverlapDetail ? `${concurrent.length} live at the same time` : 'Live detail'}
            </DialogTitle>
          </DialogHeader>
          <ul className="divide-y divide-border">
            {concurrent.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <span
                  className="inline-block w-3 h-3 rounded-sm border border-border shrink-0"
                  style={{ backgroundColor: e.bg }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">{e.brandName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {e.hostName ?? 'Host TBD'} · {formatPT(e.start, 'h:mm a')} – {formatPT(e.end, 'h:mm a')}
                  </p>
                </div>
                <Link
                  href={`/calendar/${e.brandId}`}
                  onClick={() => setSelected(null)}
                  className="text-xs font-medium text-primary hover:underline shrink-0"
                >
                  Open calendar →
                </Link>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  )
}
