import { expect, it } from 'vitest'
import { filterPayTotals, payFilterOptions, type PayTotal } from './myShiftTotals'
const total = (key: string, name: string): PayTotal => ({ category_key: key, brand_id: key.startsWith('extra:') ? null : key, brand_name: name, earned_cents: 2500, completed_count: 1, upcoming_cents: 1000, upcoming_count: 1 })
it('retains historical-only brands and paid-work categories in all-time filters', () => {
  const totals = [total('old-brand', 'Old Brand'), total('extra:office_hours', 'Office Hours')]
  expect(payFilterOptions(totals, [])).toEqual([{ id: 'extra:office_hours', name: 'Office Hours' }, { id: 'old-brand', name: 'Old Brand' }])
  expect(filterPayTotals(totals, 'old-brand')[0].earned_cents).toBe(2500)
})
it('matches all extra-work categories by stable key regardless of display casing or brand linkage', () => {
  const totals = ['setup', 'training', 'office_hours'].map(kind => total(`extra:${kind}`, kind.toUpperCase()))
  totals.push(total('brand', 'Sample Brand'))
  for (const kind of ['setup', 'training', 'office_hours']) expect(filterPayTotals(totals, `extra:${kind}`)[0].upcoming_cents).toBe(1000)
  expect(filterPayTotals(totals, 'brand')).toHaveLength(1)
  expect(payFilterOptions(totals, [{ brandId: 'extra:office_hours', brandName: 'Office hours' }]).find(o => o.id === 'extra:office_hours')?.name).toBe('Office hours')
})
