// Pure logic for per-host GMV (gross merchandise value) reporting. No I/O — the
// caller does the Supabase query and feeds normalized stream rows in here. Kept
// pure so it is unit-testable (see gmv.test.ts) and so the "session" grouping
// and rate math stay in one place.
//
// The "session" concept mirrors mergeAdjacentStreams in src/hooks/useStreams.ts:
// touching shifts (prev.end_time === next.start_time, exact ISO-instant equality)
// in the SAME brand collapse into one session. GMV is stored on the anchor (the
// earliest stream) of a session. Times are ISO strings, compared via
// new Date(x).getTime() — the app's PT-naive convention (stored UTC fields ARE
// PT wall-clock) doesn't matter here since we only diff instants.

/** Normalized stream row for one host (caller flattens the Supabase joins). */
export interface GmvStreamInput {
  id: string
  brand_id: string
  start_time: string // ISO
  end_time: string // ISO
  gmv_cents: number | null
}

export interface Session {
  anchorId: string // earliest stream's id — where GMV is stored
  brandId: string
  /** Set by buildSessionsByHost / buildSessionsByPair, so a caller aggregating
   *  several people's sessions can tell whose is whose. Undefined from plain
   *  buildSessions, which is called with one person's rows already. */
  hostId?: string | null
  moderatorId?: string | null
  startISO: string // earliest start
  endISO: string // latest end
  hours: number // summed stream durations, in hours
  gmvCents: number | null // the session's GMV
  streamIds: string[] // all stream ids in the session, in time order
}

/**
 * Group ONE host's streams into sessions. Sort by start_time ascending; a new
 * session begins when the next stream does NOT touch the current run
 * (prev.end !== next.start) OR the brand_id changes. anchorId = earliest
 * stream's id. gmvCents = the anchor stream's gmv_cents if non-null, else the
 * first non-null gmv_cents among the session's streams, else null. hours = sum
 * of (end-start)/3_600_000 across the session's streams. streamIds in time order.
 */
export function buildSessions(streams: GmvStreamInput[]): Session[] {
  if (streams.length === 0) return []

  const sorted = [...streams].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
  )
  // Resolve gmv per stream id when picking a session's GMV.
  const gmvById = new Map<string, number | null>(sorted.map(s => [s.id, s.gmv_cents]))

  interface Acc {
    streamIds: string[]
    startISO: string
    endISO: string
    brandId: string
    totalMs: number
  }

  const sessions: Session[] = []

  const finalize = (acc: Acc): Session => {
    const anchorId = acc.streamIds[0]
    const anchorGmv = gmvById.get(anchorId) ?? null
    let gmvCents: number | null = anchorGmv
    if (gmvCents == null) {
      for (const id of acc.streamIds) {
        const g = gmvById.get(id) ?? null
        if (g != null) {
          gmvCents = g
          break
        }
      }
    }
    return {
      anchorId,
      brandId: acc.brandId,
      startISO: acc.startISO,
      endISO: acc.endISO,
      hours: acc.totalMs / 3_600_000,
      gmvCents,
      streamIds: acc.streamIds,
    }
  }

  const start = (s: GmvStreamInput): Acc => ({
    streamIds: [s.id],
    startISO: s.start_time,
    endISO: s.end_time,
    brandId: s.brand_id,
    totalMs: new Date(s.end_time).getTime() - new Date(s.start_time).getTime(),
  })

  let current: Acc = start(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    const touches = new Date(current.endISO).getTime() === new Date(next.start_time).getTime()
    const sameBrand = next.brand_id === current.brandId
    if (touches && sameBrand) {
      current.streamIds.push(next.id)
      current.endISO = next.end_time
      current.totalMs += new Date(next.end_time).getTime() - new Date(next.start_time).getTime()
    } else {
      sessions.push(finalize(current))
      current = start(next)
    }
  }
  sessions.push(finalize(current))
  return sessions
}

/** A stream row that may belong to any host — carries the host so the caller
 *  does not have to pre-partition by hand. */
export interface HostedGmvStreamInput extends GmvStreamInput {
  host_id: string | null
}

/**
 * Group streams that may span SEVERAL hosts into sessions, partitioning by host
 * first.
 *
 * WHY THIS EXISTS. `buildSessions` groups by brand + time contiguity and knows
 * nothing about who worked a shift — every existing caller pre-filters to one
 * host's rows before calling it, so the omission never mattered. A MODERATOR's
 * rows are not pre-filtered that way: one moderator can cover two different
 * hosts back to back on the same brand. Handing those straight to
 * `buildSessions` would merge them into ONE session spanning both hosts, and
 * the resulting GMV would then be counted once for each host by the org-wide
 * totals on the Performance tab — the same revenue, twice.
 *
 * Partitioning by host first makes that impossible, and it mirrors exactly what
 * the admin Performance page already does with `groupByHost`
 * (src/app/(dashboard)/admin/performance/page.tsx).
 *
 * Rows with no host_id are DROPPED. A session with no host has no host
 * partition, so any GMV recorded against it is invisible to every admin
 * aggregate — the Performance queries filter `host_id IS NOT NULL`. Offering it
 * for entry would produce a figure that silently goes nowhere, so the write RPC
 * rejects those sessions (migration 074) and this drops them to match.
 *
 * Output is sorted by start time so the caller gets one coherent ordering
 * rather than the per-host runs concatenated.
 */
