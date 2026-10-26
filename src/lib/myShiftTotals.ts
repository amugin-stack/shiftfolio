export interface PayTotal {
  category_key: string
  brand_id: string | null
  brand_name: string
  earned_cents: number
  completed_count: number
  upcoming_cents: number
  upcoming_count: number
}

export function payFilterOptions(totals: PayTotal[], shifts: { brandId: string; brandName: string }[]) {
  const names = new Map(totals.map(total => [total.category_key, total.brand_name]))
  for (const shift of shifts) names.set(shift.brandId, shift.brandName)
  return Array.from(names, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

export function filterPayTotals(totals: PayTotal[], category: string) {
  return category === 'all' ? totals : totals.filter(total => total.category_key === category)
}
