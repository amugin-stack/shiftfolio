'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, X as XIcon, CalendarRange, UserCircle2, AlarmClock } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import type { HostPublic, Moderator, Producer, StreamWithRelations } from '@/lib/supabase/types'
import { HostProfileDialog } from '@/components/profile/HostProfileDialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatPT, utcToPt, ptWallClockToUtc, nowPtAsUtc, isPastPtDay } from '@/lib/utils'
import { buildBusyMaps, type BusyStream, type BusyMaps } from '@/lib/bookingConflicts'

const NONE = '__none__'

/** Supabase row shape for the overlap query that powers double-booking
 *  prevention. The brand join may arrive as an object or a one-element array. */
type OverlapRow = {
  id: string
  host_id: string | null
  moderator_id: string | null
  start_time: string
  end_time: string
  brand: { name: string } | { name: string }[] | null
}

/** Flatten overlap query rows into BusyStream[] for buildBusyMaps. */
function toBusyStreams(rows: OverlapRow[]): BusyStream[] {
  return rows.map(r => ({
    id: r.id,
    hostId: r.host_id,
    moderatorId: r.moderator_id,
    startMs: new Date(r.start_time).getTime(),
    endMs: new Date(r.end_time).getTime(),
    brandName: Array.isArray(r.brand) ? (r.brand[0]?.name ?? '') : (r.brand?.name ?? ''),
  }))
}

const OVERLAP_SELECT = 'id, host_id, moderator_id, start_time, end_time, brand:brands(name)'

interface SlotInfo {
  start: Date
  end: Date
}

interface StreamEventModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (stream: StreamWithRelations) => void
  onDelete?: (streamId: string) => void
  brandId: string
  slot: SlotInfo | null
  existingStream: StreamWithRelations | null
  /** All streams represented by the merged visual block. [] for empty
   *  slots; [existingStream] for a single shift; 2+ entries when the
   *  user clicked a merged block. Save/delete cascade across this list. */
  mergedSiblings?: StreamWithRelations[]
  /** Group-Selection range booking: when set (and existingStream is null),
   *  Save inserts one row per cell so the visual unit becomes a merged
   *  block. Slot still spans the whole range for the header display. */
  bookingCells?: Array<{ start: Date; end: Date }>
  /** Fired ONLY after a successful range-booking insert (not on cancel and
   *  not on plain close). Parent uses this to exit Group Selection so the
   *  selection isn't torn down when the admin just changed their mind. */
  onRangeBookingSaved?: () => void
  hosts: HostPublic[]
  producers: Producer[]
  moderators: Moderator[]
  /** Admin OR producer — can create/edit/clear shifts and assign people.
   *  When false the modal renders the host or moderator viewer paths. */
  isScheduler: boolean
  /** False when the user is a moderator on a brand they don't host —
   *  the dialog renders read-only details, no book/cancel/save controls. */
  canBook: boolean
  /** Used to force-hide the host's pay rate from moderators (they have their
   *  own flat rate and shouldn't see what the host earns). */
  viewerMode?: 'admin' | 'host' | 'producer' | 'moderator'
  currentUserId: string
  currentHost: { id: string; name: string } | null
  /** True if the current user already has a pending cancellation request
   *  for this stream — disables the request-cancel button + shows status. */
  hasPendingCancel?: boolean
}

