import type { StreamWithRelations } from '@/lib/supabase/types'
import type { CalendarEvent } from '@/types'

// Brand-accent orange (matches --primary / #FF4433) used for booked shifts.
const BOOKED_BG     = '#FF4433'
const BOOKED_BORDER = '#E03A2C'
const BOOKED_TEXT   = '#ffffff'

function streamsTouchAndMatch(a: StreamWithRelations, b: StreamWithRelations): boolean {
  return new Date(a.end_time).getTime() === new Date(b.start_time).getTime()
    && a.host_id      === b.host_id
    && a.moderator_id === b.moderator_id
    && a.brand_id     === b.brand_id
}

// Given an anchor stream that's part of `streams`, return every touching
// sibling (forward + backward) that shares host + moderator + brand. Used by
// the calendar's click handler so save/delete cascade across the full visual
// block instead of corrupting it. Always returns at least [anchor].
export function findMergeGroup(
  streams: StreamWithRelations[],
  anchor: StreamWithRelations
): StreamWithRelations[] {
  const sorted = [...streams].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  )
  const anchorIdx = sorted.findIndex(s => s.id === anchor.id)
  if (anchorIdx < 0) return [anchor]
  const group: StreamWithRelations[] = [sorted[anchorIdx]]
  for (let i = anchorIdx - 1; i >= 0; i--) {
    if (streamsTouchAndMatch(sorted[i], group[0])) group.unshift(sorted[i])
    else break
  }
  for (let i = anchorIdx + 1; i < sorted.length; i++) {
    if (streamsTouchAndMatch(group[group.length - 1], sorted[i])) group.push(sorted[i])
    else break
  }
  return group
}

// Collapse touching shifts that share the same host + moderator (and brand)
// into a single visual block. Visual-only: the underlying `streams` array used
// for chain-booking, conflict detection, and rate labels is untouched.
//
// Touching = previous.end_time === next.start_time (exact match; the grid
// snaps both, so equality is reliable). null === null counts as "same" for
// host/moderator so two unassigned touching shifts also collapse.
export function mergeAdjacentStreams(streams: StreamWithRelations[]): StreamWithRelations[] {
  if (streams.length === 0) return []
  const sorted = [...streams].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  )
  const merged: StreamWithRelations[] = []
  let current: StreamWithRelations = { ...sorted[0] }
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    const touches = new Date(current.end_time).getTime() === new Date(next.start_time).getTime()
    const sameHost  = current.host_id      === next.host_id
    const sameMod   = current.moderator_id === next.moderator_id
    const sameBrand = current.brand_id     === next.brand_id
    if (touches && sameHost && sameMod && sameBrand) {
      current = { ...current, end_time: next.end_time }
    } else {
      merged.push(current)
      current = { ...next }
    }
  }
  merged.push(current)
  return merged
}

export function streamsToEvents(streams: StreamWithRelations[]): CalendarEvent[] {
  return streams.map(s => {
    const hostName      = s.host?.name      ?? null
    const moderatorName = s.moderator?.name ?? null
    // Title is a fallback for surfaces that read event.title directly
    // (month view); the rich two-line layout in week / day views reads
    // extendedProps for host + moderator names independently.
    const title = hostName ?? 'Host TBD'
    return {
      id: s.id,
      title,
      start: s.start_time,
      end: s.end_time,
      backgroundColor: BOOKED_BG,
      borderColor:     BOOKED_BORDER,
      textColor:       BOOKED_TEXT,
      extendedProps: {
        hostName,
        brandName:     s.brand.name,
        producerName:  s.producer?.name ?? null,
        moderatorName,
        notes:         s.notes,
        streamId:      s.id,
        hostId:        s.host_id,
        brandId:       s.brand_id,
        producerId:    s.producer_id,
        moderatorId:   s.moderator_id,
      },
    }
  })
}

// NOTE: a `useStreams()` hook used to live here and was deleted 2026-08-25.
// It had NO callers — CalendarView imports only the three pure helpers above —
// but it read like "the" streams hook, so it was an easy trap for a future PR.
// All four of its members were hazards:
//   * refreshStreams() — a full-table stream fetch with no brand filter, no
//     date bound and no paging: exactly the silent 1000-row truncation that
//     blanked the SAMPLE BRAND A calendar (see src/lib/supabase/fetchAll.ts).
//   * createStream()/updateStream() — wrote with no double-booking overlap
//     check, which the real path in StreamEventModal builds busy-maps to enforce.
//   * deleteStream() — deleted a single row with no merge-group cascade,
//     turning a merged block into a partial one.
// If a streams hook is ever needed, build it on fetchAllRows and route writes
// through the same conflict checks StreamEventModal uses.
