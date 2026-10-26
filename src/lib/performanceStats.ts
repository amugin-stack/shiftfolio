// Derived performance metrics over reported session GMV. Pure, no I/O — the
// caller does the Supabase query and feeds normalized entries in here, matching
// every other calculation module (gmv.ts, payout.ts, fill.ts).
//
// ---------------------------------------------------------------------------
// THE SAMPLE-SIZE PROBLEM, WHICH SHAPES THIS WHOLE FILE
// ---------------------------------------------------------------------------
//
// At the time of writing there are 87 streams in the entire database with a GMV
// figure, and they collapse into fewer SESSIONS than that. Spread across hosts,
// moderators, brands, times of day, days of week — and then across host+mod
// PAIRINGS — most groups have one or two data points.
//
// Several of the metrics the support team asked for are meaningless at that n. The variance
// of a single point is undefined. "This moderator lifts that host by 20%" from
// one shift each is noise wearing a suit, and it is exactly the kind of number
// someone would staff against.
//
// So the metrics split in two:
//
//   ALWAYS HONEST — a total, a rate, a projection. Computable at any n, and
//   wrong only in the ordinary way that small numbers are wrong.
//
//   NEEDS A SAMPLE — variance, comparisons between groups, peer indices,
//   outliers, ramp-up, fatigue. These return NULL below MIN_SESSIONS_FOR_STATS
//   rather than a number.
//
// Returning null (never 0, never NaN) is the house convention, taken from
// computeFillRate in src/lib/fill.ts: "no basis" is null and the UI renders it
// as "—" or "Not enough data". A zero here would read as "this person scored
// zero", which is a different and defamatory claim.
//
// The gated metrics light up on their own as data accumulates. Nothing needs
// rebuilding later.
//
// ---------------------------------------------------------------------------
// TIME SCHEME
// ---------------------------------------------------------------------------
//
// PT-naive, like everything else: the UTC fields of a stored timestamp ARE the
// PT wall-clock (src/lib/utils.ts). So the hour and date are read by SLICING
// the ISO string, never by `new Date(iso).getHours()` — the latter re-reads the
// instant in the runtime's local timezone and would misfile every evening shift
// for anyone west of UTC, and shift the day-of-week for anyone east of it.
//
// Slicing is also DST-immune by construction: the stored value is already the
// wall-clock the worker experienced, so a 9am shift is 9am in March and in
// November alike. Covered by tests.

import { gmvPerHourCents } from '@/lib/gmv'

/**
 * Sessions a group needs before the sample-dependent metrics will report.
 *
 * Five is a judgement call, not a derivation: below it a single unusual shift
 * moves a variance or a comparison more than the underlying reality does.
 * the support team's checklist asks for the threshold without naming a value; this is the
 * one place to change it, and every gated metric reads it.
 */
export const MIN_SESSIONS_FOR_STATS = 5

/** One reported session. Only sessions that HAVE a GMV figure belong here —
 *  unreported ones must not dilute a rate (the rule aggregateGmv already
 *  follows in src/lib/gmv.ts). */
export interface PerfEntry {
  /** Session anchor id, so an outlier can be pointed at. */
  id: string
  gmvCents: number
  hours: number
  /** PT-naive ISO start (a stream's `start_time` straight from the DB). */
  startISO: string
}

export type TimeBlock = 'morning' | 'afternoon' | 'evening'

/**
 * Time-block boundaries, in PT wall-clock hours. Half-open, so every hour lands
 * in exactly one block: morning [0, 14), afternoon [14, 20), evening [20, 24).
 *
 * Confirmed by the support team 2026-09-03: "Morning <2, afternoon 2-8, evening 8+".
 * Later than the conventional splits because the shift day is — an 11am start
 * is a morning shift here, not a late one. Every bucketed metric (the
 * peer-relative index, the day/time filters) reads these, so changing them
 * re-buckets all of it at once.
 */
export const TIME_BLOCK_START_HOUR = { afternoon: 14, evening: 20 } as const

/** PT wall-clock hour (0-23) of a PT-naive ISO timestamp. */
export function ptHour(startISO: string): number {
  return Number(startISO.slice(11, 13))
}

export function timeBlock(startISO: string): TimeBlock {
  const h = ptHour(startISO)
  if (h < TIME_BLOCK_START_HOUR.afternoon) return 'morning'
  if (h < TIME_BLOCK_START_HOUR.evening) return 'afternoon'
  return 'evening'
}

/** PT day of week, 0 = Sunday. Built from the DATE PART only, so the runtime's
 *  timezone cannot shift it across midnight. */