export function StreamEventModal({
  isOpen,
  onClose,
  onSave,
  onDelete,
  brandId,
  slot,
  existingStream,
  mergedSiblings = [],
  bookingCells = [],
  onRangeBookingSaved,
  hosts,
  producers,
  moderators,
  isScheduler,
  canBook,
  currentUserId,
  currentHost,
  hasPendingCancel = false,
}: StreamEventModalProps) {
  // A "merged block" is two or more touching shifts sharing host + moderator
  // collapsed into a single FullCalendar event. Save/delete must cascade
  // across the whole group or the visual block silently breaks.
  const groupedStreams: StreamWithRelations[] = mergedSiblings.length > 0
    ? mergedSiblings
    : (existingStream ? [existingStream] : [])
  const groupedIds = groupedStreams.map(s => s.id)
  const isMergedBlock = groupedStreams.length > 1
  const router = useRouter()
  const { toast } = useToast()
  const [profileOpen, setProfileOpen] = useState(false)
  const [hostId, setHostId] = useState<string>('')
  const [producerId, setProducerId] = useState<string>('')
  const [moderatorId, setModeratorId] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState<string>('')
  // For empty-slot single-cell bookings, schedulers can choose to book just
  // this one or every same-weekday-and-time in the visible PT month. Default
  // is "just". Group-Selection range bookings bypass this — the range is
  // already explicit.
  const [bookScope, setBookScope] = useState<'one' | 'month'>('one')

  useEffect(() => {
    if (!isOpen) return
    setHostId(existingStream?.host_id ?? '')
    setProducerId(existingStream?.producer_id ?? '')
    setModeratorId(existingStream?.moderator_id ?? '')
    setNotes(existingStream?.notes ?? '')
    setCancelReason('')
    setError(null)
    setBookScope('one')
  }, [isOpen, existingStream])

  // Double-booking prevention: who is already booked over this slot (any brand),
  // so the Host/Moderator dropdowns can grey them out. Window = the single cell,
  // or the whole group-selection range. Excludes the stream being edited (and
  // its merged siblings). Primitive deps keep the effect from re-firing forever.
  const [busyMaps, setBusyMaps] = useState<BusyMaps>(() => ({
    busyHosts: new Map(),
    busyMods: new Map(),
  }))
  const busyWindowStartMs = slot
    ? (bookingCells.length > 0 ? bookingCells[0].start.getTime() : slot.start.getTime())
    : 0
  const busyWindowEndMs = slot
    ? (bookingCells.length > 0 ? bookingCells[bookingCells.length - 1].end.getTime() : slot.end.getTime())
    : 0
  const excludeKey = groupedIds.join(',')

  useEffect(() => {
    if (!isOpen || !isScheduler || busyWindowEndMs <= busyWindowStartMs) {
      setBusyMaps({ busyHosts: new Map(), busyMods: new Map() })
      return
    }
    let cancelled = false
    ;(async () => {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data } = await supabase
        .from('streams')
        .select(OVERLAP_SELECT)
        .lt('start_time', new Date(busyWindowEndMs).toISOString())
        .gt('end_time', new Date(busyWindowStartMs).toISOString())
      if (cancelled) return
      const busyStreams = toBusyStreams((data ?? []) as unknown as OverlapRow[])
      setBusyMaps(buildBusyMaps(
        busyStreams,
        busyWindowStartMs,
        busyWindowEndMs,
        excludeKey ? excludeKey.split(',') : [],
      ))
    })()
    return () => { cancelled = true }
  }, [isOpen, isScheduler, busyWindowStartMs, busyWindowEndMs, excludeKey])

  if (!slot) return null

  const isPast = slot.end.getTime() <= nowPtAsUtc().getTime()

  const hostName = hosts.find(h => h.id === hostId)?.name
  const producerName = producers.find(p => p.id === producerId)?.name

  const STREAM_SELECT = 'id, title, brand_id, host_id, producer_id, moderator_id, start_time, end_time, notes, created_by, created_at, host:hosts(id,name), brand:brands(id,name), producer:producers(id,name), moderator:moderators(id,name)'

  // Group-Selection range booking: bookingCells holds N adjacent cells the
  // admin picked. We insert one row per cell with shared host/moderator so
  // the existing merge logic groups them visually into one big shift.
  const isRangeBooking = !existingStream && bookingCells.length > 1

  async function handleSave() {
    if (!isScheduler || !slot) return

    // Range booking, single-block scope: insert one row per cell.
    if (isRangeBooking && bookScope === 'one') {
      await handleRangeBookingInsert()
      return
    }
    // Range booking, month scope: replicate the N-cell pattern across every
    // matching weekday in the visible PT month.
    if (isRangeBooking && bookScope === 'month') {
      await handleBookRangeMonth()
      return
    }
    // Empty-slot single booking with "Every <weekday> in <month>" picked.
    if (!existingStream && bookScope === 'month') {
      await handleBookMonth()
      return
    }

    setSaving(true)
    setError(null)

    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()

    // Race guard: re-check that the chosen host/moderator isn't already booked
    // over this slot (the dropdown greying is computed on open and can go stale).
    if (hostId || moderatorId) {
      const { data: overlapData } = await supabase
        .from('streams')
        .select(OVERLAP_SELECT)
        .lt('start_time', slot.end.toISOString())
        .gt('end_time', slot.start.toISOString())
      const { busyHosts, busyMods } = buildBusyMaps(
        toBusyStreams((overlapData ?? []) as unknown as OverlapRow[]),
        slot.start.getTime(),
        slot.end.getTime(),
        groupedIds,
      )
      const hostConflictBrand = hostId ? busyHosts.get(hostId) : undefined
      const modConflictBrand = moderatorId ? busyMods.get(moderatorId) : undefined
      if (hostConflictBrand || modConflictBrand) {
        setError(
          hostConflictBrand
            ? `That host is already booked for an overlapping slot (${hostConflictBrand}).`
            : `That moderator is already booked for an overlapping slot (${modConflictBrand}).`,
        )
        setSaving(false)
        return
      }
    }

    const payload = {
      brand_id:     brandId,
      host_id:      hostId || null,
      producer_id:  producerId || null,
      moderator_id: moderatorId || null,
      notes:        notes.trim() || null,
      start_time:   slot.start.toISOString(),
      end_time:     slot.end.toISOString(),
      created_by:   currentUserId,
      title:        null,
    }

    try {
      if (existingStream) {
        // Merged-block-aware update: apply host/producer/moderator/notes to
        // every sibling so the visual block stays consistent. For a single
        // shift, groupedIds is just [existingStream.id].
        const { data, error } = await supabase
          .from('streams')
          .update({
            host_id:      payload.host_id,
            producer_id:  payload.producer_id,
            moderator_id: payload.moderator_id,
            notes:        payload.notes,
          })
          .in('id', groupedIds)
          .select(STREAM_SELECT)
        if (error) throw new Error(error.message)
        const results = (data ?? []) as unknown as StreamWithRelations[]
        for (const r of results) onSave(r)
      } else {
        const { data, error } = await supabase
          .from('streams')
          .insert(payload)
          .select(STREAM_SELECT)
          .single()
        if (error) throw new Error(error.message)
        onSave(data as unknown as StreamWithRelations)
      }

      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  // Group-Selection range booking — one row per selected cell so the existing
  // merge logic stitches them into a visual block. Skips cells that (a)
  // were booked in this brand between selection and save (race condition),
  // or (b) collide with the selected host's other-brand commitments
  // (admins shouldn't be able to double-book a host across brands). Mirrors
  // handleBookMonth's conflict policy.
  async function handleRangeBookingInsert() {
    if (!slot) return
    setSaving(true)
    setError(null)
    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const earliestIso = bookingCells[0].start.toISOString()
      const latestIso = bookingCells[bookingCells.length - 1].end.toISOString()

      // Parallel: brand occupancy + host's overlapping other-brand bookings.
      // Host fetch is skipped if no host is assigned (nothing to conflict).
      const [{ data: existing }, hostConflictsRes, modConflictsRes] = await Promise.all([
        supabase
          .from('streams')
          .select('start_time')
          .eq('brand_id', brandId)
          .gte('start_time', earliestIso)
          .lt('start_time', latestIso),
        hostId
          ? supabase
              .from('streams')
              .select('start_time, end_time')
              .eq('host_id', hostId)
              .neq('brand_id', brandId)
              .lt('start_time', latestIso)
              .gt('end_time', earliestIso)
          : Promise.resolve({ data: [] as Array<{ start_time: string; end_time: string }> }),
        // Moderator conflicts — ANY brand (a mod can't run two overlapping
        // streams anywhere). Mirrors the host skip below.
        moderatorId
          ? supabase
              .from('streams')
              .select('start_time, end_time')
              .eq('moderator_id', moderatorId)
              .lt('start_time', latestIso)
              .gt('end_time', earliestIso)
          : Promise.resolve({ data: [] as Array<{ start_time: string; end_time: string }> }),
      ])

      const occupied = new Set(
        (existing ?? []).map(s => new Date(s.start_time as string).getTime()),
      )
      const hostConflicts = (
        (hostConflictsRes.data ?? []) as unknown as Array<{ start_time: string; end_time: string }>
      ).map(s => ({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
      }))
      const modConflicts = (
        (modConflictsRes.data ?? []) as unknown as Array<{ start_time: string; end_time: string }>
      ).map(s => ({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
      }))

      let skippedOccupied = 0
      let skippedHostConflict = 0
      let skippedModConflict = 0
      const toInsertCells: typeof bookingCells = []
      for (const c of bookingCells) {
        if (occupied.has(c.start.getTime())) {
          skippedOccupied++
          continue
        }
        const cStart = c.start.getTime()
        const cEnd = c.end.getTime()
        if (hostConflicts.some(h => h.startMs < cEnd && h.endMs > cStart)) {
          skippedHostConflict++
          continue
        }
        if (modConflicts.some(m => m.startMs < cEnd && m.endMs > cStart)) {
          skippedModConflict++
          continue
        }
        toInsertCells.push(c)
      }

      if (toInsertCells.length === 0) {
        setError(
          skippedHostConflict > 0 || skippedModConflict > 0
            ? 'Every cell in the selected range conflicts with this host or moderator’s other commitments.'
            : 'Every cell in the selected range was already booked.',
        )
        return
      }

      const rows = toInsertCells.map(c => ({
        brand_id:     brandId,
        host_id:      hostId || null,
        producer_id:  producerId || null,
        moderator_id: moderatorId || null,
        notes:        notes.trim() || null,
        start_time:   c.start.toISOString(),
        end_time:     c.end.toISOString(),
        created_by:   currentUserId,
        title:        null,
      }))

      const { data, error } = await supabase
        .from('streams')
        .insert(rows)
        .select(STREAM_SELECT)
      if (error) throw new Error(error.message)
      const results = (data ?? []) as unknown as StreamWithRelations[]
      for (const r of results) onSave(r)

      const skipped = skippedOccupied + skippedHostConflict + skippedModConflict
      const nowMs = nowPtAsUtc().getTime()
      const pastCount = toInsertCells.filter(c => c.end.getTime() <= nowMs).length
      const pastNote = pastCount > 0 ? ` ${pastCount} past shift${pastCount === 1 ? '' : 's'} (count as completed).` : ''
      toast({
        title: `Booked ${toInsertCells.length} shift${toInsertCells.length === 1 ? '' : 's'}`,
        description: skipped > 0
          ? `Skipped ${skippedOccupied} already booked${skippedHostConflict > 0 ? `, ${skippedHostConflict} host conflict${skippedHostConflict === 1 ? '' : 's'}` : ''}${skippedModConflict > 0 ? `, ${skippedModConflict} mod conflict${skippedModConflict === 1 ? '' : 's'}` : ''}.${pastNote}`
          : `${formatPT(toInsertCells[0].start, 'h:mm a')} – ${formatPT(toInsertCells[toInsertCells.length - 1].end, 'h:mm a')} on ${formatPT(toInsertCells[0].start, 'EEEE, MMMM d')}.${pastNote}`,
      })
      onRangeBookingSaved?.()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  // "Every <weekday> in <month>" — books the same time slot on every
  // matching weekday in the visible PT month. Skips: already-booked slots
  // in this brand, slots that conflict with the selected host's other
  // brand commitments, and past slots. Reports the breakdown via toast.
  async function handleBookMonth() {
    if (!slot) return
    setSaving(true)
    setError(null)

    try {
      const ptSlotStart = utcToPt(slot.start)
      const targetDow = ptSlotStart.getDay()
      const sH = ptSlotStart.getHours()
      const sM = ptSlotStart.getMinutes()
      const durationMs = slot.end.getTime() - slot.start.getTime()
      const nowMs = nowPtAsUtc().getTime()

      // PT-anchored month boundaries
      const ptMonthStart = new Date(ptSlotStart.getFullYear(), ptSlotStart.getMonth(), 1)
      const ptMonthEnd   = new Date(ptSlotStart.getFullYear(), ptSlotStart.getMonth() + 1, 1)

      // Enumerate every matching weekday from today onward in the month.
      // Past days are skipped — "today" counts as current, so a slot earlier
      // today is still booked (and counts as Realized immediately).
      const candidates: Array<{ start: Date; end: Date }> = []
      for (
        let d = new Date(ptMonthStart);
        d < ptMonthEnd;
        d.setDate(d.getDate() + 1)
      ) {
        if (d.getDay() !== targetDow) continue
        const ptStart = new Date(d)
        ptStart.setHours(sH, sM, 0, 0)
        const start = ptWallClockToUtc(ptStart)
        if (isPastPtDay(start)) continue
        const end = new Date(start.getTime() + durationMs)
        candidates.push({ start, end })
      }

      if (candidates.length === 0) {
        setSaving(false)
        setError('No matching weekdays left this month.')
        return
      }

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const earliestMs = candidates[0].start.getTime()
      const latestMs = candidates[candidates.length - 1].end.getTime()

      // Pull occupied slots in this brand + the host's other-brand bookings
      // in parallel to keep this single round-trip.
      const [{ data: brandStreams }, hostConflictsRes, modConflictsRes] = await Promise.all([
        supabase
          .from('streams')
          .select('start_time')
          .eq('brand_id', brandId)
          .gte('start_time', new Date(earliestMs).toISOString())
          .lte('start_time', new Date(latestMs).toISOString()),
        hostId
          ? supabase
              .from('streams')
              .select('start_time, end_time, brand_id, brand:brands(name)')
              .eq('host_id', hostId)
              .neq('brand_id', brandId)
              .gte('start_time', new Date(earliestMs - durationMs).toISOString())
              .lte('start_time', new Date(latestMs).toISOString())
          : Promise.resolve({ data: [] as Array<{ start_time: string; end_time: string; brand_id: string; brand: { name: string } | null }> }),
        // Moderator conflicts — ANY brand.
        moderatorId
          ? supabase
              .from('streams')
              .select('start_time, end_time')
              .eq('moderator_id', moderatorId)
              .gte('start_time', new Date(earliestMs - durationMs).toISOString())
              .lte('start_time', new Date(latestMs).toISOString())
          : Promise.resolve({ data: [] as Array<{ start_time: string; end_time: string }> }),
      ])

      const occupied = new Set((brandStreams ?? []).map(s => new Date(s.start_time as string).getTime()))
      type HostConflict = { startMs: number; endMs: number }
      const hostConflicts: HostConflict[] = (
        (hostConflictsRes.data ?? []) as unknown as Array<{ start_time: string; end_time: string }>
      ).map(s => ({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
      }))
      const modConflicts: HostConflict[] = (
        (modConflictsRes.data ?? []) as unknown as Array<{ start_time: string; end_time: string }>
      ).map(s => ({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
      }))

      let skippedOccupied = 0
      let skippedHostConflict = 0
      let skippedModConflict = 0
      const toInsert: Array<{ start: Date; end: Date }> = []
      for (const c of candidates) {
        if (occupied.has(c.start.getTime())) {
          skippedOccupied++
          continue
        }
        const cStart = c.start.getTime()
        const cEnd = c.end.getTime()
        if (hostConflicts.some(h => h.startMs < cEnd && h.endMs > cStart)) {
          skippedHostConflict++
          continue
        }
        if (modConflicts.some(m => m.startMs < cEnd && m.endMs > cStart)) {
          skippedModConflict++
          continue
        }
        toInsert.push(c)
      }

      if (toInsert.length === 0) {
        setSaving(false)
        setError('Every matching slot this month is already booked or conflicts with this host or moderator.')
        return
      }

      const rows = toInsert.map(c => ({
        brand_id:     brandId,
        host_id:      hostId || null,
        producer_id:  producerId || null,
        moderator_id: moderatorId || null,
        notes:        notes.trim() || null,
        start_time:   c.start.toISOString(),
        end_time:     c.end.toISOString(),
        created_by:   currentUserId,
        title:        null,
      }))

      const { data, error } = await supabase
        .from('streams')
        .insert(rows)
        .select(STREAM_SELECT)
      if (error) throw new Error(error.message)
      const results = (data ?? []) as unknown as StreamWithRelations[]
      for (const r of results) onSave(r)

      const skipped = skippedOccupied + skippedHostConflict + skippedModConflict
      const pastCount = toInsert.filter(c => c.end.getTime() <= nowMs).length
      const pastNote = pastCount > 0 ? ` ${pastCount} past shift${pastCount === 1 ? '' : 's'} (count as completed).` : ''
      toast({
        title: `Booked ${toInsert.length} shift${toInsert.length === 1 ? '' : 's'}`,
        description: skipped > 0
          ? `Every ${formatPT(slot.start, 'EEEE')} at ${formatPT(slot.start, 'h:mm a')} in ${formatPT(slot.start, 'MMMM')}. Skipped ${skippedOccupied} already booked${skippedHostConflict > 0 ? `, ${skippedHostConflict} host conflict${skippedHostConflict === 1 ? '' : 's'}` : ''}${skippedModConflict > 0 ? `, ${skippedModConflict} mod conflict${skippedModConflict === 1 ? '' : 's'}` : ''}.${pastNote}`
          : `Every ${formatPT(slot.start, 'EEEE')} at ${formatPT(slot.start, 'h:mm a')} in ${formatPT(slot.start, 'MMMM')}.${pastNote}`,
      })
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  // Range booking applied across the month: take the N-cell pattern the
  // admin selected (e.g. Mon 10-11, 11-12, 12-1) and replicate it on every
  // matching weekday in the visible PT month. Each candidate cell is checked
  // independently against (a) this brand's existing bookings and (b) the
  // picked host's other-brand commitments — so a single conflicting cell in
  // one week's block doesn't kill the rest. Mirrors handleBookMonth's
  // conflict policy but spans N slots per day instead of 1.
  async function handleBookRangeMonth() {
    if (!slot || bookingCells.length === 0) return
    setSaving(true)
    setError(null)

    try {
      // Extract the PT (hour, minute) and duration of each cell so we can
      // replay the exact same intra-day layout on every matching weekday.
      const cellPatterns = bookingCells.map(c => {
        const ptStart = utcToPt(c.start)
        return {
          hour: ptStart.getHours(),
          minute: ptStart.getMinutes(),
          durationMs: c.end.getTime() - c.start.getTime(),
        }
      })

      const firstCellPt = utcToPt(bookingCells[0].start)
      const targetDow = firstCellPt.getDay()
      const nowMs = nowPtAsUtc().getTime()
      const ptMonthStart = new Date(firstCellPt.getFullYear(), firstCellPt.getMonth(), 1)
      const ptMonthEnd   = new Date(firstCellPt.getFullYear(), firstCellPt.getMonth() + 1, 1)

      // Build per-cell candidates across every matching weekday from today
      // onward in the month. Past days are skipped; "today" counts as current.
      const candidates: Array<{ start: Date; end: Date }> = []
      for (
        let d = new Date(ptMonthStart);
        d < ptMonthEnd;
        d.setDate(d.getDate() + 1)
      ) {
        if (d.getDay() !== targetDow) continue
        for (const p of cellPatterns) {
          const ptStart = new Date(d)
          ptStart.setHours(p.hour, p.minute, 0, 0)
          const start = ptWallClockToUtc(ptStart)
          if (isPastPtDay(start)) continue
          const end = new Date(start.getTime() + p.durationMs)
          candidates.push({ start, end })
        }
      }

      if (candidates.length === 0) {
        setSaving(false)
        setError('No matching weekdays left this month.')
        return
      }

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const earliestMs = candidates[0].start.getTime()
      const latestMs = candidates[candidates.length - 1].end.getTime()

      const [{ data: brandStreams }, hostConflictsRes, modConflictsRes] = await Promise.all([
        supabase
          .from('streams')
          .select('start_time')
          .eq('brand_id', brandId)
          .gte('start_time', new Date(earliestMs).toISOString())
          .lte('start_time', new Date(latestMs).toISOString()),
        hostId
          ? supabase
              .from('streams')
              .select('start_time, end_time')
              .eq('host_id', hostId)
              .neq('brand_id', brandId)
              .lt('start_time', new Date(latestMs).toISOString())
              .gt('end_time', new Date(earliestMs).toISOString())
          : Promise.resolve({ data: [] as Array<{ start_time: string; end_time: string }> }),
        // Moderator conflicts — ANY brand.
        moderatorId
          ? supabase
              .from('streams')
              .select('start_time, end_time')
              .eq('moderator_id', moderatorId)
              .lt('start_time', new Date(latestMs).toISOString())
              .gt('end_time', new Date(earliestMs).toISOString())
          : Promise.resolve({ data: [] as Array<{ start_time: string; end_time: string }> }),
      ])

      const occupied = new Set(
        (brandStreams ?? []).map(s => new Date(s.start_time as string).getTime()),
      )
      const hostConflicts = (
        (hostConflictsRes.data ?? []) as unknown as Array<{ start_time: string; end_time: string }>
      ).map(s => ({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
      }))
      const modConflicts = (
        (modConflictsRes.data ?? []) as unknown as Array<{ start_time: string; end_time: string }>
      ).map(s => ({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
      }))

      let skippedOccupied = 0
      let skippedHostConflict = 0
      let skippedModConflict = 0
      const toInsert: Array<{ start: Date; end: Date }> = []
      for (const c of candidates) {
        if (occupied.has(c.start.getTime())) {
          skippedOccupied++
          continue
        }
        const cStart = c.start.getTime()
        const cEnd = c.end.getTime()
        if (hostConflicts.some(h => h.startMs < cEnd && h.endMs > cStart)) {
          skippedHostConflict++
          continue
        }
        if (modConflicts.some(m => m.startMs < cEnd && m.endMs > cStart)) {
          skippedModConflict++
          continue
        }
        toInsert.push(c)
      }

      if (toInsert.length === 0) {
        setSaving(false)
        setError('Every matching slot this month is already booked or conflicts with this host or moderator.')
        return
      }

      const rows = toInsert.map(c => ({
        brand_id:     brandId,
        host_id:      hostId || null,
        producer_id:  producerId || null,
        moderator_id: moderatorId || null,
        notes:        notes.trim() || null,
        start_time:   c.start.toISOString(),
        end_time:     c.end.toISOString(),
        created_by:   currentUserId,
        title:        null,
      }))

      const { data, error } = await supabase
        .from('streams')
        .insert(rows)
        .select(STREAM_SELECT)
      if (error) throw new Error(error.message)
      const results = (data ?? []) as unknown as StreamWithRelations[]
      for (const r of results) onSave(r)

      const skipped = skippedOccupied + skippedHostConflict
      const rangeLabel = `${formatPT(bookingCells[0].start, 'h:mm a')} – ${formatPT(bookingCells[bookingCells.length - 1].end, 'h:mm a')}`
      const pastCount = toInsert.filter(c => c.end.getTime() <= nowMs).length
      const pastNote = pastCount > 0 ? ` ${pastCount} past shift${pastCount === 1 ? '' : 's'} (count as completed).` : ''
      toast({
        title: `Booked ${toInsert.length} shift${toInsert.length === 1 ? '' : 's'}`,
        description: skipped > 0
          ? `Every ${formatPT(slot.start, 'EEEE')} ${rangeLabel} in ${formatPT(slot.start, 'MMMM')}. Skipped ${skippedOccupied} already booked${skippedHostConflict > 0 ? `, ${skippedHostConflict} host conflict${skippedHostConflict === 1 ? '' : 's'}` : ''}${skippedModConflict > 0 ? `, ${skippedModConflict} mod conflict${skippedModConflict === 1 ? '' : 's'}` : ''}.${pastNote}`
          : `Every ${formatPT(slot.start, 'EEEE')} ${rangeLabel} in ${formatPT(slot.start, 'MMMM')}.${pastNote}`,
      })
      onRangeBookingSaved?.()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!existingStream || !onDelete) return
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    // Cascade across the merged block so the visual unit clears in one shot.
    // For a single shift this is just .in('id', [existingStream.id]).
    const { error } = await supabase.from('streams').delete().in('id', groupedIds)
    if (error) {
      setError(error.message)
      return
    }
    for (const id of groupedIds) onDelete(id)
    setDeleteOpen(false)
    onClose()
  }

  async function handleDeleteMonth() {
    if (!slot || !onDelete) return
    setSaving(true)
    setError(null)

    // PT-anchored month boundaries + weekday/time-of-day comparisons
    const ptSlotStart = utcToPt(slot.start)
    const targetDow = ptSlotStart.getDay()
    const sH = ptSlotStart.getHours()
    const sM = ptSlotStart.getMinutes()
    const durationMs = slot.end.getTime() - slot.start.getTime()
    const nowMs = nowPtAsUtc().getTime()
    // For merged blocks: sweep every constituent (hour, minute) on the
    // matching weekday. A 10am-12pm merged block on Mondays expands to
    // {(10,0), (11,0)} so every Monday in the month clears both halves,
    // not just the anchor's 10am slot. Falls back to the slot anchor when
    // mergedSiblings wasn't supplied (booking flow / single-shift call).
    const anchorTuples: Array<{ h: number; m: number }> = isMergedBlock
      ? groupedStreams.map(s => {
          const pt = utcToPt(new Date(s.start_time))
          return { h: pt.getHours(), m: pt.getMinutes() }
        })
      : [{ h: sH, m: sM }]

    const ptMonthStart = new Date(ptSlotStart.getFullYear(), ptSlotStart.getMonth(), 1)
    const ptMonthEnd   = new Date(ptSlotStart.getFullYear(), ptSlotStart.getMonth() + 1, 1)
    const monthStartUtc = ptWallClockToUtc(ptMonthStart)
    const monthEndUtc   = ptWallClockToUtc(ptMonthEnd)

    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()

    // Fetch all candidate streams in the PT month
    const { data: candidates, error: fetchErr } = await supabase
      .from('streams')
      .select('id, start_time')
      .eq('brand_id', brandId)
      .gte('start_time', monthStartUtc.toISOString())
      .lt('start_time', monthEndUtc.toISOString())

    if (fetchErr) {
      setSaving(false)
      setError(fetchErr.message)
      return
    }

    // Match PT weekday + any of the merge-group's (hour, minute) tuples.
    // Admins can clear past + future shifts in one go — the RLS gate on
    // past streams has been lifted.
    const idsToDelete: string[] = []
    let pastCount = 0
    for (const s of candidates ?? []) {
      const sd = new Date(s.start_time)
      const ptSd = utcToPt(sd)
      if (ptSd.getDay() !== targetDow) continue
      const matchesTuple = anchorTuples.some(
        t => ptSd.getHours() === t.h && ptSd.getMinutes() === t.m
      )
      if (!matchesTuple) continue
      const sEndMs = sd.getTime() + durationMs
      if (sEndMs <= nowMs) pastCount++
      idsToDelete.push(s.id as string)
    }

    if (idsToDelete.length === 0) {
      setSaving(false)
      setError('No matching shifts found in this month.')
      return
    }

    const { error: delErr } = await supabase.from('streams').delete().in('id', idsToDelete)

    setSaving(false)
    if (delErr) { setError(delErr.message); return }

    for (const id of idsToDelete) onDelete(id)

    toast({
      title: `Cleared ${idsToDelete.length} shift${idsToDelete.length === 1 ? '' : 's'}`,
      description: pastCount > 0
        ? `${pastCount} past + ${idsToDelete.length - pastCount} future.`
        : undefined,
    })

    setDeleteOpen(false)
    onClose()
  }

  // Hosts can no longer cancel directly. They submit a single-shift
  // cancellation request that flows through the admin notification bell.
  // For merged blocks we fire one request per sibling so the visual unit
  // gets fully cancelled if the admin approves them all.
  async function handleRequestCancel() {
    if (!slot || !currentHost || !existingStream) return
    setSaving(true)
    setError(null)
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()

    const reason = cancelReason.trim() || null
    for (const sid of groupedIds) {
      const { error } = await supabase.rpc('request_shift_cancellation', {
        p_stream_id: sid,
        p_reason: reason,
      })
      if (error) {
        setSaving(false)
        setError(error.message)
        return
      }
    }

    setSaving(false)
    toast({
      title: isMergedBlock
        ? `${groupedIds.length} cancellation requests sent`
        : 'Cancellation requested',
      description: 'An admin will review your request.',
    })
    router.refresh()
    onClose()
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Shift Details</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Date + time + rate header card */}
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">
                  {formatPT(slot.start, 'EEEE, MMMM d')}
                </p>
                {isPast && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    Past shift
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatPT(slot.start, 'h:mm a')} – {formatPT(slot.end, 'h:mm a')}
              </p>
            </div>

            {/* Arrival disclaimer — hosts only (not schedulers), future shifts */}
            {!isScheduler && currentHost && !isPast && (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2.5 flex items-start gap-2.5">
                <AlarmClock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div className="text-xs text-foreground">
                  <p className="font-semibold">Arrive 30 minutes early</p>
                  <p className="text-muted-foreground mt-0.5">
                    Be on set by{' '}
                    <span className="text-foreground font-medium">
                      {formatPT(new Date(slot.start.getTime() - 30 * 60_000), 'h:mm a')}
                    </span>{' '}
                    so we&apos;re ready to go live at{' '}
                    <span className="text-foreground font-medium">
                      {formatPT(slot.start, 'h:mm a')}
                    </span>.
                  </p>
                </div>
              </div>
            )}

            {/* Host */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="slot-host">Host</Label>
                {isScheduler && hostId && (
                  <button
                    type="button"
                    onClick={() => setProfileOpen(true)}
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                  >
                    <UserCircle2 className="w-3 h-3" />
                    View profile
                  </button>
                )}
              </div>
              {isScheduler ? (
                <Select
                  value={hostId || NONE}
                  onValueChange={v => setHostId(v === NONE ? '' : v)}
                >
                  <SelectTrigger id="slot-host">
                    <SelectValue placeholder="Not filled yet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not filled yet</SelectItem>
                    {hosts.map(h => {
                      // Greyed out + reason when already booked over this slot,
                      // unless they're the host currently assigned here.
                      const busyBrand = busyMaps.busyHosts.get(h.id)
                      const disabled = !!busyBrand && h.id !== hostId
                      return (
                        <SelectItem key={h.id} value={h.id} disabled={disabled}>
                          {disabled ? `${h.name} — booked (${busyBrand})` : h.name}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <p className={`text-sm ${hostName ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                  {hostName ?? 'Not filled yet'}
                </p>
              )}
            </div>

            {/* Producer */}
            <div className="space-y-1.5">
              <Label htmlFor="slot-producer">Producer</Label>
              {isScheduler ? (
                <Select
                  value={producerId || NONE}
                  onValueChange={v => setProducerId(v === NONE ? '' : v)}
                >
                  <SelectTrigger id="slot-producer">
                    <SelectValue placeholder="Not filled yet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not filled yet</SelectItem>
                    {producers.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className={`text-sm ${producerName ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                  {producerName ?? 'Not filled yet'}
                </p>
              )}
            </div>

            {/* Moderator */}
            <div className="space-y-1.5">
              <Label htmlFor="slot-moderator">Moderator</Label>
              {isScheduler ? (
                <Select
                  value={moderatorId || NONE}
                  onValueChange={v => setModeratorId(v === NONE ? '' : v)}
                >
                  <SelectTrigger id="slot-moderator">
                    <SelectValue placeholder="Not filled yet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not filled yet</SelectItem>
                    {moderators.map(m => {
                      // Greyed out + reason when already booked over this slot,
                      // unless they're the moderator currently assigned here.
                      const busyBrand = busyMaps.busyMods.get(m.id)
                      const disabled = !!busyBrand && m.id !== moderatorId
                      return (
                        <SelectItem key={m.id} value={m.id} disabled={disabled}>
                          {disabled ? `${m.name} — booked (${busyBrand})` : m.name}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              ) : (() => {
                const moderatorName = moderators.find(m => m.id === moderatorId)?.name
                return (
                  <p className={`text-sm ${moderatorName ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                    {moderatorName ?? 'Not filled yet'}
                  </p>
                )
              })()}
            </div>

            {/* Range-booking summary — confirms what's about to be booked
                when the admin entered this modal from Group Selection. */}
            {isRangeBooking && (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2.5 text-xs text-foreground">
                Booking {bookingCells.length} contiguous shifts as one block: {formatPT(bookingCells[0].start, 'h:mm a')} – {formatPT(bookingCells[bookingCells.length - 1].end, 'h:mm a')} on {formatPT(bookingCells[0].start, 'EEEE, MMMM d')}.
              </div>
            )}

            {/* Book scope — empty future bookings (single cell OR range).
                Lets the admin propagate the same host/moderator/notes across
                every same-weekday-and-time slot in the visible PT month in
                one click. Labels adapt to whether this is a range booking
                ("Just this block" vs "Just this shift") so the action is
                unambiguous. Hidden during edits (existingStream non-null). */}
            {isScheduler && !existingStream && (
              <div className="space-y-1.5">
                <Label>Book scope</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setBookScope('one')}
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border text-sm font-medium transition-colors ${
                      bookScope === 'one'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:bg-secondary'
                    }`}
                  >
                    {isRangeBooking ? 'Just this block' : 'Just this shift'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBookScope('month')}
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border text-sm font-medium transition-colors ${
                      bookScope === 'month'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:bg-secondary'
                    }`}
                  >
                    <CalendarRange className="w-3.5 h-3.5" />
                    Every {formatPT(slot.start, 'EEEE')} in {formatPT(slot.start, 'MMMM')}
                  </button>
                </div>
                {bookScope === 'month' && (
                  <p className="text-[11px] text-muted-foreground">
                    {isRangeBooking
                      ? `Books this ${bookingCells.length}-shift block on every ${formatPT(slot.start, 'EEEE')} from today onward in ${formatPT(slot.start, 'MMMM')} — past dates are skipped. Slots already booked or that conflict with this host's other brands are skipped too.`
                      : `Books every ${formatPT(slot.start, 'EEEE')} at ${formatPT(slot.start, 'h:mm a')} from today onward in ${formatPT(slot.start, 'MMMM')} — past dates are skipped. Slots already booked or that conflict with this host's other brands are skipped too.`}
                  </p>
                )}
              </div>
            )}

            {/* Notes — schedulers can edit, hosts can read */}
            {isScheduler ? (
              <div className="space-y-1.5">
                <Label htmlFor="slot-notes">
                  Notes <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="slot-notes"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Any notes for this shift…"
                  rows={2}
                />
              </div>
            ) : notes ? (
              <div className="space-y-1.5">
                <Label>Notes from scheduler</Label>
                <div className="text-sm text-foreground whitespace-pre-wrap rounded-md border border-border bg-secondary/30 px-3 py-2">
                  {notes}
                </div>
              </div>
            ) : null}

            {error && (
              <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            {isScheduler && existingStream && onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto text-destructive hover:text-destructive gap-1.5"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              {isScheduler ? 'Cancel' : 'Close'}
            </Button>

            {/* Scheduler: save changes. Label adapts to the booking mode so
                the admin sees what's about to happen before they click. */}
            {isScheduler && (
              <Button onClick={handleSave} disabled={saving}>
                {saving
                  ? 'Saving…'
                  : isRangeBooking && bookScope === 'month'
                    ? `Book every ${formatPT(slot.start, 'EEEE')}`
                    : isRangeBooking
                      ? `Book ${bookingCells.length} shifts`
                      : !existingStream && bookScope === 'month'
                        ? `Book every ${formatPT(slot.start, 'EEEE')}`
                        : 'Save'}
              </Button>
            )}

            {/* Host: book / cancel — locked entirely once the shift has ended.
                Schedulers don't go down this path because they have Save/Clear. */}
            {!isScheduler && currentHost && isPast && (
              <span className="text-xs text-muted-foreground italic self-center">
                This shift has ended.
              </span>
            )}

            {/* Host viewing their own assigned shift can request a cancellation.
                Hosts no longer book shifts themselves — admins assign them. */}
            {!isScheduler && canBook && currentHost && !isPast && (() => {
              const claimedByMe = existingStream?.host_id === currentHost.id
              if (!claimedByMe) return null
              if (hasPendingCancel) {
                return (
                  <div className="flex flex-col items-end gap-1 w-full">
                    <span className="text-xs text-muted-foreground italic self-end">
                      Cancellation request pending — waiting on admin review.
                    </span>
                  </div>
                )
              }
              return (
                <div className="flex flex-col gap-2 w-full">
                  <Label htmlFor="cancel-reason" className="text-xs text-muted-foreground">
                    Reason <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <Textarea
                    id="cancel-reason"
                    value={cancelReason}
                    onChange={e => setCancelReason(e.target.value)}
                    placeholder="Anything the admin should know?"
                    rows={2}
                    maxLength={500}
                    disabled={saving}
                  />
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      variant="outline"
                      onClick={handleRequestCancel}
                      disabled={saving}
                      className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                      {saving ? 'Sending…' : 'Request cancellation'}
                    </Button>
                    <span className="text-[10px] text-muted-foreground">
                      An admin will review and approve or deny this request.
                    </span>
                  </div>
                </div>
              )
            })()}

            {/* Read-only viewer (moderator on a brand they don't host) */}
            {!isScheduler && !canBook && (
              <span className="text-xs text-muted-foreground italic self-center">
                View only — only admins can change this shift.
              </span>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear shifts</AlertDialogTitle>
            <AlertDialogDescription>
              {isMergedBlock ? (
                <>
                  Pick scope. &ldquo;Just this block&rdquo; clears the {groupedIds.length} touching shifts shown as one tile ({formatPT(slot.start, 'h:mm a')}&ndash;{formatPT(slot.end, 'h:mm a')}). &ldquo;Every {formatPT(slot.start, 'EEEE')} in {formatPT(slot.start, 'MMMM')}&rdquo; clears all matching cells on every {formatPT(slot.start, 'EEEE')} this month. This action cannot be undone.
                </>
              ) : (
                <>
                  Pick scope. &ldquo;Just this shift&rdquo; deletes the one stream you opened — past or future. &ldquo;Every {formatPT(slot.start, 'EEEE')} in {formatPT(slot.start, 'MMMM')}&rdquo; clears every matching weekday at this time across the whole PT calendar month. This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 flex-col-reverse sm:flex-row sm:justify-between">
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="outline"
                onClick={handleDelete}
                disabled={saving}
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isMergedBlock ? 'Just this block' : 'Just this shift'}
              </Button>
              <Button
                onClick={handleDeleteMonth}
                disabled={saving}
                className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                <CalendarRange className="w-3.5 h-3.5" />
                {saving ? 'Clearing…' : `Every ${formatPT(slot.start, 'EEEE')} in ${formatPT(slot.start, 'MMMM')}`}
              </Button>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Scheduler profile viewer for the assigned host */}
      {isScheduler && (
        <HostProfileDialog
          open={profileOpen}
          onOpenChange={setProfileOpen}
          userId={hosts.find(h => h.id === hostId)?.user_id ?? null}
          displayName={hostName ?? 'Host'}
        />
      )}
    </>
  )
}
