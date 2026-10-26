// Moderator pre-stream prep time (spec: docs/superpowers/specs/2026-07-15-prep-time-design.md).
// Every contiguous moderator SESSION — a maximal run of touching streams
// (prev.end_time === next.start_time) with the same moderator and brand,
// regardless of host changes mid-run — earns one 30-minute paid prep block
// immediately before the session start. Pure + unit-tested so every pay
// surface (My Shifts, payroll, CSV export, dashboards) and the moderator
// calendar apply the identical rule.
//
// This SUPERSEDES the first-of-(brand, PT-day) "setup bonus"
// (src/lib/setupBonus.ts + migration 048) from PREP_CUTOFF_ISO onward:
// streams starting before the cutoff keep the old rule (history never
// moves — 046/047 precedent); sessions starting on/after it pay prep
// instead. `setupBonusApplies` is the gate every old-rule call site uses.
// The 048 RPC stays until all pre-cutoff pay periods are closed out.
//
// PT-naive scheme: stored UTC fields ARE the PT wall-clock, so Date-ms
// arithmetic here applies no offset. Compare instants via getTime(), NOT
// lexically: the DB renders timestamps "...+00:00" while our bounds are
// ".000Z" — same instant, but '+' sorts before '.', so a raw string compare
// misfires exactly at a boundary midnight (dropped/double-paid block).

/** Kill switch: false restores today's behavior exactly — setup bonus
 *  everywhere, no prep pay, no blue calendar blocks. */
export const PREP_TIME_ENABLED = true

/** The ORIGINAL prep length, for sessions starting before
 *  PREP_DURATION_CUTOFF_ISO. Kept so already-paid periods never move. */
export const PREP_DURATION_MINUTES = 30

/** The current prep length. the support team, 2026-09-04: moderators arrive a full hour
 *  before a session, not half of one -- "For every shift a moderator does,
 *  they should get 1 extra hour of pay". Confirmed as per ARRIVAL (a
 *  contiguous session), not per stored calendar row: a moderator who works one
 *  four-hour block came in once, not four times. */
export const PREP_DURATION_MINUTES_V2 = 60

/**
 * Sessions starting on/after this instant pay the 60-minute block; earlier
 * sessions keep 30.
 *
 * WHY A CUTOFF AT ALL. PREP_DURATION_MINUTES is read by every pay surface with
 * no date attached, so simply changing 30 to 60 would silently re-price every
 * prep block ever paid, including closed periods already settled -- July's and
 * August's numbers would change underneath you. This is the same mechanism
 * PREP_CUTOFF_ISO uses to move setup-bonus -> prep without disturbing history
 * (the 046/047 precedent).
 *
 * The date is the start of the pay period in progress when the support team raised it
 * (2026-08-24 - 2026-09-06). That period had NOT been paid yet, so nothing
 * already settled moves, and the run he was about to pay comes out right.
 * Moving this to the next period start is a one-line change.
 */
export const PREP_DURATION_CUTOFF_ISO = '2026-08-24T00:00:00.000Z'

/**
 * How long a session's prep block is, decided by when the SESSION STARTS.
 *
 * Session start, not "now" and not the pay-period bounds: it is a property of
 * when the work was scheduled, exactly like the regime cutoff above. That is
 * what makes a re-export of an old period reproduce the old figure.
 */
export function prepDurationMinutes(sessionStartISO: string): number {
  // Instant compare, never lexical -- the DB renders "...+00:00" while the
  // constant is ".000Z"; same instant, but '+' sorts before '.', so a string
  // compare misfires exactly at a boundary midnight.
  return new Date(sessionStartISO).getTime() >= new Date(PREP_DURATION_CUTOFF_ISO).getTime()
    ? PREP_DURATION_MINUTES_V2
    : PREP_DURATION_MINUTES
}

// Prep rate: the moderator's OWN flat rate (confirmed by the business
// 2026-07-15) — call sites pass moderator.rate_cents to prepBlockCents.
// Note: at 30 minutes this equals setupBonusCents(rate) exactly, so the
// supersede changes only the SCOPE of the pay (every session vs. only the
// first-of-(brand, PT-day)), never the per-block amount.

/** Sessions starting on/after this instant (PT-naive ISO = midnight PT of the
 *  go-live day) pay under the prep rule; streams starting before it keep the
 *  old setup bonus, so already-worked history never moves (046/047 precedent).
 *  Go-live: 2026-07-22. A FUTURE date is intentional — it guarantees no past
 *  pay period is reclassified. */