export function ptDayOfWeek(startISO: string): number {
  const [y, m, d] = startISO.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// ---------------------------------------------------------------------------
// Always honest
// ---------------------------------------------------------------------------

export interface PerfSummary {
  sessions: number
  totalGmvCents: number
  totalHours: number
  /** null when there are no reported hours — never 0. */
  gmvPerHourCents: number | null
}

/** Totals for a group. GMV per hour is the headline everywhere: the checklist
 *  asks to standardise on it so a long shift does not look better than a short
 *  one merely for being long. */
export function summarize(entries: PerfEntry[]): PerfSummary {
  let totalGmvCents = 0
  let totalHours = 0
  for (const e of entries) {
    totalGmvCents += e.gmvCents
    totalHours += e.hours
  }
  return {
    sessions: entries.length,
    totalGmvCents,
    totalHours,
    gmvPerHourCents: gmvPerHourCents(totalGmvCents, totalHours),
  }
}

/** Whether a group has enough sessions for the sample-dependent metrics. */
export function hasEnoughData(entries: PerfEntry[]): boolean {
  return entries.length >= MIN_SESSIONS_FOR_STATS
}

export interface TrendPoint {
  /** PT date (YYYY-MM-DD) of the bucket's Monday. */
  weekStartKey: string
  sessions: number
  gmvPerHourCents: number | null
}

/**
 * GMV per hour bucketed by PT week, most recent last.
 *
 * A plain per-week rate, NOT a smoothed moving average. Smoothing across four
 * buckets that each hold one shift would invent a trend line out of three data
 * points; the honest thing is to show the weeks and let the reader see how
 * sparse they are. Each point carries its own `sessions` count for that reason.
 */
export function weeklyTrend(entries: PerfEntry[], weeks = 4, nowPt?: Date): TrendPoint[] {
  if (weeks <= 0) return []
  const anchor = nowPt ?? new Date()
  // Monday of the current PT week, from date parts only.
  const y = anchor.getUTCFullYear()
  const m = anchor.getUTCMonth()
  const d = anchor.getUTCDate()
  const todayMs = Date.UTC(y, m, d)
  const dow = new Date(todayMs).getUTCDay() // 0=Sun
  const mondayOffset = dow === 0 ? 6 : dow - 1
  const thisMondayMs = todayMs - mondayOffset * 86_400_000

  const buckets: TrendPoint[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    const startMs = thisMondayMs - i * 7 * 86_400_000
    const endMs = startMs + 7 * 86_400_000
    const inWeek = entries.filter(e => {
      const t = ymdToMs(e.startISO.slice(0, 10))
      return t >= startMs && t < endMs
    })
    const s = summarize(inWeek)
    buckets.push({
      weekStartKey: msToYmd(startMs),
      sessions: inWeek.length,
      gmvPerHourCents: s.gmvPerHourCents,
    })
  }
  return buckets
}

export interface PaceToGoal {
  /** GMV/hr achieved so far this month. */
  currentPerHourCents: number | null
  /** Same figure — a RATE does not need projecting; see the note below. */
  projectedPerHourCents: number | null
  goalPerHourCents: number | null
  /** projected − goal. Positive is ahead. Null when either side is missing. */
  varianceCents: number | null
  onTrack: boolean | null
}

/**
 * Progress against the host's monthly GMV-per-hour goal.
 *
 * A NOTE ON WHAT IS BEING PROJECTED, because the checklist is ambiguous here.
 * It asks for a goal expressed "per hour" but describes pace-to-goal as
 * "cumulative GMV vs days elapsed, projected to month-end at current run rate".
 * Those are different quantities. Projecting a cumulative TOTAL requires
 * assuming how many more hours someone will work, which the app cannot know —
 * it would turn a scheduling guess into a performance number.
 *
 * A RATE needs no such assumption: today's GMV/hr IS the current run rate, and
 * the honest projection of it is itself. So this compares achieved GMV/hr to
 * the goal GMV/hr and reports the gap. `projectedPerHourCents` is returned
 * alongside `currentPerHourCents` (equal by construction) so the shape survives
 * if the support team later wants a genuine total-based projection.
 */
export function paceToGoal(
  entries: PerfEntry[],
  goalPerHourCents: number | null,
): PaceToGoal {
  const { gmvPerHourCents: current } = summarize(entries)
  const variance =
    current == null || goalPerHourCents == null ? null : current - goalPerHourCents
  return {
    currentPerHourCents: current,
    projectedPerHourCents: current,
    goalPerHourCents,
    varianceCents: variance,
    onTrack: variance == null ? null : variance >= 0,
  }
}

// ---------------------------------------------------------------------------
// Sample-dependent — every one returns null below MIN_SESSIONS_FOR_STATS
// ---------------------------------------------------------------------------

/** Per-session GMV/hr values, skipping sessions with no hours. */
function perHourValues(entries: PerfEntry[]): number[] {
  const out: number[] = []
  for (const e of entries) {
    const v = gmvPerHourCents(e.gmvCents, e.hours)
    if (v != null) out.push(v)
  }
  return out
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Population standard deviation. Population, not sample: these are all the
 *  shifts someone actually worked, not a draw from a larger pool. */
function stdDev(xs: number[]): number {
  const mu = mean(xs)
  return Math.sqrt(mean(xs.map(x => (x - mu) ** 2)))
}

export interface ConsistencyScore {
  /** Standard deviation of per-session GMV/hr, in cents. Lower is steadier. */
  stdDevCents: number
  /** Spread as a share of the mean (coefficient of variation), 0-1+. This is
   *  the comparable number: a $10/hr swing means something different to someone
   *  averaging $50/hr than to someone averaging $500/hr. */
  relativeSpread: number
  bestCents: number
  worstCents: number
}

export function consistencyScore(entries: PerfEntry[]): ConsistencyScore | null {
  if (!hasEnoughData(entries)) return null
  const xs = perHourValues(entries)
  if (xs.length < MIN_SESSIONS_FOR_STATS) return null
  const mu = mean(xs)
  if (mu <= 0) return null
  return {
    stdDevCents: Math.round(stdDev(xs)),
    relativeSpread: stdDev(xs) / mu,
    bestCents: Math.max(...xs),
    worstCents: Math.min(...xs),
  }
}

/**
 * How a group performs relative to everyone else in the same time-slot and
 * day-of-week buckets — so someone who only ever works quiet Tuesday mornings
 * is not marked down for it.
 *
 * Returns a ratio: 1.0 is exactly the peer average, 1.2 is 20% above. Null
 * unless BOTH the group and its peer buckets clear the threshold; comparing to
 * a peer average built from two shifts is no better than the original problem.
 */
export function peerRelativeIndex(
  entries: PerfEntry[],
  allEntries: PerfEntry[],
): number | null {
  if (!hasEnoughData(entries)) return null

  const bucketKey = (e: PerfEntry) => `${ptDayOfWeek(e.startISO)}|${timeBlock(e.startISO)}`
  const peersByBucket = new Map<string, PerfEntry[]>()
  for (const e of allEntries) {
    const k = bucketKey(e)
    const b = peersByBucket.get(k)
    if (b) b.push(e)
    else peersByBucket.set(k, [e])
  }

  let weightedRatio = 0
  let weightUsed = 0
  for (const e of entries) {
    const peers = peersByBucket.get(bucketKey(e)) ?? []
    // Exclude the entry itself so a group is never compared against its own
    // contribution — with thin data that alone would drag every ratio toward 1.
    const others = peers.filter(p => p.id !== e.id)
    if (others.length < MIN_SESSIONS_FOR_STATS) continue
    const peerRate = summarize(others).gmvPerHourCents
    const ownRate = gmvPerHourCents(e.gmvCents, e.hours)
    if (peerRate == null || peerRate <= 0 || ownRate == null) continue
    weightedRatio += (ownRate / peerRate) * e.hours
    weightUsed += e.hours
  }
  return weightUsed > 0 ? weightedRatio / weightUsed : null
}

export interface Outlier {
  id: string
  perHourCents: number
  /** How many standard deviations from this group's own mean. */
  zScore: number
}

/** Sessions more than `threshold` standard deviations from the group's own
 *  mean. "Far outside someone's NORMAL range" — so the comparison is to
 *  themselves, not to the roster. */
export function outliers(entries: PerfEntry[], threshold = 2): Outlier[] | null {
  if (!hasEnoughData(entries)) return null
  const xs = perHourValues(entries)
  if (xs.length < MIN_SESSIONS_FOR_STATS) return null
  const mu = mean(xs)
  const sd = stdDev(xs)
  if (sd === 0) return [] // perfectly consistent: nothing is an outlier
  const out: Outlier[] = []
  for (const e of entries) {
    const v = gmvPerHourCents(e.gmvCents, e.hours)
    if (v == null) continue
    const z = (v - mu) / sd
    if (Math.abs(z) > threshold) out.push({ id: e.id, perHourCents: v, zScore: z })
  }
  return out
}

export interface RampUp {
  earlyPerHourCents: number | null
  steadyPerHourCents: number | null
  /** steady − early. Positive means they improved past the first few shifts. */
  deltaCents: number | null
}

/**
 * A new pairing's first `firstN` sessions against everything after, to show
 * whether people settle in. Null until there is a steady state to compare
 * against — `firstN` early sessions AND a full threshold of later ones,
 * otherwise "improvement" is just the second shift being better than the first.
 */
export function rampUp(entries: PerfEntry[], firstN = 3): RampUp | null {
  const sorted = [...entries].sort((a, b) => a.startISO.localeCompare(b.startISO))
  const early = sorted.slice(0, firstN)
  const steady = sorted.slice(firstN)
  if (early.length < firstN || steady.length < MIN_SESSIONS_FOR_STATS) return null
  const e = summarize(early).gmvPerHourCents
  const s = summarize(steady).gmvPerHourCents
  return {
    earlyPerHourCents: e,
    steadyPerHourCents: s,
    deltaCents: e == null || s == null ? null : s - e,
  }
}

export interface FatigueCheck {
  /** GMV/hr on the first session of a PT day. */
  firstPerHourCents: number | null
  /** GMV/hr on every later session of the same PT day. */
  laterPerHourCents: number | null
  /** later − first. Negative means performance drops later in the day. */
  deltaCents: number | null
  /** Days that contributed (had 2+ sessions). */
  daysCompared: number
}

/**
 * Whether performance falls across consecutive sessions in the same PT day.
 *
 * Compares the first session of each day to the rest of that day, pooled. Null
 * unless enough days have a second session — a single long day proves nothing,
 * and the pooled shape avoids inventing a per-day trend line from two points.
 */
export function fatigueCheck(entries: PerfEntry[]): FatigueCheck | null {
  const byDay = new Map<string, PerfEntry[]>()
  for (const e of entries) {
    const k = e.startISO.slice(0, 10)
    const b = byDay.get(k)
    if (b) b.push(e)
    else byDay.set(k, [e])
  }
  const firsts: PerfEntry[] = []
  const laters: PerfEntry[] = []
  let daysCompared = 0
  for (const day of Array.from(byDay.values())) {
    if (day.length < 2) continue
    const sorted = [...day].sort((a, b) => a.startISO.localeCompare(b.startISO))
    firsts.push(sorted[0])
    laters.push(...sorted.slice(1))
    daysCompared += 1
  }
  if (daysCompared < MIN_SESSIONS_FOR_STATS) return null
  const f = summarize(firsts).gmvPerHourCents
  const l = summarize(laters).gmvPerHourCents
  return {
    firstPerHourCents: f,
    laterPerHourCents: l,
    deltaCents: f == null || l == null ? null : l - f,
    daysCompared,
  }
}

export interface CounterpartEffect {
  /** The other person's id (a moderator id when analysing a host, or vice versa). */
  counterpartId: string
  sessions: number
  perHourCents: number | null
  /** This pairing's rate minus the subject's overall rate. Positive means the
   *  subject does better with this counterpart than they do on average. */
  liftCents: number | null
}

/**
 * "Host effect vs mod effect" — how one person's rate varies across the people
 * they work with.
 *
 * Only counterparts clearing the threshold are returned, and the whole thing is
 * null unless the subject clears it too. THIS IS THE METRIC MOST LIKELY TO BE
 * MISREAD: it is a description of what happened, not evidence that the
 * counterpart caused it. Brand, time slot and product mix all move GMV and none
 * of them are held constant here. The UI should present it as "worked with",
 * never as a ranking of who is better.
 */
export function counterpartEffects(
  entriesByCounterpart: Map<string, PerfEntry[]>,
): CounterpartEffect[] | null {
  const all: PerfEntry[] = []
  for (const list of Array.from(entriesByCounterpart.values())) all.push(...list)
  if (!hasEnoughData(all)) return null
  const overall = summarize(all).gmvPerHourCents

  const out: CounterpartEffect[] = []
  for (const [counterpartId, list] of Array.from(entriesByCounterpart.entries())) {
    if (list.length < MIN_SESSIONS_FOR_STATS) continue
    const rate = summarize(list).gmvPerHourCents
    out.push({
      counterpartId,
      sessions: list.length,
      perHourCents: rate,
      liftCents: rate == null || overall == null ? null : rate - overall,
    })
  }
  return out.length > 0 ? out.sort((a, b) => (b.liftCents ?? 0) - (a.liftCents ?? 0)) : null
}

// ---------------------------------------------------------------------------

function ymdToMs(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function msToYmd(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}
