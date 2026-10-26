// ============================================================
// Per-shift host payout math, shared between My Shifts, the admin
// payroll pages, the payroll CSV export, and the admin Dashboard.
//
// Hosts have a flat hourly rate (hosts.rate_cents, migration 046) —
// exactly like moderators. A shift's effective host rate is the
// FROZEN per-stream rate when present (streams.host_rate_cents,
// stamped once for shifts completed before the rate-card removal so
// history never changes) and the host's live flat rate otherwise.
// ============================================================

/** Effective host $/hr for one shift: frozen stream rate ?? live flat rate. */
export function resolveHostShiftRateCents(
  streamHostRateCents: number | null | undefined,
  hostRateCents: number | null | undefined,
): number {
  return streamHostRateCents ?? hostRateCents ?? 0
}

/** Total host payout in cents = effective rate × duration (hours). */
export function computeHostShiftPayoutCents(
  startTime: Date | string,
  endTime: Date | string,
  streamHostRateCents: number | null | undefined,
  hostRateCents: number | null | undefined,
): { rateCents: number; totalCents: number; durationMinutes: number } {
  const startMs = (typeof startTime === 'string' ? new Date(startTime) : startTime).getTime()
  const endMs = (typeof endTime === 'string' ? new Date(endTime) : endTime).getTime()
  const rateCents = resolveHostShiftRateCents(streamHostRateCents, hostRateCents)
  const durationMinutes = (endMs - startMs) / 60_000
  const totalCents = Math.round((rateCents * durationMinutes) / 60)
  return { rateCents, totalCents, durationMinutes }
}
