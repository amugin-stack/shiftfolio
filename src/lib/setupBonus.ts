// First-moderator setup pay (spec: docs/superpowers/specs/2026-06-10-setup-bonus-design.md).
// Every (brand, PT day), the moderator on the earliest moderator-assigned
// stream comes in 30 minutes early to set up — pay them for it. Pure +
// unit-tested so every pay surface (My Shifts, payroll, CSV export,
// dashboards) applies the identical rule. Keep in sync with the SQL mirror
// in migration 048 (get_my_setup_bonus_stream_ids).

export interface SetupBonusStream {
  id: string
  brand_id: string
  moderator_id: string | null
  start_time: string
}

/** Stream ids that are their (brand, PT-day)'s earliest moderator-assigned
 *  stream. Day key = ISO date of start_time (PT-as-UTC storage convention).
 *  Tie (same brand, day, instant — shouldn't happen): lowest id. */
export function findSetupBonusStreamIds(streams: SetupBonusStream[]): Set<string> {
  const firstByBrandDay = new Map<string, SetupBonusStream>()
  for (const s of streams) {
    if (!s.moderator_id) continue
    const key = `${s.brand_id}|${s.start_time.slice(0, 10)}`
    const cur = firstByBrandDay.get(key)
    if (
      !cur
      || s.start_time < cur.start_time
      || (s.start_time === cur.start_time && s.id < cur.id)
    ) {
      firstByBrandDay.set(key, s)
    }
  }
  return new Set(Array.from(firstByBrandDay.values(), s => s.id))
}

/** 30 minutes of setup at the moderator's flat hourly rate. */
export function setupBonusCents(rateCents: number): number {
  return Math.round(rateCents / 2)
}
