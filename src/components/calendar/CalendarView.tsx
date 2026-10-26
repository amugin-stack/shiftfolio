'use client'

import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect, startTransition } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import listPlugin from '@fullcalendar/list'
import type {
  EventContentArg,
  EventClickArg,
  SlotLabelContentArg,
  EventInput,
  DayCellContentArg,
  DatesSetArg,
} from '@fullcalendar/core'
import type { DateClickArg } from '@fullcalendar/interaction'
import { MousePointerSquareDashed, X, Clock, Lock, CheckCircle2, UserPlus, Copy } from 'lucide-react'
import { CopyWeekDialog } from './CopyWeekDialog'
import { format } from 'date-fns'
import { planCalendarWindow } from '@/lib/calendarWindow'
import { streamsToEvents, mergeAdjacentStreams, findMergeGroup } from '@/hooks/useStreams'
import {
  computePrepBlocks,
  beforeOpenMarkerStartISO,
  PREP_TIME_ENABLED,
  type PrepStreamInput,
} from '@/lib/prepTime'
import { StreamEventModal } from './StreamEventModal'
import type { StreamWithRelations, HostPublic, Producer, Moderator } from '@/lib/supabase/types'
import { useToast } from '@/hooks/use-toast'
import {
  minutesToTimeString,
  rateKey,
  APP_TIMEZONE,
  utcToPt,
  ptWallClockToUtc,
  nowPtAsUtc,
} from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'
import { useCalendarNav } from './CalendarNavContext'

// Prep-time blue triple. Live blocks keep the existing booked color
// (BOOKED_BG in useStreams.ts — the brand-accent orange); prep gets its own
// blue so the moderator reads "arrive here" vs "live here" at a glance.
const PREP_BG = '#3B82F6'
const PREP_BORDER = '#2563EB'
const PREP_TEXT = '#ffffff'

// ---------------------------------------------------------------------------
// FullCalendar option identity
// ---------------------------------------------------------------------------
// @fullcalendar/react calls calendar.resetOptions(Object.assign({}, this.props))
// on EVERY React render, and FullCalendar's internal short-circuit is reference
// equality per option. Any option handed a fresh identity flips its internal
// `anyChanges` flag, and that flag is all-or-nothing: one unstable option costs
// a full ~150-option re-refine plus a complete grid repaint, which re-invokes
// eventContent and eventClassNames for every event and every background cell.
//
// So every callback below is either hoisted to module scope (when it closes
// over nothing) or wrapped in useCallback (when it can't be). Stabilising only
// SOME of them is worth exactly nothing — the flag flips either way. Treat this
// as one unit: if you add a new inline arrow to the <FullCalendar> props below,
// you have undone all of it.
//
// Note FullCalendar has per-option comparators for `plugins`, `headerToolbar`,
// `buttonText` and `events` (isMaybeArraysEqual / isMaybeObjectsEqual), so
// those four are already free and are deliberately left inline.

/** `now` for the now-indicator. FC runs with timeZone="UTC" while our stored
 *  times are PT wall-clock encoded as UTC, so the indicator has to follow the
 *  same convention to line up with the slot grid — which is exactly what
 *  nowPtAsUtc() produces. Module scope: closes over nothing. */
const NOW_PT = () => nowPtAsUtc()

/** `dayCellClassNames`. Greys out days before the current PT day.
 *  Module scope: closes over nothing (reads only arg.date and the PT helpers).
 *  Still recomputes "today" on every call, so it cannot go stale across PT
 *  midnight — same behaviour as when this was inline. */
function pastDayClassNames(arg: DayCellContentArg): string[] {
  // PT "today" boundary: anything ending before now (in UTC instants) is past.
  // arg.date is the UTC instant for the day's start in PT. nowPtAsUtc(), not
  // new Date() — a raw Date is real UTC now, so from 5pm PT onward this dimmed
  // TODAY as if it were past. eventClassNames below already does this right.
  const ptNow = utcToPt(nowPtAsUtc())
  ptNow.setHours(0, 0, 0, 0)
  const todayUtcMs = ptWallClockToUtc(ptNow).getTime()
  return arg.date.getTime() < todayUtcMs ? ['past-day'] : []
}

interface ShiftConfig {
  blockSizeMinutes: number
  dayStartMinutes: number
  dayEndMinutes: number
}

interface ConflictBooking {
  start_time: string
  end_time:   string
  brandName:  string
}

interface CalendarViewProps {
  brandId: string
  loadedRange?: { from: string; to: string }
  initialDate?: string
  initialStreams: StreamWithRelations[]
  initialHosts: HostPublic[]
  initialProducers: Producer[]
  initialModerators: Moderator[]
  shift: ShiftConfig
  /** Real admin — gates Group Selection (multi-cell range booking) and
   *  other admin-exclusive features. */
  isAdmin: boolean
  /** Admin OR producer — gates non-rate scheduling power: editing stream
   *  assignments, bypassing chain-lock / conflicts, seeing blocked cells. */
  isScheduler: boolean
  /** When false, the calendar renders read-only — no booking, no rate-cell
   *  click, no chain-lock indicator. Moderators on a brand they don't host
   *  see this mode. */
  canBook: boolean
  /** Drives role-specific UI gating beyond canBook. Moderators get a sparse
   *  schedule (no rate labels, no booking, no select-mode) showing only the
   *  shifts they're assigned to as moderator. */
  viewerMode?: 'admin' | 'host' | 'producer' | 'moderator'
  currentUserId: string
  currentHost: { id: string; name: string } | null
  conflicts: ConflictBooking[]
  /** Stream ids the current user has a pending cancellation request for. */
  pendingCancelStreamIds?: string[]
  /** Moderator viewers only: ALL of the viewer's moderator-assigned streams
   *  (any brand) — the derivation source for synthetic blue prep blocks
   *  (src/lib/prepTime.ts). Empty for every other viewer mode. */
  prepSourceStreams?: PrepStreamInput[]
}

