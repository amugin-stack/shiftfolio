// Pure planning logic for "copy this week's schedule into another week".
// No I/O — the caller fetches the source week, the target window's occupancy,
// and each person's other commitments, then feeds normalized rows in here.
// Kept pure so it is unit-testable (see copyWeek.test.ts) and so the date +
// conflict math lives in exactly one place.
//
// THREE THINGS THIS MUST GET RIGHT, all of which corrupt a schedule silently:
//
// 1. DST. Shifts move by an EXACT number of milliseconds, never by calendar
//    arithmetic. Under the PT-naive scheme (src/lib/utils.ts) a stream's UTC
//    fields ARE its PT wall-clock, and a UTC day is always 86400s — so
//    `+7 * DAY_MS` preserves the wall-clock hour across the March/November
//    transitions. Round-tripping through local Date methods (setDate/setHours)
//    drifts an hour on transition days for anyone in a DST zone.
//
// 2. Occupied slots. `streams_unique_slot UNIQUE (brand_id, start_time)`
//    (migration 007) means a single collision raises 23505 — and because a
//    multi-row insert is ONE statement, that aborts the whole copy. Colliding
//    slots must be filtered out here, before the insert.
//
// 3. Double-booking. `enforce_no_double_booking` (agent2migrations/005) rejects
//    any host/moderator overlap on ANY brand with 23P01, per row, so it cannot
//    be dodged with ON CONFLICT. Those candidates must be dropped here too.
//
// Deliberately NOT copied: id, created_at, host_rate_cents (frozen historical
// pay — copies must price at the host's live rate), gmv_cents, summary,
// verified/verified_at, reminder_sent_at. Copying a frozen rate would fabricate
// pay history; copying gmv/verified would fabricate revenue.

import { overlaps } from './bookingConflicts'

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

/** A stream from the source week, as fetched. */
export interface CopySourceStream {
  id: string
  title: string | null
  host_id: string | null
  producer_id: string | null
  moderator_id: string | null
  notes: string | null
  start_time: string
  end_time: string
}

/** One existing commitment for a person in the target window (any brand). */
export interface BusyInterval {
  startMs: number
  endMs: number
  brandName: string
}

export interface CopyPlanInput {
  sourceStreams: CopySourceStream[]
  /** Target minus source, in ms. Callers pass whole-week multiples. */
  offsetMs: number
  /** start_time (ms) of every stream already on THIS brand in the target window. */
  occupiedStartMs: Iterable<number>
  /** hostId -> that host's other commitments overlapping the target window. */
  hostBusy?: Map<string, BusyInterval[]>
  /** moderatorId -> same, for moderators. */
  moderatorBusy?: Map<string, BusyInterval[]>
  /** nowPtAsUtc().getTime(); used only to COUNT past landings, never to skip. */
  nowMs?: number
}

/** A row ready to insert (caller adds brand_id + created_by). */
export interface PlannedStream {
  sourceId: string
  title: string | null
  host_id: string | null
  producer_id: string | null
  moderator_id: string | null
  notes: string | null
  start_time: string
  end_time: string
}

export type SkipReason = 'occupied' | 'host_conflict' | 'moderator_conflict'

export interface SkippedStream {
  sourceId: string
  start_time: string
  reason: SkipReason
  /** For conflicts: the brand the person is already committed to. */
  conflictBrand?: string
}

export interface CopyPlan {
  toCreate: PlannedStream[]
  skipped: SkippedStream[]
  counts: {
    create: number
    occupied: number
    hostConflict: number
    moderatorConflict: number
    /** Of `toCreate`, how many land in the past. Already-realized => immediately payable. */
    landsInPast: number
  }
}

/** Shift an ISO instant by an exact millisecond offset. DST-proof by construction. */
export function shiftIso(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString()
}

/** Whole-week offset between two week starts, as exact ms. */
export function weekOffsetMs(sourceWeekStartMs: number, targetWeekStartMs: number): number {
  return targetWeekStartMs - sourceWeekStartMs
}