export function buildSessionsByHost(streams: HostedGmvStreamInput[]): Session[] {
  const byHost = new Map<string, GmvStreamInput[]>()
  for (const s of streams) {
    if (!s.host_id) continue
    const bucket = byHost.get(s.host_id)
    if (bucket) bucket.push(s)
    else byHost.set(s.host_id, [s])
  }
  const out: Session[] = []
  // Array.from rather than iterating the Map view directly — the tsconfig
  // target here predates downlevel iteration of Map iterators.
  for (const [hostId, rows] of Array.from(byHost.entries())) {
    for (const sess of buildSessions(rows)) out.push({ ...sess, hostId })
  }
  return out.sort(
    (a, b) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime(),
  )
}

/** A stream row carrying both workers, for pairing analysis. */
export interface PairedGmvStreamInput extends HostedGmvStreamInput {
  moderator_id: string | null
}

/**
 * Group streams into sessions partitioned by the host AND moderator PAIR.
 *
 * This is what the moderator and host+moderator views aggregate from. Grouping
 * by moderator ALONE would merge two different hosts' work into one session
 * whenever a moderator covers them back to back on the same brand — the exact
 * double-count `buildSessionsByHost` exists to prevent, in its other direction.
 *
 * WHAT THIS DOES TO A SESSION WHOSE MODERATOR CHANGES PART-WAY. It splits it.
 * A host working 9-12 with moderator A until 10 and B after becomes two
 * sessions. That is deliberate and it does NOT double-count: GMV lives on the
 * session ANCHOR (its earliest stream), so the piece containing the anchor
 * carries the whole figure and the other piece carries null, which
 * `aggregateGmv` skips. The revenue is counted once, attributed to whoever was
 * on at the start.
 *
 * That attribution is arbitrary when moderators change mid-session, and it is
 * the honest limit of a model that stores one figure per session. It is also
 * why the HOSTS view keeps using buildSessionsByHost: partitioning a host's
 * sessions by moderator would split them and inflate their session count for a
 * reason that has nothing to do with the host.
 *
 * Rows with no host are dropped (they have no host partition, so no GMV).
 * Rows with no moderator are KEPT, grouped under a null moderator — a host's
 * unmoderated work is still their work and still belongs in their totals.
 */
export function buildSessionsByPair(streams: PairedGmvStreamInput[]): Session[] {
  const byPair = new Map<string, { hostId: string; moderatorId: string | null; rows: GmvStreamInput[] }>()
  for (const s of streams) {
    if (!s.host_id) continue
    const key = `${s.host_id}|${s.moderator_id ?? ''}`
    const bucket = byPair.get(key)
    if (bucket) bucket.rows.push(s)
    else byPair.set(key, { hostId: s.host_id, moderatorId: s.moderator_id ?? null, rows: [s] })
  }
  const out: Session[] = []
  for (const { hostId, moderatorId, rows } of Array.from(byPair.values())) {
    for (const sess of buildSessions(rows)) out.push({ ...sess, hostId, moderatorId })
  }
  return out.sort(
    (a, b) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime(),
  )
}

/** Cents per hour, rounded to an integer. Returns null when hours <= 0. */
export function gmvPerHourCents(gmvCents: number, hours: number): number | null {
  return hours <= 0 ? null : Math.round(gmvCents / hours)
}

export interface HostGmvAgg {
  totalGmvCents: number // sum of gmvCents over sessions that HAVE gmv
  reportedHours: number // sum of hours over sessions that HAVE gmv
  gmvPerHourCents: number | null // totalGmvCents / reportedHours, or null if reportedHours <= 0
}

/**
 * Aggregate sessions into host totals, counting ONLY sessions whose gmvCents is
 * non-null (so un-reported sessions don't dilute the rate).
 */
export function aggregateGmv(sessions: Session[]): HostGmvAgg {
  let totalGmvCents = 0
  let reportedHours = 0
  for (const s of sessions) {
    if (s.gmvCents != null) {
      totalGmvCents += s.gmvCents
      reportedHours += s.hours
    }
  }
  return {
    totalGmvCents,
    reportedHours,
    gmvPerHourCents: gmvPerHourCents(totalGmvCents, reportedHours),
  }
}
