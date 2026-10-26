// Pure helpers for the sidebar brand-calendar picker. No I/O — kept here so the
// path-parsing and filtering logic is unit-testable independently of the React
// component (BrandCalendarPicker.tsx), which is thin glue over these.

/** Brand id from a `/calendar/[id]` path (or `/calendar/[id]/...`, or with a
 *  query string / hash). Returns null for the `/calendar` landing route, any
 *  non-calendar route, or a missing pathname. */
export function activeBrandId(pathname: string | null | undefined): string | null {
  if (!pathname) return null
  const match = /^\/calendar\/([^/?#]+)/.exec(pathname)
  return match ? match[1] : null
}

/** Case-insensitive substring filter on brand name. An empty or whitespace-only
 *  query returns every brand unchanged. */
export function filterBrands<T extends { name: string }>(brands: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return brands
  return brands.filter(b => b.name.toLowerCase().includes(q))
}
