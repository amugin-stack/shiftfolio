// Admin-dashboard "Fill %" basis: booked hours measured against the brand's
// contracted hours for the month. Pure + unit-tested so the math stays in one
// place (see fill.test.ts).

/**
 * @param bookedHours      hours scheduled for the brand this month
 * @param contractedHours  the brand's contracted hours/month (admin-only).
 *                         null/undefined/<=0 means "no target configured".
 * @returns a 0..N ratio (can exceed 1 when booked > contracted), or null when
 *          there is no contracted target — the dashboard renders null as "—".
 */
export function computeFillRate(
  bookedHours: number,
  contractedHours: number | null | undefined,
): number | null {
  if (contractedHours == null || contractedHours <= 0) return null
  return bookedHours / contractedHours
}
