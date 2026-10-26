'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

/**
 * Shares the FullCalendar nav API between CalendarHeader and CalendarView,
 * which are sibling client components under a server-component page. The
 * brand page wraps both in <CalendarNavProvider /> so the brand banner can
 * render the prev/next/today + view-switcher controls on mobile (saving
 * the vertical real estate FC's own headerToolbar would otherwise eat).
 *
 * CalendarView registers the API once its FullCalendar is mounted; the
 * header reads it on every render and shows nothing if the API isn't ready
 * yet — which only matters for the first frame.
 */

export interface CalendarNavApi {
  prev: () => void
  next: () => void
  today: () => void
  changeView: (viewName: string) => void
}

interface CalendarNavContextValue {
  api: CalendarNavApi | null
  currentView: string
  setApi: (api: CalendarNavApi | null) => void
  setCurrentView: (view: string) => void
}

const CalendarNavContext = createContext<CalendarNavContextValue | null>(null)

export function CalendarNavProvider({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<CalendarNavApi | null>(null)
  const [currentView, setCurrentView] = useState<string>('timeGridWeek')
  return (
    <CalendarNavContext.Provider value={{ api, currentView, setApi, setCurrentView }}>
      {children}
    </CalendarNavContext.Provider>
  )
}

/** Returns null when there's no provider above — components stay usable
 *  standalone (the mobile nav just doesn't render). */
export function useCalendarNav(): CalendarNavContextValue | null {
  return useContext(CalendarNavContext)
}