export const PREP_CUTOFF_ISO = '2026-07-22T00:00:00.000Z'

/** Old-rule gate: the setup bonus still applies to this stream. True for
 *  everything while the feature is disabled; pre-cutoff only once enabled. */
export function setupBonusApplies(startISO: string): boolean {
  // Instant compare (not lexical): mirrors the cutoff gate in buildPrepBlocks
  // so a session starting exactly at the cutoff is classified identically by
  // both — otherwise "...+00:00" (DB) vs ".000Z" (constant) string sort could
  // hand that one instant BOTH the old bonus and a prep block (double pay).
  return !PREP_TIME_ENABLED || new Date(startISO).getTime() < new Date(PREP_CUTOFF_ISO).getTime()
}

/** One prep block's pay at the given $/hr (the moderator's own rate):
 *  rate × duration, payout.ts rounding convention.
 *
 *  `minutes` is REQUIRED and every caller passes `block.durationMinutes`. It
 *  deliberately has no default: a default would silently price a 60-minute
 *  block at 30 minutes if a call site were ever missed, and that is a
 *  wrong-money bug that nothing would surface. */
export function prepBlockCents(rateCents: number, minutes: number): number {
  return Math.round((rateCents * minutes) / 60)
}

/** Calendar-only: where the "before open" prep marker is pinned — the brand's
 *  opening time on the session's own calendar day. Computed purely from UTC
 *  fields (PT-naive scheme: the UTC fields ARE the PT wall-clock), so it is
 *  DST-proof; a local-tz round-trip (setHours + ms arithmetic) would drift
 *  ±1h on PT DST-transition days (Mar/Nov) for viewers observing Pacific. */
export function beforeOpenMarkerStartISO(
  sessionStartISO: string,
  dayStartMinutes: number,
): string {
  const day = new Date(sessionStartISO)
  return new Date(Date.UTC(
    day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
    Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0,
  )).toISOString()
}

/** Normalized stream row (callers flatten their Supabase shapes). */
export interface PrepStreamInput {
  id: string
  brand_id: string
  moderator_id: string | null
  start_time: string // ISO, PT-naive
  end_time: string // ISO, PT-naive
}

export interface PrepBlock {
  /** The session's earliest stream id — where UI badges attach. */
  anchorId: string
  moderatorId: string
  brandId: string
  /** Prep window: [sessionStart − durationMinutes, sessionStart). */
  startISO: string
  endISO: string
  /** How long this block is, fixed by the session's start date. Read this
   *  rather than the constant — the length changed on
   *  PREP_DURATION_CUTOFF_ISO and old sessions must keep their old value. */
  durationMinutes: number
  /** Session bounds — attribution (PT-day, pay window) and the realized
   *  gate both key off the SESSION, not the prep timestamps. */
  sessionStartISO: string
  sessionEndISO: string
}

export interface PrepWindow {
  /** Inclusive session-start lower bound (ISO). */
  fromISO?: string
  /** Exclusive session-start upper bound (ISO). */
  toExclusiveISO?: string
}

interface BuildOpts {
  /** Only sessions starting on/after this ISO yield blocks. */
  cutoffISO?: string
  /** Only sessions starting inside the window yield blocks. Callers whose
   *  queries are window-scoped should pad the query start by ~1 day so a
   *  session straddling the window start is seen as a continuation (its
   *  prep belongs to the prior period) instead of a fresh session. */
  window?: PrepWindow
}

/**
 * Group moderator-assigned streams into sessions and emit one prep block per
 * session, minus suppressed ones. Suppression: the same moderator has ANY
 * other moderator-assigned stream (any brand, outside the session) touching
 * or overlapping the prep window — closed-interval test, so a shift ending
 * exactly at the prep start also suppresses (the moderator is already on
 * set; there is no separate arrival to pay).
 */
