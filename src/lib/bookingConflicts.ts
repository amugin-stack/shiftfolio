// Pure logic for detecting double-bookings when editing a stream. No I/O — the
// caller does the Supabase query for candidate streams and feeds normalized rows
// in here. Kept pure so it is unit-testable (see bookingConflicts.test.ts) and so
// the overlap math stays in one place.
//
// "Conflict" here means: a host or moderator is already booked on ANOTHER stream
// (any brand) whose time range overlaps the window being edited.

export interface BusyStream {
  id: string
  hostId: string | null
  moderatorId: string | null
  startMs: number
  endMs: number
  brandName: string
}

export interface BusyMaps {
  busyHosts: Map<string, string> // hostId -> conflicting brand name
  busyMods: Map<string, string> // moderatorId -> conflicting brand name
}

/** Strict overlap of [aStart,aEnd) and [bStart,bEnd): aStart < bEnd && bStart < aEnd.
 *  Touching (aEnd === bStart) is NOT overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Collapse candidate streams into busy maps: a host/moderator id -> the brand
 * name of a stream they're booked on that overlaps [windowStartMs, windowEndMs).
 * - Skips any stream whose id is in excludeIds (the stream being edited + merged siblings).
 * - Skips streams that do NOT overlap the window (uses `overlaps`).
 * - Skips zero/negative-length streams (endMs <= startMs).
 * - null hostId / moderatorId contribute nothing.
 * - First overlapping stream encountered for a given person wins (do not overwrite).
 * - No brand filtering — a conflict in ANY brand counts.
 */
export function buildBusyMaps(
  streams: BusyStream[],
  windowStartMs: number,
  windowEndMs: number,
  excludeIds: Iterable<string>,
): BusyMaps {
  const exclude = new Set(excludeIds)
  const busyHosts = new Map<string, string>()
  const busyMods = new Map<string, string>()

  for (const s of streams) {
    if (exclude.has(s.id)) continue
    if (s.endMs <= s.startMs) continue
    if (!overlaps(windowStartMs, windowEndMs, s.startMs, s.endMs)) continue
    if (s.hostId !== null && !busyHosts.has(s.hostId)) busyHosts.set(s.hostId, s.brandName)
    if (s.moderatorId !== null && !busyMods.has(s.moderatorId)) busyMods.set(s.moderatorId, s.brandName)
  }

  return { busyHosts, busyMods }
}