interface SelectedSlot {
  start: Date
  end: Date
  existingStream: StreamWithRelations | null
  /** All streams represented by the merged visual block. [] when the slot
   *  is empty (booking flow); [anchor] for a non-merged single shift; 2+
   *  entries for a merged block. Save/delete cascade across this list so
   *  clicking the visual block edits the whole thing as one unit. */
  mergedSiblings: StreamWithRelations[]
}

export function CalendarView({
  brandId,
  loadedRange,
  initialDate,
  initialStreams,
  initialHosts,
  initialProducers,
  initialModerators,
  shift,
  isAdmin,
  isScheduler,
  canBook,
  viewerMode = 'moderator',
  currentUserId,
  currentHost,
  conflicts,
  pendingCancelStreamIds = [],
  prepSourceStreams = [],
}: CalendarViewProps) {
  // Moderators see a stripped-down schedule: their own assignments only,
  // no rate labels, no empty-cell click, no select-mode controls. This flag
  // gates each affordance independently from canBook so a host who lacks
  // booking rights on a brand (read-only) still sees the rate context.
  const isModeratorView = viewerMode === 'moderator'
  const pendingCancelSet = useMemo(
    () => new Set(pendingCancelStreamIds),
    [pendingCancelStreamIds],
  )
  const [streams, setStreams] = useState<StreamWithRelations[]>(initialStreams)
  const { toast } = useToast()
  const router = useRouter()
  const [rangeLoading, setRangeLoading] = useState(false)
  const loadedFrom = loadedRange?.from
  const loadedTo = loadedRange?.to
  useEffect(() => { setStreams(initialStreams); setRangeLoading(false) }, [initialStreams])
  const calendarRef = useRef<FullCalendar | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(null)

  // Select-mode state for Group Selection (multi-cell range booking)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set())
  // When the admin clicks "Book as one shift" in Group Selection, we hand the
  // contiguous cells to StreamEventModal so it can insert one row per cell
  // (the merge logic stitches them into a visual block). Cleared when the
  // modal closes — that also exits select mode if the booking was the reason
  // the modal was open.
  const [rangeBookingCells, setRangeBookingCells] = useState<
    Array<{ start: Date; end: Date }>
  >([])

  // The select-mode toolbar floats fixed at the viewport bottom. To keep
  // bottom-of-grid shifts reachable underneath it, we measure the toolbar
  // and reserve matching padding on the outer container while select mode
  // is active. ResizeObserver handles flex-wrap on narrow viewports.
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [toolbarHeight, setToolbarHeight] = useState(0)

  // Track which view is currently visible so we can filter out time-grid-only
  // background events (rate labels, conflict overlays) from month view.
  const [currentView, setCurrentView] = useState<string>('timeGridWeek')
  const [copyWeekOpen, setCopyWeekOpen] = useState(false)
  const isTimeGridView = currentView === 'timeGridWeek' || currentView === 'timeGridDay'

  // Mobile detection: hosts are the primary mobile users and a week grid on
  // 375px is unreadable. We default to day view on mobile and hide the month
  // button (which is even worse at that width). SSR returns false so the first
  // paint matches desktop, then we swap on hydration.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)')
    setIsMobile(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Mobile nav lives in CalendarHeader (so it can sit in the brand banner
  // row and reclaim vertical space). It needs to drive THIS calendar's API,
  // so we publish the API + currentView to the shared CalendarNavContext.
  // Context returns null when there's no provider above — components stay
  // standalone-usable.
  const navCtx = useCalendarNav()
  const setNavApi = navCtx?.setApi
  // Same reasoning as setNavApi below: CalendarNavProvider builds its context
  // value as a fresh object literal every render, so anything depending on the
  // whole navCtx can never stabilise. Pulling the setter out gives a stable
  // reference (useState setters never change) for handleDatesSet's dep list —
  // and avoids a feedback loop, since datesSet itself calls setCurrentView.
  const setNavCurrentView = navCtx?.setCurrentView
  useEffect(() => {
    if (!setNavApi) return
    const api = calendarRef.current?.getApi()
    if (!api) return
    setNavApi({
      prev: () => api.prev(),
      next: () => api.next(),
      today: () => api.today(),
      changeView: (v: string) => api.changeView(v),
    })
    return () => setNavApi(null)
    // setNavApi is a useState setter (stable reference), so this effect
    // runs exactly once per mount — registers on mount, clears on unmount.
    // Depending on the full navCtx object would re-fire on every provider
    // re-render, causing setApi → re-render → effect → setApi → ... infinite.
  }, [setNavApi])

  // After hydration, if we landed on mobile, swap the live FC view to day.
  // initialView is fixed at mount, so we do this imperatively. Skip when
  // selectMode is on — that path already forces week view below.
  useEffect(() => {
    if (!isMobile || selectMode) return
    const api = calendarRef.current?.getApi()
    if (api && api.view.type === 'timeGridWeek') api.changeView('timeGridDay')
  }, [isMobile, selectMode])

  // Tracks the last time eventClick handled a click so dateClick can dedupe.
  // FC's interaction plugin sometimes fires both for a single click when
  // cells have overlapping events; without this, selectMode toggles twice
  // and the cell flashes selected then deselects.
  const lastEventClickRef = useRef<number>(0)

  const blockCount = useMemo(
    () => Math.max(0, Math.floor((shift.dayEndMinutes - shift.dayStartMinutes) / shift.blockSizeMinutes)),
    [shift]
  )

  // Measure the floating select-mode toolbar so the outer container can
  // reserve matching bottom padding. Without this, the toolbar overlays
  // the bottom slot rows and shifts there become unclickable.
  useLayoutEffect(() => {
    if (!selectMode || !toolbarRef.current) {
      setToolbarHeight(0)
      return
    }
    const el = toolbarRef.current
    setToolbarHeight(el.getBoundingClientRect().height)
    const ro = new ResizeObserver(([entry]) => {
      setToolbarHeight(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [selectMode])

  // Active visible date range (driven by FC's datesSet)
  const [activeRange, setActiveRange] = useState<{ start: Date; end: Date } | null>(null)

  useEffect(() => {
    if (selectMode) calendarRef.current?.getApi().changeView('timeGridWeek')
  }, [selectMode])

  function blockIndexFromMinutes(slotMins: number): number {
    return Math.round((slotMins - shift.dayStartMinutes) / shift.blockSizeMinutes)
  }

  function snapToCell(date: Date): { start: Date; end: Date; dow: number; idx: number } | null {
    // Treat all wall-clock math in PT — admin scheduling is authored in PT and
    // viewers in other TZs need to see the same wall-clock times.
    const ptDate = utcToPt(date)
    const slotMins = ptDate.getHours() * 60 + ptDate.getMinutes()
    const idx = blockIndexFromMinutes(slotMins)
    if (idx < 0 || idx >= blockCount) return null
    const dow = ptDate.getDay()
    const blockStartMins = shift.dayStartMinutes + idx * shift.blockSizeMinutes
    const blockEndMins   = shift.dayStartMinutes + (idx + 1) * shift.blockSizeMinutes

    // Anchor at PT midnight, then add minutes; convert back to a real UTC instant
    const ptMidnight = new Date(ptDate)
    ptMidnight.setHours(0, 0, 0, 0)
    const startPt = new Date(ptMidnight.getTime() + blockStartMins * 60_000)
    const endPt   = new Date(ptMidnight.getTime() + blockEndMins   * 60_000)
    const start = ptWallClockToUtc(startPt)
    const end   = ptWallClockToUtc(endPt)

    return { start, end, dow, idx }
  }

  // Visually collapse touching shifts that share host + moderator into a single
  // block. The raw `streams` array is intentionally untouched — chain-booking,
  // conflict overlays, occupied-slot detection, and rate labels still operate
  // on individual block slots.
  const events = useMemo(() => streamsToEvents(mergeAdjacentStreams(streams)), [streams])

  // Used to detect "this cell already has a booked stream"
  const occupiedSlotTimes = useMemo(
    () => new Set(streams.map(s => new Date(s.start_time).getTime())),
    [streams]
  )

  // Derived booking range for the Group Selection "Book as one shift" button.
  // Non-null iff the admin's selection is (a) entirely on a single weekday,
  // (b) contiguous block indices, (c) every resulting cell in the active week
  // is in the future, and (d) every cell is unoccupied. The button is disabled
  // when this returns null so admins know what makes a valid range without
  // having to read help text.
  const rangeBooking = useMemo(() => {
    if (selectedCells.size === 0 || !activeRange) return null

    const parsed: Array<{ dow: number; idx: number }> = Array.from(selectedCells).map(key => {
      const [dowStr, idxStr] = key.split('-')
      return { dow: parseInt(dowStr, 10), idx: parseInt(idxStr, 10) }
    })

    // Single weekday → "connecting" requires all cells on the same day.
    const uniqDow = new Set(parsed.map(p => p.dow))
    if (uniqDow.size > 1) return null

    // Contiguous block indices (idxs form a consecutive run).
    const idxs = parsed.map(p => p.idx).sort((a, b) => a - b)
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] !== idxs[i - 1] + 1) return null
    }

    // Resolve the active-week date for that weekday and build the cell list.
    const date = (() => {
      const ptStart = utcToPt(activeRange.start)
      const startDow = ptStart.getDay()
      const offset = (parsed[0].dow - startDow + 7) % 7
      const ptTarget = new Date(ptStart)
      ptTarget.setDate(ptTarget.getDate() + offset)
      ptTarget.setHours(0, 0, 0, 0)
      return ptTarget
    })()

    // Past cells are allowed — schedulers backdate via Group Selection and
    // the shifts count as Realized immediately (current flat rate).
    const cells: Array<{ start: Date; end: Date }> = []
    for (const idx of idxs) {
      const startMin = shift.dayStartMinutes + idx * shift.blockSizeMinutes
      const endMin = shift.dayStartMinutes + (idx + 1) * shift.blockSizeMinutes
      const startPt = new Date(date.getTime() + startMin * 60_000)
      const endPt = new Date(date.getTime() + endMin * 60_000)
      const start = ptWallClockToUtc(startPt)
      const end = ptWallClockToUtc(endPt)
      if (occupiedSlotTimes.has(start.getTime())) return null
      cells.push({ start, end })
    }

    return { cells, spanStart: cells[0].start, spanEnd: cells[cells.length - 1].end }
  }, [
    selectedCells,
    activeRange,
    shift.dayStartMinutes,
    shift.blockSizeMinutes,
    occupiedSlotTimes,
  ])

  // Pre-parse conflicts into [startMs, endMs, brandName] for quick overlap checks
  const parsedConflicts = useMemo(
    () => conflicts.map(c => ({
      startMs: new Date(c.start_time).getTime(),
      endMs:   new Date(c.end_time).getTime(),
      brandName: c.brandName,
    })),
    [conflicts]
  )

  // True if [startMs, endMs) overlaps any of the host's other-brand bookings
  const conflictAt = useCallback((startMs: number, endMs: number): string | null => {
    for (const c of parsedConflicts) {
      if (c.startMs < endMs && c.endMs > startMs) return c.brandName
    }
    return null
  }, [parsedConflicts])

  // Build one orange overlay event per OUR-brand block that overlaps a conflict.
  // Snaps to this brand's grid so different block sizes / day windows align cleanly.
  // Only relevant in time-grid views.
  const conflictEvents: EventInput[] = useMemo(() => {
    if (isScheduler || parsedConflicts.length === 0 || !isTimeGridView) return []
    const out: EventInput[] = []
    // Walk each conflict; generate per-block overlays on our grid for that day.
    // Anchor at PT midnight so cross-brand conflicts line up with our PT grid.
    for (const c of parsedConflicts) {
      const ptAnchor = utcToPt(new Date(c.startMs))
      ptAnchor.setHours(0, 0, 0, 0)
      const midnightUtcMs = ptWallClockToUtc(ptAnchor).getTime()
      for (let idx = 0; idx < blockCount; idx++) {
        const blockStart = midnightUtcMs + (shift.dayStartMinutes + idx * shift.blockSizeMinutes) * 60_000
        const blockEnd   = midnightUtcMs + (shift.dayStartMinutes + (idx + 1) * shift.blockSizeMinutes) * 60_000
        if (c.startMs < blockEnd && c.endMs > blockStart) {
          out.push({
            start: new Date(blockStart).toISOString(),
            end:   new Date(blockEnd).toISOString(),
            display: 'background',
            color: 'rgba(255, 68, 51, 0.55)',
            extendedProps: { __conflict: true, brandName: c.brandName },
          })
        }
      }
    }
    return out
  }, [parsedConflicts, isScheduler, blockCount, shift.dayStartMinutes, shift.blockSizeMinutes, isTimeGridView])

  // Background events: one per (day_of_week × block_index) so each cell shows
  // its specific rate, and selected cells get highlighted in select mode.
  // These only make sense in time-grid views.
  const cellEvents: EventInput[] = useMemo(() => {
    if (!isTimeGridView) return []
    // Moderators don't book or see rate context — skip the per-cell bg events
    // entirely so the grid stays clean and their assignments stand alone.
    if (isModeratorView) return []
    const out: EventInput[] = []
    for (let dow = 0; dow < 7; dow++) {
      for (let idx = 0; idx < blockCount; idx++) {
        const startMin = shift.dayStartMinutes + idx * shift.blockSizeMinutes
        const endMin   = shift.dayStartMinutes + (idx + 1) * shift.blockSizeMinutes
        const isSelected = selectMode && selectedCells.has(rateKey(dow, idx))

        out.push({
          daysOfWeek: [dow],
          startTime: minutesToTimeString(startMin),
          endTime:   minutesToTimeString(endMin),
          display: 'background',
          color: isSelected ? 'rgba(255, 68, 51, 0.32)' : 'transparent',
          extendedProps: { __rateLabel: true, isSelected },
        })
      }
    }
    return out
  }, [blockCount, shift.dayStartMinutes, shift.blockSizeMinutes, selectMode, selectedCells, isTimeGridView, isModeratorView])

  // Synthetic prep blocks — moderator view only, derived per render (never
  // stored, never bookable). One blue 30-min tile immediately before each of
  // the viewer's contiguous sessions on THIS brand. Suppression across their
  // other brands is already baked into computePrepBlocks via the full
  // prepSourceStreams set. Day-window clipping (design doc): a prep window
  // falling outside the brand's visible grid is pay-only — no tile.
  const prepEvents: EventInput[] = useMemo(() => {
    if (!isModeratorView || !PREP_TIME_ENABLED || !isTimeGridView) return []
    const out: EventInput[] = []
    for (const b of computePrepBlocks(prepSourceStreams)) {
      if (b.brandId !== brandId) continue
      const pt = utcToPt(new Date(b.startISO))
      const startMin = pt.getHours() * 60 + pt.getMinutes()
      const inWindow =
        startMin >= shift.dayStartMinutes
        && startMin + b.durationMinutes <= shift.dayEndMinutes
      if (inWindow) {
        // Prep window sits inside the visible grid — render at its true time.
        out.push({
          id: `prep-${b.anchorId}`,
          start: b.startISO,
          end: b.endISO,
          backgroundColor: PREP_BG,
          borderColor: PREP_BORDER,
          textColor: PREP_TEXT,
          extendedProps: { __prep: true },
        })
        continue
      }
      // Before-open case (the common first-of-day shape): prep falls before
      // the brand's grid start. Rather than hide it (pay is still owed), pin
      // a short dashed marker at the top of the grid so the moderator sees
      // prep exists. Skip only the rare after-close case (can't place it).
      if (startMin >= shift.dayStartMinutes) continue // after-close: pay-only
      // Pin the marker at the brand's opening time on the session's calendar
      // day (DST-proof pure-UTC computation — see beforeOpenMarkerStartISO).
      const markerStart = new Date(beforeOpenMarkerStartISO(b.endISO, shift.dayStartMinutes))
      const markerEnd = new Date(markerStart.getTime() + b.durationMinutes * 60_000)
      out.push({
        id: `prep-${b.anchorId}`,
        start: markerStart.toISOString(),
        end: markerEnd.toISOString(),
        backgroundColor: PREP_BG,
        borderColor: PREP_BORDER,
        textColor: PREP_TEXT,
        extendedProps: { __prep: true, __prepBeforeOpen: true },
      })
    }
    return out
  }, [
    isModeratorView,
    isTimeGridView,
    prepSourceStreams,
    brandId,
    shift.dayStartMinutes,
    shift.dayEndMinutes,
  ])

  const allEvents: EventInput[] = useMemo(
    // Conflict overlays only render outside select mode (admins don't see
    // them anyway); stream events stay visible at all times so admins keep
    // context of existing bookings while group-editing rates. Prep blocks
    // are non-empty only in moderator view, which never enters select mode.
    () => (selectMode ? [...cellEvents, ...events] : [...cellEvents, ...conflictEvents, ...prepEvents, ...events]),
    [selectMode, cellEvents, conflictEvents, prepEvents, events]
  )

  function openSlotForDate(date: Date) {
    const cell = snapToCell(date)
    if (!cell) return
    const existing = streams.find(
      s => s.brand_id === brandId && new Date(s.start_time).getTime() === cell.start.getTime()
    ) ?? null
    // Booking gates apply ONLY when creating a NEW booking on an empty slot.
    // Opening an EXISTING shift is always allowed — the modal is read-only for
    // non-schedulers (producers/moderators), so viewing a past or conflicting
    // shift is harmless. Without the `!existing` guard, view-only producers
    // (no longer schedulers post-access-model) couldn't open past shifts at all.
    if (!existing && !isScheduler && conflictAt(cell.start.getTime(), cell.end.getTime())) return
    if (!existing && !isScheduler && cell.end.getTime() <= nowPtAsUtc().getTime()) return
    // For booked slots: walk the merge group so save/delete cascade across
    // every visual block the user thinks they're editing. For empty slots,
    // the booking flow operates on cell.start / cell.end only.
    const mergedSiblings = existing ? findMergeGroup(streams, existing) : []
    const anchor = mergedSiblings[0] ?? null
    const last   = mergedSiblings[mergedSiblings.length - 1] ?? null
    // If a stream already lives in this slot, use the merge group's full
    // span so the modal header shows the real merged time range. Falls back
    // to the snap-cell for empty slots and to existing's own times for
    // single-shift selections.
    const slotStart = anchor ? new Date(anchor.start_time) : cell.start
    const slotEnd   = last   ? new Date(last.end_time)     : cell.end
    setSelectedSlot({
      start: slotStart,
      end:   slotEnd,
      existingStream: anchor,
      mergedSiblings,
    })
    setModalOpen(true)
  }

  const handleEventClick = useCallback((clickInfo: EventClickArg) => {
    const props = clickInfo.event.extendedProps
    // Conflict overlays are decorative — clicking does nothing
    if (props.__conflict) return
    // Prep blocks are derived visuals — not editable, not bookable
    if (props.__prep) return

    const start = clickInfo.event.start
    if (!start) return

    // Mark this click as handled so dateClick (if it fires for the same
    // user click) won't double-toggle the selection state.
    lastEventClickRef.current = Date.now()
    clickInfo.jsEvent?.stopPropagation?.()

    if (selectMode) {
      const cell = snapToCell(start)
      if (!cell) return
      const key = rateKey(cell.dow, cell.idx)
      setSelectedCells(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      return
    }

    // Both rate-label bg events and real stream events route through the same opener
    openSlotForDate(start)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode, streams, blockCount, shift.dayStartMinutes, shift.blockSizeMinutes, conflictAt, isScheduler, isModeratorView])

  const handleDateClick = useCallback((info: DateClickArg) => {
    // Skip if eventClick just handled this same user-click (prevents
    // double-toggle when both fire on overlapping events / cells)
    if (Date.now() - lastEventClickRef.current < 80) return

    // Moderators never interact with empty cells. Their only interactive
    // surface is their own assigned-shift tiles (handled by handleEventClick).
    if (isModeratorView) return

    // In month view, clicking a day jumps to Week view focused on that date
    const view = calendarRef.current?.getApi().view.type
    if (view === 'dayGridMonth') {
      calendarRef.current?.getApi().changeView('timeGridWeek', info.date)
      return
    }

    if (selectMode) {
      const cell = snapToCell(info.date)
      if (!cell) return
      const key = rateKey(cell.dow, cell.idx)
      setSelectedCells(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      return
    }
    // View-only viewers (producers) may navigate month→week above, but must
    // never open the booking modal from an empty cell — only bookers do.
    if (!canBook) return
    openSlotForDate(info.date)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode, streams, blockCount, shift.dayStartMinutes, shift.blockSizeMinutes, canBook])

  function handleSave(savedStream: StreamWithRelations) {
    setStreams(prev => {
      const exists = prev.find(s => s.id === savedStream.id)
      return exists
        ? prev.map(s => s.id === savedStream.id ? savedStream : s)
        : [...prev, savedStream]
    })
    toast({ title: 'Shift updated' })
    // Invalidate Next's Router Cache so the next visit (this brand or another)
    // re-fetches fresh stream + conflict data instead of serving a stale page.
    router.refresh()
  }

  function handleDelete(streamId: string) {
    setStreams(prev => prev.filter(s => s.id !== streamId))
    toast({ title: 'Shift cleared' })
    router.refresh()
  }

  // Body unchanged — only the wrapper. isMobile is the sole component-scope
  // value it closes over (everything else is a module import or comes off
  // eventInfo), so that is the whole dependency list.
  const renderEventContent = useCallback(function renderEventContent(eventInfo: EventContentArg) {
    if (eventInfo.event.extendedProps.__conflict) {
      const brandName = eventInfo.event.extendedProps.brandName as string
      return (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center gap-1.5 px-2 text-center">
          <Lock className="w-3 h-3 text-white shrink-0" />
          <span className="text-xs font-bold text-white leading-tight">
            You are already booked for {brandName}
          </span>
        </div>
      )
    }

    if (eventInfo.event.extendedProps.__prep) {
      // Blue pre-stream prep tile: 30 paid minutes of setup before go-live.
      // When the prep window falls before the brand's opening time it's pinned
      // to the top of the grid as a "before open" marker (label reflects that).
      const beforeOpen = !!eventInfo.event.extendedProps.__prepBeforeOpen
      return (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center gap-1 px-1 overflow-hidden">
          <Clock className="w-3 h-3 text-white/80 shrink-0" />
          <span className="text-[0.6rem] font-bold text-white leading-tight truncate">
            {beforeOpen ? 'Prep · before open' : 'Prep · 30m'}
          </span>
        </div>
      )
    }

    if (eventInfo.event.extendedProps.__rateLabel) {
      // Empty-cell background: just a subtle past-cell clock marker. Rates
      // are flat per host now — nothing to show per cell.
      const cellEnd = eventInfo.event.end
      const isPast = !!cellEnd && cellEnd.getTime() <= nowPtAsUtc().getTime()
      return (
        <div className="absolute inset-0 pointer-events-none">
          {isPast && (
            <Clock className="absolute top-1 left-1 w-3 h-3 text-foreground/30" />
          )}
        </div>
      )
    }
    // Real stream event — render style differs by view
    const streamEnd = eventInfo.event.end
    const streamIsPast = !!streamEnd && streamEnd.getTime() <= nowPtAsUtc().getTime()
    const isMonth = eventInfo.view.type === 'dayGridMonth'
    const hostName      = eventInfo.event.extendedProps.hostName      as string | null
    const moderatorName = eventInfo.event.extendedProps.moderatorName as string | null

    if (isMonth) {
      // Month view has ~1 line of vertical space per tile — show the host
      // only (or "Host TBD" placeholder). The two-line label layout lives
      // in the week / day views where there's room.
      return (
        <div className="px-1.5 py-0.5 overflow-hidden w-full flex items-center gap-1">
          {streamIsPast && <CheckCircle2 className="w-3 h-3 text-white/70 shrink-0" />}
          <span className="block truncate text-[0.7rem] font-medium text-white leading-tight">
            {hostName ?? 'Host TBD'}
          </span>
        </div>
      )
    }

    // Mobile cells are ~48px wide — the desktop layout with "Host: NameOne"
    // and "Moderator: NameTwo" at text-lg gets visibly truncated. Drop the
    // "Host:"/"Moderator:" labels, use first name only, shrink the font,
    // and let `truncate` add an ellipsis if the first name itself is long.
    // Full names + roles stay visible when the user taps to open the modal.
    if (isMobile) {
      const firstName = (full: string | null): string => {
        if (!full) return 'TBD'
        const trimmed = full.trim()
        const space = trimmed.indexOf(' ')
        return space === -1 ? trimmed : trimmed.slice(0, space)
      }
      return (
        <div className="absolute inset-0">
          {streamIsPast && (
            <CheckCircle2 className="absolute top-0.5 right-0.5 w-2.5 h-2.5 text-white/70" />
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-1 text-center overflow-hidden">
            <div className="text-[0.7rem] font-bold text-white leading-tight max-w-full truncate">
              {firstName(hostName)}
            </div>
            {moderatorName && (
              <div className="text-[0.6rem] font-medium text-white/70 leading-tight max-w-full truncate">
                {firstName(moderatorName)}
              </div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="absolute inset-0">
        {streamIsPast && (
          <CheckCircle2 className="absolute top-1 right-1 w-3 h-3 text-white/70" />
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-center overflow-hidden">
          <div className="text-lg font-semibold text-white/80 leading-tight">
            Host: <span className="text-white font-bold">{hostName ?? 'TBD'}</span>
          </div>
          <div className="text-lg font-semibold text-white/80 leading-tight">
            Moderator: <span className="text-white font-bold">{moderatorName ?? 'TBD'}</span>
          </div>
        </div>
      </div>
    )
  }, [isMobile])

  // Body unchanged. Depends on shift.blockSizeMinutes specifically, NOT the
  // whole `shift` object — that prop arrives as a fresh literal from the page
  // on every render, so depending on it would defeat the memo entirely.
  const renderSlotLabel = useCallback(function renderSlotLabel(arg: SlotLabelContentArg) {
    const start = arg.date
    const end = new Date(start.getTime() + shift.blockSizeMinutes * 60_000)
    // Format slot times in PT — FullCalendar's timeZone prop renders the grid
    // in PT, but arg.date is a real UTC instant; format it explicitly in PT.
    const ptStart = utcToPt(start)
    const ptEnd   = utcToPt(end)
    // On mobile, the desktop label "9 AM – 10 AM" eats ~20% of the screen
    // width and crushes the 7 day columns. Collapse to start-only short
    // form ("9a", "12p", "1:30p"); the slot row height already implies
    // the duration and bookings render their own times in-cell.
    if (isMobile) {
      const h = ptStart.getHours()
      const m = ptStart.getMinutes()
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      const ampm = h < 12 ? 'a' : 'p'
      const compact = m === 0 ? `${hour12}${ampm}` : `${hour12}:${String(m).padStart(2, '0')}${ampm}`
      return (
        <span className="text-[0.65rem] font-medium text-foreground pr-1 whitespace-nowrap">
          {compact}
        </span>
      )
    }
    const fmt = (pt: Date) => pt.getMinutes() === 0 ? format(pt, 'h a') : format(pt, 'h:mm a')
    return (
      <span className="text-[0.7rem] font-medium text-foreground pr-1 whitespace-nowrap">
        {fmt(ptStart)} – {fmt(ptEnd)}
      </span>
    )
  }, [isMobile, shift.blockSizeMinutes])

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedCells(new Set())
  }

  // Hand the contiguous range to StreamEventModal and seed selectedSlot so
  // the dialog renders with the spanning time window. The modal's range-book
  // path inserts one row per cell when the admin clicks Save; on close we
  // tear down the range state and exit select mode.
  function openRangeBookingModal() {
    if (!rangeBooking) return
    setSelectedSlot({
      start: rangeBooking.spanStart,
      end: rangeBooking.spanEnd,
      existingStream: null,
      mergedSiblings: [],
    })
    setRangeBookingCells(rangeBooking.cells)
    setModalOpen(true)
  }

  // --- Stable identities for the remaining FullCalendar callbacks ---
  // See the note at the top of this file. These two close over component state
  // so they cannot be hoisted to module scope; useCallback is the equivalent.

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    // Blocking overlay only when the visible dates are NOT loaded (an unloaded
    // week would otherwise look empty and bookable). Near the edge, refresh a
    // padded window in the background. See calendarWindow.ts.
    const plan = planCalendarWindow(arg.view.activeStart, arg.view.activeEnd, loadedFrom, loadedTo)
    if (plan) {
      const url = `/calendar/${brandId}?from=${encodeURIComponent(plan.from)}&to=${encodeURIComponent(plan.to)}&date=${encodeURIComponent(arg.view.currentStart.toISOString())}`
      if (plan.kind === 'blocking') {
        setRangeLoading(true)
        router.replace(url, { scroll: false })
      } else {
        startTransition(() => router.replace(url, { scroll: false }))
      }
    }
    setCurrentView(arg.view.type)
    setActiveRange({ start: arg.view.activeStart, end: arg.view.activeEnd })
    // Mirror to nav context so CalendarHeader's mobile view-switcher
    // highlights the right button.
    setNavCurrentView?.(arg.view.type)
    // setCurrentView / setActiveRange are useState setters — permanently
    // stable, correctly omitted. setNavCurrentView is the same, but it comes
    // from context and could in principle change if the provider remounted,
    // so it stays in the list.
  }, [setNavCurrentView, loadedFrom, loadedTo, router, brandId])

  const eventClassNamesCb = useCallback((arg: EventContentArg): string[] => {
    const out: string[] = []
    const props = arg.event.extendedProps
    const end = arg.event.end
    const isPast = !!end && end.getTime() <= nowPtAsUtc().getTime()

    if (props.__conflict) out.push('conflict-cell')
    if (props.__prep) {
      // Dedicated past class: past-stream's !important peach would
      // repaint prep tiles orange the moment the session starts.
      out.push('prep-event')
      if (props.__prepBeforeOpen) out.push('prep-before-open')
      if (isPast) out.push('past-prep')
      return out
    }
    if (props.__rateLabel) {
      out.push('rate-cell')
      if (isPast) out.push('past-cell')
      // past-cell's !important transparent background would swallow
      // FC's inline selection color — a dedicated class lets the CSS
      // re-assert the highlight on top of the stripes.
      if (props.isSelected) out.push('selected-cell')
    } else if (isPast && !props.__conflict) {
      out.push('past-stream')
    }
    // Stream tile owned by current user with a pending cancellation
    // request: subtle dashed outline so the host knows it's in flight.
    if (!props.__rateLabel && !props.__conflict && arg.event.id && pendingCancelSet.has(arg.event.id)) {
      out.push('pending-cancel')
    }
    return out
  }, [pendingCancelSet])

  return (
    <div
      className="h-full p-4 flex flex-col"
      style={selectMode && toolbarHeight > 0 ? { paddingBottom: toolbarHeight + 24 } : undefined}
    >
      {/* Top toolbar */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="text-xs text-muted-foreground">
          {selectMode ? 'Click any shift cell to select. Book a contiguous run as one shift.' : null}
        </div>
        {isAdmin && !selectMode && (
          <div className="flex items-center gap-2">
            {/* Week-shaped views only — "copy week" needs an unambiguous week. */}
            {activeRange && (currentView === 'timeGridWeek' || currentView === 'listWeek') && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCopyWeekOpen(true)}>
                <Copy className="w-3.5 h-3.5" />
                Copy Week
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSelectMode(true)}>
              <MousePointerSquareDashed className="w-3.5 h-3.5" />
              Group Selection
            </Button>
          </div>
        )}
      </div>

      {isAdmin && activeRange && (
        <CopyWeekDialog
          open={copyWeekOpen}
          onOpenChange={setCopyWeekOpen}
          brandId={brandId}
          sourceWeekStart={activeRange.start}
        />
      )}

      <div className="flex-1 min-h-0 relative">
        {rangeLoading && <div role="status" className="absolute inset-0 z-50 bg-background/90 flex items-center justify-center">Loading schedule…</div>}
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
          initialView="timeGridWeek"
          initialDate={initialDate}
          timeZone={APP_TIMEZONE}
          headerToolbar={
            // On mobile, FC's header is replaced by compact controls rendered
            // inside CalendarHeader (the brand banner), reclaiming ~120px of
            // vertical real estate for the grid. Desktop keeps the full
            // built-in toolbar.
            isMobile
              ? false
              : {
                  left: 'prev,next today',
                  center: 'title',
                  right: selectMode
                    ? ''
                    : 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
                }
          }
          height="100%"
          editable={false}
          selectable={false}
          dayMaxEvents={4}
          events={allEvents}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          datesSet={handleDatesSet}
          dayCellClassNames={pastDayClassNames}
          eventContent={renderEventContent}
          eventClassNames={eventClassNamesCb}
          nowIndicator={true}
          now={NOW_PT}
          slotDuration={minutesToTimeString(shift.blockSizeMinutes)}
          slotLabelInterval={minutesToTimeString(shift.blockSizeMinutes)}
          slotLabelContent={renderSlotLabel}
          slotMinTime={minutesToTimeString(shift.dayStartMinutes)}
          slotMaxTime={minutesToTimeString(shift.dayEndMinutes)}
          snapDuration={minutesToTimeString(shift.blockSizeMinutes)}
          allDaySlot={false}
          expandRows={true}
          buttonText={{
            today: 'Today',
            month: 'Month',
            week: 'Week',
            day: 'Day',
            list: 'List',
          }}
        />
      </div>

      {/* Floating select-mode toolbar */}
      {selectMode && (
        <div
          ref={toolbarRef}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 flex-wrap max-w-[95vw]"
        >
          <div className="text-sm">
            <span className="font-semibold text-foreground">{selectedCells.size}</span>
            <span className="text-muted-foreground ml-1">
              shift{selectedCells.size === 1 ? '' : 's'} selected
            </span>
          </div>

          <div className="h-5 w-px bg-border" />

          {/* Book the contiguous selection as one big shift on a single date.
              Disabled until the selection is single-day + contiguous + future
              + every cell is currently unbooked. */}
          <Button
            size="sm"
            variant="outline"
            onClick={openRangeBookingModal}
            disabled={!rangeBooking}
            className="gap-1.5"
            title={
              rangeBooking
                ? `Book ${rangeBooking.cells.length} contiguous shifts as one block`
                : 'Select contiguous future cells on a single day to enable.'
            }
          >
            <UserPlus className="w-3.5 h-3.5" />
            Book as one shift
          </Button>

          <div className="h-5 w-px bg-border" />

          <Button variant="ghost" size="sm" onClick={exitSelectMode} className="gap-1.5">
            <X className="w-3.5 h-3.5" />
            Cancel
          </Button>
        </div>
      )}

      <StreamEventModal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false)
          // Always tear down the range handoff on close so a subsequent
          // single-cell booking can't accidentally pick up stale cells.
          // Exiting select mode happens only on save success — see
          // onRangeBookingSaved below — so a Cancel preserves the admin's
          // selection.
          if (rangeBookingCells.length > 0) {
            setRangeBookingCells([])
          }
        }}
        onSave={handleSave}
        onDelete={handleDelete}
        brandId={brandId}
        slot={selectedSlot}
        existingStream={selectedSlot?.existingStream ?? null}
        mergedSiblings={selectedSlot?.mergedSiblings ?? []}
        bookingCells={rangeBookingCells}
        onRangeBookingSaved={() => exitSelectMode()}
        hosts={initialHosts}
        producers={initialProducers}
        moderators={initialModerators}
        isScheduler={isScheduler}
        canBook={canBook}
        viewerMode={viewerMode}
        currentUserId={currentUserId}
        currentHost={currentHost}
        hasPendingCancel={
          // Treat the merged block as "pending cancel" if ANY sibling has a
          // pending request — the visual unit shouldn't let the host fire a
          // second request while one is already in flight.
          (selectedSlot?.mergedSiblings ?? []).some(s => pendingCancelSet.has(s.id))
        }
      />
    </div>
  )
}