export function buildPrepBlocks(
  streams: PrepStreamInput[],
  opts: BuildOpts = {},
): PrepBlock[] {
  // Defensive dedupe by id: a duplicated input row (join glitch, refetch
  // race) would otherwise split into two identical "sessions" that don't
  // suppress each other — silently minting two prep blocks for one shift.
  const seenIds = new Set<string>()
  const moderated = streams.filter(s => {
    if (s.moderator_id === null) return false
    if (seenIds.has(s.id)) return false
    seenIds.add(s.id)
    return true
  })
  if (moderated.length === 0) return []

  // Sort by moderator, then start time, then id (deterministic tie-break).
  const sorted = [...moderated].sort((a, b) => {
    if (a.moderator_id! !== b.moderator_id!) {
      return a.moderator_id! < b.moderator_id! ? -1 : 1
    }
    const byStart = new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    return byStart !== 0 ? byStart : (a.id < b.id ? -1 : 1)
  })

  interface Session {
    moderatorId: string
    brandId: string
    anchorId: string
    startISO: string
    endISO: string
    memberIds: Set<string>
  }

  const sessions: Session[] = []
  let cur: Session | null = null
  for (const s of sorted) {
    const touchesCur =
      cur !== null
      && s.moderator_id === cur.moderatorId
      && s.brand_id === cur.brandId
      && new Date(s.start_time).getTime() === new Date(cur.endISO).getTime()
    if (touchesCur) {
      cur!.endISO = s.end_time
      cur!.memberIds.add(s.id)
    } else {
      if (cur) sessions.push(cur)
      cur = {
        moderatorId: s.moderator_id!,
        brandId: s.brand_id,
        anchorId: s.id,
        startISO: s.start_time,
        endISO: s.end_time,
        memberIds: new Set([s.id]),
      }
    }
  }
  if (cur) sessions.push(cur)

  const blocks: PrepBlock[] = []
  for (const sess of sessions) {
    // Cutoff + window gates key off the SESSION start (attribution rule).
    // Compare as epoch-ms, never lexically: the DB renders timestamps as
    // "...+00:00" while cutoff/window bounds are ".000Z" — the SAME instant
    // sorts differently as a string ('+' < '.'), so a session starting
    // exactly on a boundary midnight would be misgated. Mirrors the
    // getTime() comparison every call site already uses.
    const sessStartMs = new Date(sess.startISO).getTime()
    // The CUTOFF still keys off session START — it decides which pay REGIME a
    // session falls under (old setup bonus vs new prep rule), which is a
    // property of when the work was scheduled.
    if (opts.cutoffISO && sessStartMs < new Date(opts.cutoffISO).getTime()) continue
    // The WINDOW keys off session END, so a prep block lands in the same pay
    // period as the shift rows it belongs to — payroll queries now window on
    // end_time. Keyed off start, a session beginning inside one period and
    // ending in the next fell in a hole: the first period's query excluded it
    // (end past the window) and the second period rejected it here (start
    // before the window), so its prep was never paid at all.
    const sessEndMs = new Date(sess.endISO).getTime()
    if (opts.window?.fromISO && sessEndMs < new Date(opts.window.fromISO).getTime()) continue
    if (opts.window?.toExclusiveISO && sessEndMs >= new Date(opts.window.toExclusiveISO).getTime()) continue

    const durationMinutes = prepDurationMinutes(sess.startISO)
    const prepStartMs = sessStartMs - durationMinutes * 60_000

    // Suppression: another of this moderator's streams touches/overlaps the
    // prep window [prepStartMs, sessStartMs] (closed interval).
    const suppressed = sorted.some(s => {
      if (s.moderator_id !== sess.moderatorId) return false
      if (sess.memberIds.has(s.id)) return false
      const sStart = new Date(s.start_time).getTime()
      const sEnd = new Date(s.end_time).getTime()
      return sStart <= sessStartMs && sEnd >= prepStartMs
    })
    if (suppressed) continue

    blocks.push({
      anchorId: sess.anchorId,
      moderatorId: sess.moderatorId,
      brandId: sess.brandId,
      startISO: new Date(prepStartMs).toISOString(),
      endISO: sess.startISO,
      durationMinutes,
      sessionStartISO: sess.startISO,
      sessionEndISO: sess.endISO,
    })
  }

  // Chronological, then anchor id — deterministic for rendering + tests.
  return blocks.sort((a, b) =>
    a.startISO !== b.startISO
      ? a.startISO.localeCompare(b.startISO)
      : a.anchorId.localeCompare(b.anchorId),
  )
}

/** Production entrypoint: applies the kill switch + the supersede cutoff.
 *  Every pay surface and the calendar go through this. */
export function computePrepBlocks(
  streams: PrepStreamInput[],
  window?: PrepWindow,
): PrepBlock[] {
  if (!PREP_TIME_ENABLED) return []
  return buildPrepBlocks(streams, { cutoffISO: PREP_CUTOFF_ISO, window })
}
