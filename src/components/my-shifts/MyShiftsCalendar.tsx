'use client'

// Calendar view of YOUR OWN shifts, for My Shifts.
//
// PRIVACY IS THE POINT (the support team, 2026-08-25): hosts wanted a calendar rather
// than a list, but must NOT see coworkers' shifts — seeing who else works when
// breeds animosity. So this renders exclusively the rows the page already
// fetched for this user (streams where they are the assigned host or
// moderator). It performs NO queries of its own, which means there is no path
// by which another person's shift can reach it. Anyone adding a fetch here is
// re-opening the exact leak migration 052 closed — don't.
//
// This also needs no new permission: hosts can already read their own shifts,
// so this is purely a different presentation of data they hold today.
//
// Read-only by construction: no dateClick, no select, editable={false}. Hosts
// cannot book or edit — only admins schedule (migration 051).

import { useMemo, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import { APP_TIMEZONE, formatCents, formatPT } from '@/lib/utils'
import type { ShiftRow } from './MyShiftsList'

interface MyShiftsCalendarProps {
  shifts: ShiftRow[]
}

/** Stable per-brand hue so a host can tell brands apart at a glance. */
function brandHue(brandId: string): number {
  let h = 0
  for (let i = 0; i < brandId.length; i++) h = (h * 31 + brandId.charCodeAt(i)) % 360
  return h
}

export function MyShiftsCalendar({ shifts }: MyShiftsCalendarProps) {
  const [selected, setSelected] = useState<ShiftRow | null>(null)

  const events = useMemo(
    () =>
      shifts.map(s => {
        const hue = brandHue(s.brandId)
        return {
          id: s.id,
          // Role is worth showing: a user can be host on one brand and
          // moderator on another, and the pay differs.
          title: s.role === 'moderator' ? `${s.brandName} (mod)` : s.brandName,
          start: s.startISO,
          end: s.endISO,
          // Past shifts fade back so the upcoming ones read first.
          backgroundColor: s.isPast ? `hsl(${hue} 30% 42%)` : `hsl(${hue} 65% 45%)`,
          borderColor: s.isPast ? `hsl(${hue} 30% 35%)` : `hsl(${hue} 65% 38%)`,
          textColor: '#fff',
          extendedProps: { shiftId: s.id },
        }
      }),
    [shifts],
  )

  const byId = useMemo(() => new Map(shifts.map(s => [s.id, s])), [shifts])

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border p-2 my-shifts-calendar">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin]}
          initialView="dayGridMonth"
          // PT-naive scheme: stored UTC fields ARE the PT wall-clock, so the
          // calendar must render them verbatim rather than convert. Same
          // setting the brand calendar uses.
          timeZone={APP_TIMEZONE}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,listMonth',
          }}
          events={events}
          editable={false}
          selectable={false}
          dayMaxEvents={3}
          height="auto"
          eventClick={info => {
            const s = byId.get(String(info.event.extendedProps.shiftId))
            if (s) setSelected(s)
          }}
          noEventsContent="No shifts in this range."
        />
      </div>

      {selected && (
        <div className="rounded-lg border border-border p-4 text-sm space-y-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-semibold text-foreground">
                {selected.brandName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {selected.role === 'moderator' ? 'Moderator' : 'Host'}
                </span>
              </p>
              <p className="text-muted-foreground">
                {formatPT(new Date(selected.startISO), 'EEE, MMM d')} ·{' '}
                {formatPT(new Date(selected.startISO), 'h:mm a')} –{' '}
                {formatPT(new Date(selected.endISO), 'h:mm a')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <p className="text-foreground">{formatCents(selected.totalCents)}</p>
          {selected.notes && <p className="text-muted-foreground">{selected.notes}</p>}
        </div>
      )}
    </div>
  )
}
