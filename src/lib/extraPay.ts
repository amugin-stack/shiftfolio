// Pure pay math for non-livestream paid work: setup, training, office hours.
// No I/O. Mirrors src/lib/payout.ts so identical rounding runs on every surface
// (CLAUDE.md rule 18).
//
// THE RATE IS FROZEN ON THE ROW, NOT DERIVED HERE (Alex, 2026-08-25).
// extra_pay_slots.rate_cents is written once at creation (migration 057). The
// defaults below are a UI PREFILL ONLY — raising DEFAULT_RATE_CENTS.training
// from $20 to $25 must never re-price work already done, or last month's
// payroll stops matching what was actually paid. Nothing in this file may
// compute pay from a default; every function takes the stored rateCents.
//
// This is deliberately separate from the moderator prep/setup-bonus rules
// (prepTime.ts / setupBonus.ts). Those pay a MODERATOR their own rate for
// implied prep around a session; these are explicit, admin-scheduled blocks
// for a HOST at an arbitrary rate. No shared code path, no precedence question.
// Note kind 'setup' here is a HOST slot type and is unrelated to the moderator
// "setup bonus".

/**
 * Kill switch, matching PREP_TIME_ENABLED's role in prepTime.ts.
 *
 * OFF until the feature ships end-to-end (migration 057 applied + admin UI to
 * create slots). While off, the payroll CSV keeps its exact current shape —
 * turning it on early would add two always-zero columns and break downstream
 * tooling keyed to the existing column order for no benefit.
 *
 * The pure pay functions below deliberately do NOT consult this flag: they
 * compute what they are given, and the edges (export route, CSV) decide
 * whether to ask for slots at all. That keeps the math independently testable.
 */
export const EXTRA_PAY_ENABLED = true

export type ExtraPayKind = 'setup' | 'training' | 'office_hours'
export type ExtraPayStatus = 'scheduled' | 'completed' | 'canceled'

export const EXTRA_PAY_KINDS: ExtraPayKind[] = ['setup', 'training', 'office_hours']

/** Display names for UI + payroll. */
export const EXTRA_PAY_LABELS: Record<ExtraPayKind, string> = {
  setup: 'Setup',
  training: 'Training',
  office_hours: 'Office hours',
}

/**
 * Per-kind default hourly rate, in cents. **UI PREFILL ONLY.**
 * Changing a value here affects only slots created afterwards — existing rows
 * keep the rate stored on them. See the module header.
 */
export const DEFAULT_RATE_CENTS: Record<ExtraPayKind, number> = {
  setup: 2000,
  training: 2000,
  office_hours: 2000,
}

export interface ExtraPaySlotInput {
  id: string
  hostId: string
  kind: ExtraPayKind
  startISO: string
  endISO: string
  /** The FROZEN rate stored on the row. Never a default. */
  rateCents: number
  status: ExtraPayStatus
}

/** Duration in minutes. 0 for malformed or non-positive ranges. */
export function extraPayDurationMinutes(startISO: string, endISO: string): number {
  const startMs = new Date(startISO).getTime()
  const endMs = new Date(endISO).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0
  const minutes = (endMs - startMs) / 60_000
  return minutes > 0 ? minutes : 0
}

export function extraPayHours(startISO: string, endISO: string): number {
  return extraPayDurationMinutes(startISO, endISO) / 60
}

/**
 * Pay for one slot, in integer cents.
 * Math.round((rate * minutes) / 60) — identical to
 * computeHostShiftPayoutCents so a 90-minute block rounds the same way
 * whatever surface it is shown on.
 */
export function extraPayCents(startISO: string, endISO: string, rateCents: number): number {
  if (!Number.isFinite(rateCents) || rateCents <= 0) return 0
  return Math.round((rateCents * extraPayDurationMinutes(startISO, endISO)) / 60)
}

/** Pay for a slot row: zero when cancelled. */
export function extraPaySlotCents(slot: ExtraPaySlotInput): number {
  if (slot.status === 'canceled') return 0
  return extraPayCents(slot.startISO, slot.endISO, slot.rateCents)
}

/**
 * Realized = the block has finished. Same `end <= now` cutoff every other pay
 * surface uses (CLAUDE.md rule 21). `nowMs` must come from nowPtAsUtc().
 */
export function isExtraPayRealized(endISO: string, nowMs: number): boolean {
  const endMs = new Date(endISO).getTime()
  return Number.isFinite(endMs) && endMs <= nowMs
}

export interface ExtraPayTotals {
  hours: number
  cents: number
  /** Per-kind split, for the payroll breakdown. */
  byKind: Record<ExtraPayKind, { hours: number; cents: number }>
}

function emptyByKind(): Record<ExtraPayKind, { hours: number; cents: number }> {
  return {
    setup: { hours: 0, cents: 0 },
    training: { hours: 0, cents: 0 },
    office_hours: { hours: 0, cents: 0 },
  }
}

/**
 * Total realized extra pay for one host over a set of slots.
 * Counts only COMPLETED (end <= now), non-cancelled blocks, matching how
 * Realized works for shifts — so a scheduled-but-not-yet-worked training
 * session never appears in a paycheck.
 */
export function sumExtraPay(slots: ExtraPaySlotInput[], nowMs: number): ExtraPayTotals {
  const byKind = emptyByKind()
  let hours = 0
  let cents = 0

  for (const slot of slots) {
    if (slot.status === 'canceled') continue
    if (!isExtraPayRealized(slot.endISO, nowMs)) continue
    const h = extraPayHours(slot.startISO, slot.endISO)
    const c = extraPaySlotCents(slot)
    if (h <= 0) continue
    hours += h
    cents += c
    byKind[slot.kind].hours += h
    byKind[slot.kind].cents += c
  }

  return { hours, cents, byKind }
}
