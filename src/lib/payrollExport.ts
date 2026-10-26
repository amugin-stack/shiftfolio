// Pure logic for the admin Payroll CSV export. No I/O — the route handler
// (src/app/(dashboard)/admin/payroll/export/route.ts) does the Supabase
// queries and feeds normalized rows in here. Kept pure so it is unit-testable
// (see payrollExport.test.ts) and so the money/time math stays in one place.

import { computeHostShiftPayoutCents } from '@/lib/payout'
import { findSetupBonusStreamIds, setupBonusCents } from '@/lib/setupBonus'
import {
  computePrepBlocks,
  prepBlockCents,
  setupBonusApplies,
  PREP_TIME_ENABLED,
} from '@/lib/prepTime'
import {
  currentPayPeriodStartKey,
  resolvePayPeriod,
  shiftPayPeriodKey,
} from '@/lib/payPeriod'
import {
  extraPayCents,
  extraPayDurationMinutes,
  isExtraPayRealized,
  EXTRA_PAY_ENABLED,
  type ExtraPayKind,
  type ExtraPayStatus,
} from '@/lib/extraPay'

const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Resolved query window. Bounds are PT-wall-clock encoded as UTC ISO. */
export interface DateRange {
  /** inclusive start of range, start-of-day, ISO */
  fromISO: string
  /** exclusive end of range, start-of-day AFTER `to`, ISO */
  toExclusiveISO: string
  /** YYYY-MM-DD label for the start (filename / override bounds) */
  fromKey: string
  /** YYYY-MM-DD label for the end (inclusive) */
  toKey: string
}

