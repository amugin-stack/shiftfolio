// Small shared helpers for the auto-scheduler admin UI. Kept out of the
// components so each file stays focused; nothing here does I/O.

import { formatPT } from '@/lib/utils'

/** "Thu 9/25 2:00pm-6:00pm" from PT-naive bounds. Display-only mirror of the
 *  DB's _sched_shift_label — never re-derive shift wording from a raw
 *  `new Date()` (CLAUDE.md rule 5); always go through formatPT. */
export function shiftLabelPT(start: string, end: string): string {
  return `${formatPT(start, 'EEE M/d')} ${formatPT(start, 'h:mmaaa')}-${formatPT(end, 'h:mmaaa')}`
}

/** Mask a phone number down to its last 4 digits for display, e.g.
 *  "+13105550101" -> "•••• 0101". Never render a full contact phone number
 *  on this admin page outside the one editable input for that contact. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `•••• ${digits.slice(-4)}`
}

export const OFFER_STATE_LABEL: Record<string, string> = {
  pending: 'Pending',
  yes: 'Yes',
  no: 'No',
  timeout: 'Timed out',
  stale: 'Stale',
  dry_run: 'Dry run',
}

export const REQUEST_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  escalated: 'Escalated',
  parked: 'Parked',
  filled: 'Filled',
  resolved: 'Resolved',
}