function conflictBrand(
  busy: Map<string, BusyInterval[]> | undefined,
  personId: string | null,
  startMs: number,
  endMs: number,
): string | null {
  if (!personId || !busy) return null
  const intervals = busy.get(personId)
  if (!intervals) return null
  for (const iv of intervals) {
    if (overlaps(startMs, endMs, iv.startMs, iv.endMs)) return iv.brandName
  }
  return null
}

/**
 * Decide which source shifts can be recreated at the target offset.
 *
 * Skip precedence is occupied > host conflict > moderator conflict, so each
 * source shift is reported under exactly one reason — the counts sum to the
 * source length and the preview can never double-count.
 *
 * Zero/negative-length source rows are dropped outright (they can't satisfy the
 * streams `valid_time_range` CHECK).
 */
export function buildCopyPlan(input: CopyPlanInput): CopyPlan {
  const { sourceStreams, offsetMs, hostBusy, moderatorBusy, nowMs } = input
  const occupied = new Set<number>(input.occupiedStartMs)

  const toCreate: PlannedStream[] = []
  const skipped: SkippedStream[] = []
  let landsInPast = 0

  for (const s of sourceStreams) {
    const srcStartMs = new Date(s.start_time).getTime()
    const srcEndMs = new Date(s.end_time).getTime()
    if (!Number.isFinite(srcStartMs) || !Number.isFinite(srcEndMs)) continue
    if (srcEndMs <= srcStartMs) continue

    const startMs = srcStartMs + offsetMs
    const endMs = srcEndMs + offsetMs
    const start_time = new Date(startMs).toISOString()

    if (occupied.has(startMs)) {
      skipped.push({ sourceId: s.id, start_time, reason: 'occupied' })
      continue
    }

    const hostClash = conflictBrand(hostBusy, s.host_id, startMs, endMs)
    if (hostClash) {
      skipped.push({ sourceId: s.id, start_time, reason: 'host_conflict', conflictBrand: hostClash })
      continue
    }

    const modClash = conflictBrand(moderatorBusy, s.moderator_id, startMs, endMs)
    if (modClash) {
      skipped.push({ sourceId: s.id, start_time, reason: 'moderator_conflict', conflictBrand: modClash })
      continue
    }

    if (nowMs !== undefined && endMs <= nowMs) landsInPast++

    toCreate.push({
      sourceId: s.id,
      title: s.title,
      host_id: s.host_id,
      producer_id: s.producer_id,
      moderator_id: s.moderator_id,
      notes: s.notes,
      start_time,
      end_time: new Date(endMs).toISOString(),
    })
    // A planned row occupies its slot for the rest of this plan, so two source
    // rows can never be planned onto the same target slot.
    occupied.add(startMs)
  }

  return {
    toCreate,
    skipped,
    counts: {
      create: toCreate.length,
      occupied: skipped.filter(s => s.reason === 'occupied').length,
      hostConflict: skipped.filter(s => s.reason === 'host_conflict').length,
      moderatorConflict: skipped.filter(s => s.reason === 'moderator_conflict').length,
      landsInPast,
    },
  }
}

/** One-line human summary for the confirm dialog. */
export function describeCopyPlan(plan: CopyPlan): string {
  const { create, occupied, hostConflict, moderatorConflict } = plan.counts
  if (create === 0 && occupied === 0 && hostConflict === 0 && moderatorConflict === 0) {
    return 'That week has no shifts to copy.'
  }
  const parts = [`${create} shift${create === 1 ? '' : 's'} will be created`]
  if (occupied > 0) parts.push(`${occupied} skipped (slot already booked)`)
  if (hostConflict > 0) parts.push(`${hostConflict} skipped (host already booked elsewhere)`)
  if (moderatorConflict > 0) parts.push(`${moderatorConflict} skipped (moderator already booked elsewhere)`)
  return parts.join(', ') + '.'
}