function ymdFromUtcMs(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * The company's real biweekly pay period, as an export window.
 *
 * This replaced the old rolling "past 2 weeks" preset. That one meant "the 14
 * days ending yesterday", measured from whatever day the button was clicked, so
 * exporting 16 days after the previous run left two days inside NO window at
 * all — not late, never paid, because the following run also counts 14 days
 * back from ITS click date. An anchored calendar cannot do that: the periods
 * tile the timeline exactly (proved in payPeriod.test.ts), so every day belongs
 * to exactly one period no matter when anybody presses the button.
 *
 * It is also the SAME calendar the worker's own My Shifts page reads, which is
 * the point — the number they see and the number you pay now describe the same
 * fourteen days.
 *
 * 'previous' is the completed period: everything in it has finished, so
 * buildHostRows' "completed shifts only" gate cannot strand anything. This is
 * the one you pay from.
 *
 * 'current' is still in progress and is a PREVIEW. Shifts that have not ended
 * yet are excluded, so the totals will grow. Nothing is lost — re-exporting the
 * same period once it closes returns the full set, which is precisely what the
 * rolling window could not do — but do not pay from it and then pay the closed
 * period too, or the finished part gets paid twice. The route marks the
 * filename so the two files cannot be confused.
 */
export function resolvePayPeriodRange(which: 'current' | 'previous', now: Date): DateRange {
  const currentKey = currentPayPeriodStartKey(now)
  const startKey = which === 'current' ? currentKey : shiftPayPeriodKey(currentKey, -1)
  const p = resolvePayPeriod(startKey)
  return {
    fromISO: p.fromISO,
    toExclusiveISO: p.toExclusiveISO,
    fromKey: p.startKey,
    toKey: p.endKey,
  }
}

/**
 * Rolling preset window ending "today" (PT). `now` MUST be the result of
 * nowPtAsUtc() — a Date whose UTC fields encode the current PT wall-clock.
 * month = the 30 days ending yesterday.
 *
 * Kept as a convenience window for looking at recent activity. It is NOT the
 * pay basis — use resolvePayPeriodRange for that.
 *
 * Closed at the start, open at the end, spanning EXACTLY `days` days, and
 * ending at TODAY'S midnight rather than tomorrow's. Both properties are
 * load-bearing and each fixes a different bug:
 *
 *   - Exactly `days`, not days+1. `d - days` through `d` INCLUSIVE is 15 days
 *     for a 14-day preset, so two runs 14 days apart both contained the seam
 *     day and every completed shift on it was paid TWICE.
 *
 *   - Ending at today's midnight, not tomorrow's. buildHostRows only pays
 *     shifts that have ENDED (`endMs > nowMs` is skipped). If the window
 *     extended through today, anything finishing later today sat inside the
 *     window but was skipped as unfinished -- and the next window starts where
 *     this one ends, so no later run ever contained it either. Silently never
 *     paid. The old days+1 overlap had been masking exactly this; removing the
 *     overlap without also pulling the end back re-created it.
 *
 *     Ending at today's midnight means everything in the window has already
 *     finished, so the realized gate can never strand a shift. Today's work is
 *     picked up by the next run, once.
 */
export function resolvePresetRange(preset: 'month', now: Date): DateRange {
  const days = 30
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const d = now.getUTCDate()
  const fromMs = Date.UTC(y, m, d - days)
  const toMs = Date.UTC(y, m, d - 1)
  const toExclusiveMs = Date.UTC(y, m, d)
  return {
    fromISO: new Date(fromMs).toISOString(),
    toExclusiveISO: new Date(toExclusiveMs).toISOString(),
    fromKey: ymdFromUtcMs(fromMs),
    toKey: ymdFromUtcMs(toMs),
  }
}

/** Custom window from two YYYY-MM-DD PT calendar dates (inclusive). */
export function resolveCustomRange(from: string, to: string): DateRange {
  if (!YMD.test(from) || !YMD.test(to)) {
    throw new RangeError('dates must be YYYY-MM-DD')
  }
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const fromMs = Date.UTC(fy, fm - 1, fd)
  const toMs = Date.UTC(ty, tm - 1, td)
  if (fromMs > toMs) throw new RangeError('from must be on or before to')
  const toExclusiveMs = Date.UTC(ty, tm - 1, td + 1)
  return {
    fromISO: new Date(fromMs).toISOString(),
    toExclusiveISO: new Date(toExclusiveMs).toISOString(),
    fromKey: from,
    toKey: to,
  }
}

/**
 * Which hours a payroll run pays for.
 *
 *   'realized' — only work that has ENDED. What the CSV has always done, and
 *                what CLAUDE.md rule 21 calls Realized.
 *   'expected' — everything booked in the period, finished or not. Rule 21's
 *                Expected, which both admin payroll pages already show.
 *
 * Payroll is run a couple of days BEFORE the period closes, so a realized-only
 * file leaves out every shift still to come and people are paid short and
 * topped up by hand. That is the bug this exists to fix (the support team, 2026-09-04).
 *
 * For a CLOSED period the two are identical -- everything in it has ended -- so
 * the basis only changes anything on a period still running. That equivalence
 * is the cheapest correctness check on this whole feature and there is a test
 * for it.
 *
 * DEFAULTS TO 'realized' EVERYWHERE. That is deliberate and load-bearing: an
 * earlier attempt at this feature changed the default and cascaded into
 * prepTime.consistency.test.ts, whose invariant 5 asserts "nothing has
 * completed yet" against a dozen hand-computed literals. Keeping the default
 * means every existing caller and test keeps its exact meaning.
 */
export type PayBasis = 'realized' | 'expected'

/** True when a thing ending at `endMs` should be paid under this basis. */
function payable(endMs: number, nowMs: number, basis: PayBasis): boolean {
  return basis === 'expected' || endMs <= nowMs
}

export interface PayrollRow {
  name: string
  role: 'Host' | 'Moderator'
  /** Inclusive total (live + old setup bonus + prep). */
  totalHours: number
  /** Inclusive total pay in cents. */
  amountCents: number
  /** Portion of the totals that is NEW-rule prep time (src/lib/prepTime.ts).
   *  Always 0 for hosts and for pre-cutoff moderator work. */
  prepHours: number
  prepCents: number
  /** Portion of the totals that is non-livestream paid work — setup,
   *  training, office hours (src/lib/extraPay.ts, migration 057; extended to
   *  moderators in 073). Priced from the rate FROZEN on each slot, never a
   *  current default. */
  extraHours: number
  extraCents: number
  /** Portion of totalHours that has NOT been worked yet — the exposure you are
   *  carrying by paying in advance. Always 0 under the 'realized' basis. */
  unworkedHours: number
}

/** Normalized host-assigned stream (route flattens the Supabase join arrays). */
export interface HostStreamInput {
  host_id: string
  host: { name: string; rate_cents: number } | null
  /** Frozen pre-migration rate (migration 046); null = use host.rate_cents. */
  host_rate_cents: number | null
  start_time: string
  end_time: string
}

/** Normalized moderator-assigned stream. id + brand_id feed the
 *  first-of-day setup-bonus rule (src/lib/setupBonus.ts). */
export interface ModeratorStreamInput {
  id: string
  brand_id: string
  moderator_id: string
  moderator: { name: string; rate_cents: number } | null
  start_time: string
  end_time: string
}

interface Acc {
  name: string
  minutes: number
  cents: number
}

/** Normalized extra-pay slot (setup / training / office hours, migration 057).
 *  rate_cents is the FROZEN rate stored on the slot — never a live default.
 *
 *  A slot belongs to EXACTLY ONE worker: either a host or a moderator, never
 *  both and never neither (constraint extra_pay_one_worker, migration 073).
 *  The builders rely on that — buildHostRows skips rows without host_id and
 *  buildModeratorRows skips rows without moderator_id, so handing the same
 *  array to both cannot pay the same block twice. */
export interface ExtraPaySlotRow {
  id: string
  host_id: string | null
  host: { name: string } | null
  /** Set instead of host_id when the block belongs to a moderator (mig 073). */
  moderator_id?: string | null
  moderator?: { name: string } | null
  kind: ExtraPayKind
  rate_cents: number
  status: ExtraPayStatus
  start_time: string
  end_time: string
}

interface HostAcc extends Acc {
  extraMinutes: number
  extraCents: number
  unworkedMinutes: number
}

/** Aggregate host pay per host, counting only shifts whose end <= nowMs.
 *  Rate = frozen stream rate (completed pre-migration shifts) ?? the host's
 *  flat rate — same precedence as every other payout surface.
 *
 *  `extraSlots` folds in non-livestream paid work at each slot's own frozen
 *  rate. It is additive: a host with ONLY extra pay and no shifts still gets a
 *  row, otherwise that work would silently never be paid. */
export function buildHostRows(
  streams: HostStreamInput[],
  nowMs: number,
  extraSlots: ExtraPaySlotRow[] = [],
  basis: PayBasis = 'realized',
): PayrollRow[] {
  const byId = new Map<string, HostAcc>()
  const acc = (id: string, name: string): HostAcc => {
    const found = byId.get(id)
      ?? { name, minutes: 0, cents: 0, extraMinutes: 0, extraCents: 0, unworkedMinutes: 0 }
    // A later row may carry a name when an earlier one didn't.
    if (found.name === 'Unknown' && name !== 'Unknown') found.name = name
    byId.set(id, found)
    return found
  }

  for (const s of streams) {
    if (!s.host_id) continue
    const endMs = new Date(s.end_time).getTime()
    if (!payable(endMs, nowMs, basis)) continue
    const { totalCents, durationMinutes } = computeHostShiftPayoutCents(
      s.start_time, s.end_time, s.host_rate_cents, s.host?.rate_cents,
    )
    const prev = acc(s.host_id, s.host?.name ?? 'Unknown')
    prev.minutes += durationMinutes
    prev.cents += totalCents
    if (endMs > nowMs) prev.unworkedMinutes += durationMinutes
  }

  {
    // Folds whatever the caller passes — the EXTRA_PAY_ENABLED switch is
    // applied at the edges (export route / CSV), not here, so the math stays
    // independently testable.
    for (const e of extraSlots) {
      if (!e.host_id) continue
      if (e.status === 'canceled') continue
      // canceled is skipped above under BOTH bases -- extra pay has a real
      // cancel state and it keeps working. Only the "has it finished" test moves.
      if (!(basis === 'expected' || isExtraPayRealized(e.end_time, nowMs))) continue
      const minutes = extraPayDurationMinutes(e.start_time, e.end_time)
      if (minutes <= 0) continue
      const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
      const prev = acc(e.host_id, e.host?.name ?? 'Unknown')
      prev.minutes += minutes
      prev.cents += cents
      prev.extraMinutes += minutes
      prev.extraCents += cents
      if (!isExtraPayRealized(e.end_time, nowMs)) prev.unworkedMinutes += minutes
    }
  }

  return Array.from(byId.values()).map(a => ({
    name: a.name, role: 'Host', totalHours: a.minutes / 60, amountCents: a.cents,
    prepHours: 0, prepCents: 0,
    extraHours: a.extraMinutes / 60, extraCents: a.extraCents,
    unworkedHours: a.unworkedMinutes / 60,
  }))
}

interface ModAcc extends Acc {
  prepMinutes: number
  prepCents: number
  extraMinutes: number
  extraCents: number
  unworkedMinutes: number
}

const emptyModAcc = (name: string): ModAcc => ({
  name, minutes: 0, cents: 0, prepMinutes: 0, prepCents: 0,
  extraMinutes: 0, extraCents: 0, unworkedMinutes: 0,
})

/** Aggregate moderator pay per moderator (flat rate), completed shifts only.
 *  Old rule (pre-cutoff): the first moderator-assigned stream of each
 *  (brand, PT day) earns +30 min setup pay at the mod's own rate. New rule
 *  (post-cutoff): every contiguous moderator session earns one flat-rate
 *  prep block (src/lib/prepTime.ts), gated on the SESSION having ended.
 *  `window` marks the true reporting range when the caller padded its query
 *  with lookback rows for session detection — lookback rows contribute
 *  session context only, never pay. */
export function buildModeratorRows(
  streams: ModeratorStreamInput[],
  nowMs: number,
  window?: { fromISO: string; toExclusiveISO: string },
  extraSlots: ExtraPaySlotRow[] = [],
  basis: PayBasis = 'realized',
): PayrollRow[] {
  const bonusIds = findSetupBonusStreamIds(streams)
  const prepBlocks = computePrepBlocks(streams, window)
  // Compare parsed instants, never raw ISO strings: the DB returns
  // "…+00:00" while our bounds are ".000Z" — lexicographically unequal at
  // an identical instant, which would misclassify a shift landing exactly on
  // the window's first midnight. Date.getTime() normalizes both formats.
  const windowFromMs = window ? new Date(window.fromISO).getTime() : -Infinity
  // Upper bound too, because the caller's query is now padded on BOTH sides.
  //
  // Prep is attributed to the period a session ENDS in, but a session is only
  // ever assembled from the rows the caller fetched. With the query padded only
  // at the start, a session straddling a boundary was a DIFFERENT session in
  // each period -- July saw {A} ending in July, August saw {A,B} ending in
  // August -- and each copy passed its own period's end-gate, so its prep block
  // was paid TWICE. Padding both ends makes the session identical in both
  // periods, so exactly one of them contains its end. This upper gate is what
  // stops the extra rows that padding pulls in from being paid as live hours.
  const windowToMs = window ? new Date(window.toExclusiveISO).getTime() : Infinity
  const byId = new Map<string, ModAcc>()
  for (const s of streams) {
    if (!s.moderator_id || !s.moderator) continue
    // Lookback rows are identified by END time, matching the queries, which
    // now window on end_time so a shift is paid in the period it FINISHES in.
    // Keying this off start_time while the query filters end_time would
    // silently drop a shift that began before the window but ended inside it.
    const sEndMs = new Date(s.end_time).getTime()
    if (sEndMs < windowFromMs) continue  // pre-window padding: context only
    if (sEndMs >= windowToMs) continue   // post-window padding: context only
    const startMs = new Date(s.start_time).getTime()
    const endMs = new Date(s.end_time).getTime()
    // The realized gate. NOTE the two window gates above it are NOT this --
    // they strip the ±1 day query padding and must fire under BOTH bases, or a
    // session straddling a period boundary gets paid in both periods (the bug
    // fixed 2026-08-29).
    if (!payable(endMs, nowMs, basis)) continue
    const durationMinutes = (endMs - startMs) / 60_000
    let cents = Math.round((s.moderator.rate_cents * durationMinutes) / 60)
    let minutes = durationMinutes
    if (bonusIds.has(s.id) && setupBonusApplies(s.start_time)) {
      cents += setupBonusCents(s.moderator.rate_cents)
      minutes += 30 // paid setup time counts toward hours
    }
    const prev = byId.get(s.moderator_id) ?? emptyModAcc(s.moderator.name)
    prev.minutes += minutes
    prev.cents += cents
    if (endMs > nowMs) prev.unworkedMinutes += minutes
    byId.set(s.moderator_id, prev)
  }
  // New-rule prep: one block per completed session at the mod's own rate.
  const modById = new Map<string, { name: string; rateCents: number }>()
  for (const s of streams) {
    if (s.moderator_id && s.moderator) {
      modById.set(s.moderator_id, { name: s.moderator.name, rateCents: s.moderator.rate_cents })
    }
  }
  for (const b of prepBlocks) {
    const sessionEndMs = new Date(b.sessionEndISO).getTime()
    // Prep realizes on the SESSION's end, not a single row's -- a multi-row
    // session's anchor ends before the run does.
    if (!payable(sessionEndMs, nowMs, basis)) continue
    const info = modById.get(b.moderatorId)
    const cents = prepBlockCents(info?.rateCents ?? 0, b.durationMinutes)
    const prev = byId.get(b.moderatorId) ?? emptyModAcc(info?.name ?? 'Unknown')
    prev.minutes += b.durationMinutes
    prev.cents += cents
    prev.prepMinutes += b.durationMinutes
    prev.prepCents += cents
    if (sessionEndMs > nowMs) prev.unworkedMinutes += b.durationMinutes
    byId.set(b.moderatorId, prev)
  }
  // Non-livestream paid work for MODERATORS (migration 073). Mirrors the fold
  // in buildHostRows, including the completed-blocks-only gate, so an hour of
  // training is priced and realized identically whoever did it.
  //
  // NOT window-gated here, unlike the stream loop above. The stream query is
  // padded a day either side so a session straddling a boundary is assembled
  // whole, and those padding rows must not be paid — hence windowFromMs /
  // windowToMs. An extra-pay block has no such notion: it is a standalone
  // block, the caller queries it on the TRUE window, and gating it again here
  // against a padded range would be double-filtering. The route comment says
  // the same thing from the other side; keep the two in agreement.
  //
  // `if (!e.moderator_id) continue` is what makes it safe to hand the same
  // slot array to both builders: host slots have a null moderator_id and are
  // skipped here, moderator slots have a null host_id and are skipped there.
  // The database guarantees exactly one is set (extra_pay_one_worker).
  for (const e of extraSlots) {
    if (!e.moderator_id) continue
    if (e.status === 'canceled') continue
    if (!(basis === 'expected' || isExtraPayRealized(e.end_time, nowMs))) continue
    const minutes = extraPayDurationMinutes(e.start_time, e.end_time)
    if (minutes <= 0) continue
    const cents = extraPayCents(e.start_time, e.end_time, e.rate_cents)
    const prev = byId.get(e.moderator_id) ?? emptyModAcc(e.moderator?.name ?? 'Unknown')
    // A moderator with ONLY extra pay and no shifts still gets a row —
    // otherwise that work would silently never be paid.
    if (prev.name === 'Unknown' && e.moderator?.name) prev.name = e.moderator.name
    prev.minutes += minutes
    prev.cents += cents
    prev.extraMinutes += minutes
    prev.extraCents += cents
    if (!isExtraPayRealized(e.end_time, nowMs)) prev.unworkedMinutes += minutes
    byId.set(e.moderator_id, prev)
  }

  return Array.from(byId.values()).map(a => ({
    name: a.name, role: 'Moderator', totalHours: a.minutes / 60, amountCents: a.cents,
    prepHours: a.prepMinutes / 60, prepCents: a.prepCents,
    extraHours: a.extraMinutes / 60, extraCents: a.extraCents,
    unworkedHours: a.unworkedMinutes / 60,
  }))
}

/** Host rows first, then Moderator; alphabetical by name within each role. */
export function sortPayrollRows(rows: PayrollRow[]): PayrollRow[] {
  const rank = (r: PayrollRow) => (r.role === 'Host' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** RFC-4180-ish escaping PLUS spreadsheet formula-injection neutralization.
 *  A cell whose first non-space character is =, +, -, @, tab, or CR is treated
 *  as a live formula by Excel / Google Sheets — a self-registered user can set
 *  their name to `=WEBSERVICE(...)`/`=cmd|...` and have it execute when an admin
 *  opens the payroll or schedule CSV. Prefix such values with a single quote so
 *  they render as literal text, THEN apply the RFC-4180 quoting. */
export function csvEscape(field: string): string {
  let value = field
  if (/^\s*[=+\-@\t\r]/.test(value)) {
    value = `'${value}`
  }
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

// Prep Hours / Prep Pay break out the NEW-rule prep portion; Total Hours and
// Amount Owed stay the inclusive totals (live + old setup bonus + prep).
// The prep columns obey the kill switch: with PREP_TIME_ENABLED off the CSV
// reverts to the exact legacy 4-column format so downstream tooling keyed to
// the old shape keeps working.
// Columns are composed rather than frozen strings so each pay category can be
// switched on independently without rewriting the header for the others.
// "Amount Owed" stays LAST — downstream tooling reads it as the final column.
const CSV_HEAD_BASE = ['Name', 'Role', 'Total Hours']
const CSV_HEAD_PREP = ['Prep Hours', 'Prep Pay']
const CSV_HEAD_EXTRA = ['Extra Hours', 'Extra Pay']
// Only emitted for a SCHEDULED export, where it is the exposure being carried:
// hours already in Total Hours and Amount Owed that have not been worked yet.
// Off by default, so a completed-basis file keeps its exact existing shape.
const CSV_HEAD_UNWORKED = ['Unworked Hours']
const CSV_HEAD_TOTAL = ['Amount Owed']

/** Serialize rows to a CSV string (no trailing newline). Header always present.
 *  Prep and Extra columns break out portions ALREADY included in Total Hours /
 *  Amount Owed — they are subsets, never additions. Summing Prep Pay + Extra
 *  Pay + Amount Owed would double-count. */
export function rowsToCsv(
  rows: PayrollRow[],
  includePrep: boolean = PREP_TIME_ENABLED,
  includeExtra: boolean = EXTRA_PAY_ENABLED,
  includeUnworked = false,
): string {
  const header = [
    ...CSV_HEAD_BASE,
    ...(includePrep ? CSV_HEAD_PREP : []),
    ...(includeExtra ? CSV_HEAD_EXTRA : []),
    ...(includeUnworked ? CSV_HEAD_UNWORKED : []),
    ...CSV_HEAD_TOTAL,
  ].join(',')

  const lines = rows.map(r =>
    [
      csvEscape(r.name),
      r.role,
      r.totalHours.toFixed(2),
      // `?? 0` is deliberate defensiveness: a payroll export must never throw
      // on a row that predates a column being added.
      ...(includePrep ? [(r.prepHours ?? 0).toFixed(2), ((r.prepCents ?? 0) / 100).toFixed(2)] : []),
      ...(includeExtra ? [(r.extraHours ?? 0).toFixed(2), ((r.extraCents ?? 0) / 100).toFixed(2)] : []),
      ...(includeUnworked ? [(r.unworkedHours ?? 0).toFixed(2)] : []),
      (r.amountCents / 100).toFixed(2),
    ].join(','),
  )
  return [header, ...lines].join('\n')
}
